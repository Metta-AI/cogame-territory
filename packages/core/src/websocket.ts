// The websocket hub: the one place lobby, runner, and connected clients meet.
// It fans every ServerMessage (lobby/game snapshots, events, status, actPrompt,
// reset) out to all sockets, and routes each inbound ClientMessage to the lobby
// or the live runner. On start() it materializes a GameRunner from the locked
// roster — humans get a shared HumanPilot, bot/autopilot seats get a Pilot from
// the injected `makeBotPilot` factory (so core never imports @cogweb/llm).

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parseClientMessage } from "@cogweb/protocol";
import type { ServerMessage, ClientMessage, BotSpec, Snapshot, RunStatus, FeedEvent, Audience } from "@cogweb/protocol";
import type { GameModule } from "./game";
import type { Pilot } from "./pilot";
import type { Lobby } from "./lobby";
import { GameRunner } from "./runner";
import type { SeatPilot } from "./runner";
import { HumanPilot } from "./human-pilot";

/** Build a Pilot for an autopiloted seat from its spec. Injected so core stays
 *  free of any LLM/remote dependency; @cogweb/llm and @cogweb/coworld supply it. */
export type MakeBotPilot<State, Decision> = (seat: number, spec: BotSpec) => Pilot<State, Decision>;

/** Per-connection state. `ownSeat` is the seat this socket claimed (null until it
 *  joins one), and it decides which redacted snapshot the socket receives. */
interface ConnState {
  ownSeat: number | null;
  /** A bot/open seat this connection took over live (running game). Tracked apart
   *  from a lobby-join `ownSeat` so a dropped socket auto-releases its live-taken
   *  seat back to a bot (keeping the game flowing) without converting a player's
   *  lobby seat. */
  liveSeat: number | null;
}

export interface WebSocketDeps<State, Decision> {
  lobby: Lobby;
  /** Constructs the live runner once the lobby starts. Re-invoked after reset. */
  makeBotPilot: MakeBotPilot<State, Decision>;
  /** Runner tuning forwarded on each start (pacing, seed). The auto-advance policy
   *  is NOT here — it lives on the lobby (effective config read at start), so it can
   *  be configured pre-game and toggled live. */
  runnerOptions?: {
    seed?: string;
    stepDelayMs?: number;
  };
  /** Server-side tap on every outbound frame, called before fan-out. Lets the
   *  app observe the live stream (e.g. feed a MessageBus from "talk" events that
   *  autopilots then read) without owning the runner. */
  onServerMessage?: (m: ServerMessage) => void;
}

export interface AttachedWebSocket {
  /** The live runner's redacted snapshot, or an empty one pre-game. Lets the
   *  HTTP /state.json route reflect the running game without owning the runner. */
  snapshot(seat?: number | null): Snapshot;
  /** The live runner's status, or a lobby-derived one pre-game. */
  status(): RunStatus;
  /** Connected clients watching without holding a seat (no lobby-joined `ownSeat`
   *  and not driving a live-taken seat) — the "spectators" count a lobby card shows. */
  spectators(): number;
  /** Total connected sockets to this instance (seated + spectating). Lets the hub
   *  reap a lobby-phase game once everyone has left it — an abandoned configure
   *  draft, which is never started and so never hits the finished-game reaper. */
  clientCount(): number;
  /** Post an async cheap-talk message FROM `seat` (outside the turn loop), the
   *  same path a `say` ClientMessage takes. Lets the app inject messages on a
   *  seat's behalf — e.g. an LLM seat talking between turns now that there is no
   *  discrete talk phase. `to` is "public" or a seat list (the sender is always
   *  folded in so it sees its own line). */
  say(seat: number, text: string, to: Audience): void;
  /** Apply a SERVER-SIDE decision on the live runner (see
   *  {@link GameRunner.applyServerDecision}) — the write path for a game hosted in
   *  an external engine, whose wiring feeds room bindings / results back into the
   *  table. Throws before the game starts. */
  applyServerDecision(seat: number, decision: unknown): void;
  /** Hand a raw HTTP upgrade to this hub's ws. The ws is created `noServer`, so the
   *  caller owns the http `upgrade` event and routes each one: the single-game
   *  server forwards every upgrade here; the multi-game hub forwards only the
   *  upgrades whose path matches this instance. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Close every client socket and the ws server (resource cleanup). */
  close(): void;
}

export function attachWebSocket<State, Decision>(
  deps: WebSocketDeps<State, Decision>,
): AttachedWebSocket {
  const { lobby } = deps;
  const module = lobby.module as GameModule<State, Decision>;
  // `noServer`: the caller (createGameServer or the multi-game hub) owns the http
  // `upgrade` event and routes each upgrade to the right instance via handleUpgrade.
  const wss = new WebSocketServer({ noServer: true });
  // Per-connection state. ownSeat is the seat this socket claimed (null = a
  // spectator), and it decides which redacted view the socket receives — the
  // basis for hidden-information games.
  const clients = new Map<WebSocket, ConnState>();

  // The human decision source is shared across the whole table: every human
  // seat's parked turn lives in this one registry, keyed by seat.
  const humanPilot = new HumanPilot<State, Decision>();

  let runner: GameRunner<State, Decision> | null = null;
  let runnerUnsub: (() => void) | null = null;

  const sendTo = (ws: WebSocket, m: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  const broadcastRaw = (m: ServerMessage): void => {
    const payload = JSON.stringify(m);
    for (const ws of clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };

  // Identical-for-everyone frames (lobby, status, reset, actPrompt).
  const broadcast = (m: ServerMessage): void => {
    deps.onServerMessage?.(m);
    broadcastRaw(m);
  };

  // Each connection gets the live snapshot redacted to ITS OWN seat. A
  // hidden-information game (e.g. a spymaster's key card) reaches only the seat
  // entitled to it — the public frame the runner emits is never sent verbatim.
  const sendSnapshotTo = (ws: WebSocket, conn: ConnState): void => {
    if (!runner) return;
    sendTo(ws, { type: "snapshot", snapshot: runner.snapshot(conn.ownSeat) });
  };

  // A targeted event (`to` = seat list) reaches only those seats; a public event
  // reaches everyone. Spectators (null seat) never see a targeted event.
  const eventVisibleTo = (event: FeedEvent, seat: number | null): boolean => {
    if (event.to === "public") return true;
    return seat !== null && event.to.includes(seat);
  };

  // Relay one runner frame with per-seat redaction: snapshots are recomputed per
  // connection (never the public frame), events are filtered by audience, and
  // everything else is identical for all.
  const relayRunnerFrame = (m: ServerMessage): void => {
    deps.onServerMessage?.(m);
    if (m.type === "snapshot") {
      for (const [ws, conn] of clients) sendSnapshotTo(ws, conn);
      return;
    }
    if (m.type === "event") {
      for (const [ws, conn] of clients) {
        if (eventVisibleTo(m.event, conn.ownSeat)) sendTo(ws, m);
      }
      return;
    }
    broadcastRaw(m);
  };

  // Async cheap-talk fan-out: a seated player (or the app, via say() below) posts
  // a chat message OUTSIDE the turn loop. Stamp it as a `talk` FeedEvent at the
  // current turn, tap it through onServerMessage (so an app MessageBus sees it like
  // any other talk event), and fan it out with the SAME per-seat audience redaction
  // the runner's events use — a DM reaches only its recipients, never a spectator.
  const emitSay = (seat: number, text: string, to: Audience): void => {
    const turn = runner ? runner.status().turn : 0;
    // A DM's audience always includes the sender so it sees its own line; a public
    // message is visible to everyone.
    const audience: Audience = to === "public" ? "public" : [...new Set([...to, seat])];
    const event: FeedEvent = { turn, seat, kind: "talk", text, to: audience };
    deps.onServerMessage?.({ type: "event", event });
    for (const [ws, conn] of clients) {
      if (eventVisibleTo(event, conn.ownSeat)) sendTo(ws, { type: "event", event });
    }
  };

  // Lobby changes fan out as "lobby" frames (same for every connection).
  const lobbyUnsub = lobby.subscribe((state) => broadcast({ type: "lobby", lobby: state }));

  /** Assemble the seat→pilot map from the locked roster and spin up the runner. */
  const buildRunner = (): GameRunner<State, Decision> => {
    const botSeats = lobby.botSeats();
    const roster = lobby.state().seats;
    const pilots = new Map<number, SeatPilot<State, Decision>>();
    for (const seat of roster) {
      if (seat.kind === "open") continue;
      const spec = botSeats.get(seat.seat);
      if (spec) {
        pilots.set(seat.seat, {
          pilot: deps.makeBotPilot(seat.seat, spec),
          guidance: spec.guidance,
          model: spec.model,
          name: seat.name,
        });
      } else {
        // A human seat with autopilot off: the shared HumanPilot drives it.
        pilots.set(seat.seat, { pilot: humanPilot, guidance: "", model: null, name: seat.name });
      }
    }
    const r = new GameRunner<State, Decision>(module, pilots, {
      ...deps.runnerOptions,
      // Stamp this run with the TABLE generation. The lobby bumps it on every reset
      // and the client tracks it; a fresh runner that restarted at 0 would have its
      // snapshots dropped as stale after the first reset (board stuck "waiting").
      generation: lobby.state().generation,
      // The lobby owns the auto-advance policy (default off once a human is seated,
      // plus the operator/flag-set max time); the runner gets that effective config
      // and then carries the live toggle from here.
      autoAdvance: lobby.autoAdvance(),
      // The lobby's chosen per-game rule values ride into every deal's newGame.
      rules: lobby.rules(),
      onFinished: () => lobby.finish(),
    });
    runnerUnsub = r.onMessage(relayRunnerFrame);
    return r;
  };

  const startRun = (): void => {
    lobby.start(); // throws LobbyError if the roster is short; caller reports it
    runner = buildRunner();
    void runner.start();
  };

  const resetRun = (): void => {
    runnerUnsub?.();
    runnerUnsub = null;
    humanPilot.cancelAll();
    if (runner) {
      runner.reset();
      runner = null;
    }
    lobby.reset();
  };

  /** Hand a seat back to an autopilot bot, live: unpark any awaiting human turn,
   *  flip the roster row to a bot, and swap the runner's pilot so the bot drives
   *  the seat's next turn. */
  const releaseToBot = (seat: number): void => {
    humanPilot.cancel(seat);
    const spec = lobby.botControlLive(seat, null);
    const name = lobby.state().seats.find((s) => s.seat === seat)?.name ?? "";
    runner?.setSeatPilot(seat, { pilot: deps.makeBotPilot(seat, spec), guidance: spec.guidance, model: spec.model, name });
  };

  /** Route a connection-agnostic frame. The seat-bound frames (join, setReady,
   *  decision) carry the connection's seat identity and are handled inline in the
   *  per-socket message listener; everything here targets an explicit seat or the
   *  whole table. */
  const handle = (
    msg: Exclude<ClientMessage, { type: "join" | "setReady" | "decision" | "say" | "takeControl" | "releaseControl" }>,
  ): void => {
    switch (msg.type) {
      case "addBot":
        lobby.addBot(msg.seat, msg.model);
        return;
      case "setGuidance":
        lobby.setGuidance(msg.seat, msg.guidance);
        return;
      case "setModel":
        lobby.setModel(msg.seat, msg.model);
        return;
      case "setAutopilot": {
        lobby.setAutopilot(msg.seat, msg.on);
        // Pre-game the roster change rides into the runner at start (buildRunner reads
        // the locked roster). Mid-game it must ALSO swap the live runner's pilot, or the
        // seat keeps being driven by the pilot it was built with: a human seat stays on
        // the shared HumanPilot, which only ever waits for a submit that never comes — so
        // autopilot never takes over (and a later "step in" never hands control back).
        if (runner) {
          const name = lobby.state().seats.find((s) => s.seat === msg.seat)?.name ?? "";
          if (msg.on) {
            const spec = lobby.botSeats().get(msg.seat)!; // setAutopilot(on) just put it here
            // Install the bot pilot FIRST, then release any parked human turn: the
            // runner sees the pilot already swapped when that turn's reject lands, so it
            // re-drives the in-flight turn with the bot instead of playing baseline.
            runner.setSeatPilot(msg.seat, {
              pilot: deps.makeBotPilot(msg.seat, spec),
              guidance: spec.guidance,
              model: spec.model,
              name,
            });
            humanPilot.cancel(msg.seat);
          } else {
            runner.setSeatPilot(msg.seat, { pilot: humanPilot, guidance: "", model: null, name });
          }
        }
        return;
      }
      case "setName":
        lobby.setName(msg.seat, msg.name);
        return;
      case "setRule":
        lobby.setRule(msg.key, msg.value);
        return;
      case "setAutoAdvance":
        // Mid-game the toggle arms/disarms the live runner; pre-game it pins the
        // lobby's default (and rides into the runner at start via lobby.autoAdvance()).
        if (runner) runner.setAutoAdvance(msg.on);
        else lobby.setAutoAdvance(msg.on);
        return;
      case "setMaxTime":
        lobby.setMaxTime(msg.ms);
        return;
      case "addSeat":
        lobby.addSeat();
        return;
      case "removeSeat":
        lobby.removeSeat(msg.seat);
        return;
      case "clearSeat":
        lobby.clearSeat(msg.seat);
        return;
      case "start":
        startRun();
        return;
      case "reset":
        resetRun();
        return;
      case "rematch":
        // Replay the same table in place: re-deal a fresh game on the live runner
        // (same seats, same connections) and re-drive the loop, WITHOUT resetting
        // the lobby — so players aren't bounced back to the portal. Offered post-
        // game, where the previous loop has already exited.
        if (runner) {
          runner.reset();
          void runner.start();
        }
        return;
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    const conn: ConnState = { ownSeat: null, liveSeat: null };
    clients.set(ws, conn);

    // Head-first sync: the new client gets the current lobby, and (if a game is
    // running) the per-turn snapshot history redacted to its seat — a spectator
    // until it claims one — plus the feed log and status. Backfilling the whole
    // snapshot history (not just the current snapshot) is what lets a viewer who
    // joins or reloads mid-game scrub the entire timeline, instead of only the
    // turns broadcast after it connected.
    sendTo(ws, { type: "lobby", lobby: lobby.state() });
    if (runner) {
      for (const snapshot of runner.snapshotHistory(conn.ownSeat)) sendTo(ws, { type: "snapshot", snapshot });
      // Replay this generation's feed so a late/reconnecting client sees the full
      // log (e.g. the one-shot start-of-game persona), not just frames from now on.
      // Audience-filtered to the (spectator) seat; runs synchronously at connect, so
      // it never interleaves with — or duplicates — a live broadcast frame.
      for (const event of runner.feedLog()) {
        if (eventVisibleTo(event, conn.ownSeat)) sendTo(ws, { type: "event", event });
      }
      sendTo(ws, { type: "status", status: runner.status() });
    }

    ws.on("message", (data) => {
      // A bad client frame — malformed JSON, an illegal/rejected move, or a
      // misrouted seat op (WsRoutingError) — is control flow, never a server
      // fault. It must never bubble out of this callback: an uncaught throw here
      // is a Node `uncaughtException` that exits the process and wipes the live
      // game for EVERY player. Catch it, log it, and keep the connection (and the
      // whole table) alive so the offending client can simply retry.
      try {
        const msg = parseClientMessage(JSON.parse(data.toString()));
        // Seat-bound frames carry the connection's identity (conn.ownSeat);
        // everything else routes through the shared handler.
        if (msg.type === "join") {
          const prevSeat = conn.ownSeat;
          const seat = lobby.join(msg.name, msg.seat ?? undefined, msg.token);
          conn.ownSeat = seat;
          // One seat per client: hand the seat this connection previously held back to
          // a bot, so grabbing a new one MOVES you (the table only ever holds humans
          // and bots — never an empty seat left behind). Lobby-only; mid-game a reclaim
          // arrives on a FRESH socket (prevSeat null), so this never runs there.
          if (prevSeat !== null && prevSeat !== seat && lobby.phase() === "lobby") lobby.addBot(prevSeat, null);
          // A sticky-session reclaim (reload/reconnect) lands on a NEW socket while
          // the player's OLD socket may still be registered for this seat. Drop the
          // old socket's claim so its eventual close() can't flip the seat back to
          // disconnected — the seat now belongs to this connection (order-independent
          // with the old socket's close).
          for (const [otherWs, other] of clients) {
            if (otherWs !== ws && other.ownSeat === seat) other.ownSeat = null;
          }
          // Re-send the live snapshot through the newly-claimed seat's eyes, so a
          // seat that just authenticated (e.g. a spymaster) gets its privileged
          // view immediately instead of the spectator view it had before.
          sendSnapshotTo(ws, conn);
          return;
        }
        if (msg.type === "setReady") {
          if (conn.ownSeat === null) throw new WsRoutingError("setReady before join");
          lobby.setReady(conn.ownSeat, msg.ready);
          return;
        }
        if (msg.type === "decision") {
          if (conn.ownSeat === null) throw new WsRoutingError("decision before join");
          humanPilot.submit(conn.ownSeat, msg.decision);
          return;
        }
        // Async cheap-talk: a seated player posts a message at any time (not a turn
        // decision), so it lands even when it is not this seat's turn.
        if (msg.type === "say") {
          if (conn.ownSeat === null) throw new WsRoutingError("say before join");
          emitSay(conn.ownSeat, msg.text, msg.to);
          return;
        }
        // Toggle READY during an open (timed) phase; the runner ends the window
        // early once every human-controlled seat is ready.
        if (msg.type === "ready") {
          if (conn.ownSeat === null) throw new WsRoutingError("ready before join");
          runner?.setReady(conn.ownSeat, msg.ready);
          return;
        }
        // Live seat takeover (running game only): claim a bot/open seat to drive it
        // by hand. A seat another human holds can never be taken.
        if (msg.type === "takeControl") {
          if (!runner) throw new WsRoutingError("takeControl before the game starts");
          const row = lobby.state().seats.find((s) => s.seat === msg.seat);
          if (!row) throw new WsRoutingError(`no seat ${msg.seat}`);
          if (row.kind === "human") throw new WsRoutingError(`seat ${msg.seat} is held by a human`);
          // Hand any seat this connection was already driving back to a bot first.
          if (conn.liveSeat !== null && conn.liveSeat !== msg.seat) releaseToBot(conn.liveSeat);
          lobby.takeControlLive(msg.seat, msg.name);
          conn.ownSeat = msg.seat;
          conn.liveSeat = msg.seat;
          runner.setSeatPilot(msg.seat, { pilot: humanPilot, guidance: "", model: null, name: msg.name });
          sendSnapshotTo(ws, conn); // re-send through the newly-controlled seat's eyes
          return;
        }
        if (msg.type === "releaseControl") {
          if (conn.liveSeat !== msg.seat) throw new WsRoutingError(`not controlling seat ${msg.seat}`);
          releaseToBot(msg.seat);
          conn.ownSeat = null;
          conn.liveSeat = null;
          sendSnapshotTo(ws, conn);
          return;
        }
        handle(msg);
      } catch (err) {
        console.warn(`[cogweb] dropped a bad client message: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      // A live-taken bot seat reverts to an autopilot so the game keeps flowing. In
      // the LOBBY, a human who leaves hands their seat back to a bot, so the table
      // only ever holds connected humans and bots — no ghost/disconnected seat to
      // puzzle over (a reload reclaims by simply taking that bot seat back). Mid-game
      // a lobby-joined seat just flips to disconnected so it can rejoin via its link.
      if (conn.liveSeat !== null && runner) releaseToBot(conn.liveSeat);
      else if (conn.ownSeat !== null && lobby.phase() === "lobby") lobby.addBot(conn.ownSeat, null);
      else if (conn.ownSeat !== null) lobby.setConnected(conn.ownSeat, false);
    });
  });

  return {
    snapshot(seat: number | null = null): Snapshot {
      return runner ? runner.snapshot(seat) : { turn: 0, generation: 0, state: null };
    },
    status(): RunStatus {
      if (runner) return runner.status();
      // Pre-game: no runner yet, so the per-seat indicator comes from the lobby
      // roster (SeatInfo) on the client via `seatStatusOf`; the run map is empty.
      // The auto-advance fields reflect the lobby's pre-game config (no live clock).
      const aa = lobby.autoAdvance();
      return {
        phase: lobby.phase(),
        turn: 0,
        live: false,
        thinking: [],
        seatStatus: {},
        scores: null,
        autoAdvance: aa.enabled,
        maxTimeMs: aa.maxTimeMs,
        deadline: null,
        ready: [],
      };
    },
    say(seat: number, text: string, to: Audience): void {
      emitSay(seat, text, to);
    },
    applyServerDecision(seat: number, decision: unknown): void {
      if (!runner) throw new Error("applyServerDecision before the game starts");
      runner.applyServerDecision(seat, decision);
    },
    spectators(): number {
      let n = 0;
      for (const conn of clients.values()) if (conn.ownSeat === null && conn.liveSeat === null) n++;
      return n;
    },
    clientCount(): number {
      return clients.size;
    },
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    close() {
      lobbyUnsub();
      runnerUnsub?.();
      humanPilot.cancelAll();
      for (const ws of clients.keys()) ws.close();
      wss.close();
    },
  };
}

/** A misrouted client frame (e.g. a seat-bound op before join). Reported to the
 *  offending client; never crashes the table. */
export class WsRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsRoutingError";
  }
}
