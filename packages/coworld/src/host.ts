// The coworld game-HOST: the `/player` websocket bridge every game runs on the
// Softmax platform. It is the generic half that all games shared by copy — now
// owned here, parameterized by the small game-specific surface (the module, how
// slots map to seats, the results, and the console to serve).
//
// Per slot, BOTH the game-side `RemotePlayerPilot` (`role=pilot`) and the
// external player policy (`role=player`) connect as clients to this bridge; it
// relays frames between them and synthesizes the `welcome` (on player connect)
// and `final` (at episode end) lifecycle frames the protocol defines. It also
// serves the runner-health-checked HTTP surfaces (`/healthz`, the React console)
// and a read-only `/global` spectator feed, captures that frame stream as the
// replay, and writes results + replay through artifact IO.
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync, gunzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { ZodType } from "zod";

import { GameRunner } from "@cogweb/core";
import type { GameModule, ObservedMessage, SeatPilot } from "@cogweb/core";
import { bedrockUsageTotals, MessageBus } from "@cogweb/llm";
import type { Audience, FeedEvent, ServerMessage } from "@cogweb/protocol";

import { RemotePlayerPilot } from "./remote-pilot";
import { readConfig, writeResults, writeReplay, hasReplayUri } from "./artifacts";
import { PROTOCOL, type TalkLine } from "./protocol";

const PLAYER_PATH = "/player";
const GLOBAL_PATH = "/global";
const REPLAY_PATH = "/replay";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The game's built console + the title shown on the dev stub page. */
export interface CoworldClient {
  /** Absolute path to the game's built console dir (its `dist/`). */
  distDir: string;
  /** Page `<title>` + the name shown on the server-only stub page. */
  title: string;
  /** Console entry served on `/client/player` (the agent view). Defaults to
   *  `index.html`; games with a separate agent bundle pass `index-agent.html`. */
  playerIndexFile?: string;
}

/**
 * Locate the built console (`dist/`) by walking up from `metaUrl`'s directory to
 * the first ancestor that contains `dist/index.html`, and return that `dist/`.
 * The platform image flattens the server bundle (`dist-server/game-cli.js` at the
 * root, `dist/` alongside it), so a fixed relative path overshoots to `/` and
 * every `/client/*` route falls back to the stub page — this finds the real
 * `dist/` whether the host runs from source or the bundled image. Pass
 * `import.meta.url` from the game's coworld host.
 */
export function findConsoleDir(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "dist", "index.html"))) return resolve(dir, "dist");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No build present (a server-only dev run); mountClient serves the stub.
  return resolve(dirname(fileURLToPath(metaUrl)), "dist");
}

/** Serve `/healthz` + the React console (built `dist/`), the surfaces the runner
 *  health-checks. Falls back to a stub page when the bundle isn't present (a
 *  server-only dev run); the platform image always ships `dist/`. */
function mountClient(app: express.Express, client: CoworldClient): void {
  const dist = client.distDir;
  const haveDist = existsSync(dist);
  if (haveDist) app.use(express.static(dist));
  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });
  // A game's client builds with a RELATIVE vite base ("./assets/…") so the same
  // bundle also serves under the cogweb hub's /<moduleId>/<instanceId>/ prefix. This
  // host serves the bundle at ITS root but the SPA at NESTED routes
  // (/client/{global,player,replay}), where "./assets" would resolve against the
  // route dir and 404 — so anchor relative URLs at the serving root with a <base>
  // tag. The base must be PATH-RELATIVE (`../`×depth), not `href="/"`: the hosted
  // Observatory proxies this host under a deep per-session prefix
  // (/v2/coworlds/replays/<cow>/sessions/<sid>/proxy/…), where an absolute "/"
  // escapes the proxy to the API origin root and every asset (and any
  // base-relative fetch) 404s — the "Loading replay…" hang.
  const indexFor = (file: string): string | null => {
    const p = resolve(dist, file);
    return haveDist && existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const shell = (file: string) => {
    const html = indexFor(file);
    return (req: express.Request, res: express.Response) => {
      if (html !== null) {
        // Ups to the serving root from the DOCUMENT's URL: relative resolution
        // drops the last path segment unless the URL ends in "/".
        const segments = req.path.split("/").filter(Boolean).length;
        const ups = req.path.endsWith("/") ? segments : Math.max(0, segments - 1);
        res.type("html").send(html.replace("<head>", `<head><base href="${"../".repeat(ups) || "./"}">`));
      } else
        res
          .status(200)
          .type("html")
          .send(
            `<!doctype html><meta charset=utf-8><title>${client.title}</title>` +
              `<p>${client.title} coworld game-host. Spectate the live feed or connect a player to <code>/player</code>.</p>`,
          );
    };
  };
  app.get(/^\/client\/player(\/.*)?$/, shell(client.playerIndexFile ?? "index.html"));
  app.get(/^\/client\/(global|replay)(\/.*)?$/, shell("index.html"));
  app.get(/^\/(global|replay)?$/, shell("index.html"));
}

/** One slot's two bridge ends: the game-side pilot socket and the player socket. */
interface SlotEnds {
  pilot?: WebSocket;
  player?: WebSocket;
}

/** Binds an external player slot to this host's `/player` bridge as a runner
 *  pilot. The game calls this for each slot it drives externally. */
export type MakeRemotePilot<State, Decision> = (slot: number) => RemotePlayerPilot<State, Decision>;

export interface CoworldHostOpts<State, Decision, Results> {
  module: GameModule<State, Decision>;
  /** One auth token per external player slot. */
  tokens: string[];
  /** Display name per seat (slot order), e.g. the platform-injected player/policy
   *  names from `config.players[].name`. The default `buildPilots` labels each seat
   *  with `playerNames[slot]`, which flows to the engine's player names (so replays
   *  and the live roster show real names instead of the engine defaults). Omit for
   *  anonymous seats. A game that supplies its own `buildPilots` sets names itself. */
  playerNames?: string[];
  /** The deterministic episode seed. Omit it (or pass undefined) to leave the
   *  runner's seed unpinned, so every episode deals a fresh random board. */
  seed?: number | string;
  /** Per-episode rule values handed to `Game.newGame` (there is no lobby here, so
   *  the host is where a coworld's board/variant knobs enter the engine). */
  rules?: Record<string, string>;
  host?: string;
  port?: number;
  /** Wait this long for every external player to connect before starting anyway;
   *  an unconnected slot then falls back to the baseline. */
  connectDeadlineMs: number;
  /** Per-reply timeout for each external player's `RemotePlayerPilot`. */
  actTimeoutMs?: number;
  /** Per-policy chess clock: a TOTAL thinking budget (ms) for the whole episode.
   *  Each external slot's pilot tells its policy the remaining budget on every
   *  observation and, once it is spent, plays the game's `randomDecision` (falling
   *  back to `baselineDecision`) for the seat instead of waiting on it. Omit for an
   *  unbounded budget. */
  chessClockMs?: number;
  /** Fischer-increment hook forwarded to each slot's pilot: ms credited to the
   *  seat's bank before each decision request (see RemotePlayerPilotOpts). */
  chessClockCreditFor?: (state: State, seat: number) => number;
  /** GameRunner pacing / live-advance knobs. `simultaneousPaceMs` is the floor on
   *  the spacing between batch STARTS for a simultaneous game (a turn costs
   *  max(batch, this)); `episodeDeadlineMs` is the wall-clock guard that settles
   *  the episode early via `Game.settleEarly` rather than overrunning. */
  runner?: {
    stepDelayMs?: number;
    autoAdvance?: { enabled: boolean; maxTimeMs: number };
    simultaneousPaceMs?: number;
    episodeDeadlineMs?: number;
  };
  /** Build the full seat→pilot map. `makeRemotePilot(slot)` binds external slot N
   *  to the bridge; the game maps slots to seats and adds any internal pilots.
   *  Default: slot i → seat i, every slot external. */
  buildPilots?: (makeRemotePilot: MakeRemotePilot<State, Decision>) => Map<number, SeatPilot<State, Decision>>;
  /** The non-secret config sent to a player in `welcome` (the game closes over
   *  seed / any extra fields). */
  welcomeConfig: (slots: number) => unknown;
  /** Per-slot scores (slot order) for the results artifact + the `final` frame.
   *  Default: the runner seat's score, i.e. `slot => score[slot]`. */
  scoresFor?: (score: Record<number, number>, slots: number) => number[];
  /** Validate + assemble the results artifact from the per-slot scores. */
  results: { schema: ZodType<Results>; build: (scores: number[], state: State) => Results };
  /** Extra top-level fields to write alongside `frames` in the replay envelope
   *  (`ReplayArtifact` is `.passthrough()`), so the saved replay is
   *  SELF-SUFFICIENT: the viewer needs nothing but the file. */
  replayMeta?: (state: State, results: Results) => Record<string, unknown>;
  client: CoworldClient;
}

export interface CoworldHostHandle<Results> {
  url: string;
  /** Per-slot `ws://…/player?slot=&token=` URLs an external player connects to. */
  playerUrls: string[];
  /** Resolves once the episode reaches the horizon and artifacts are written. */
  finished: Promise<Results>;
  close(): Promise<void>;
}

/**
 * Boot the host: start the `/player` bridge, wire the game's pilots into a
 * `GameRunner`, and (once players connect or the deadline passes) run the episode
 * to the horizon, writing results + replay. `finished` resolves with the results.
 */
export async function runCoworldHost<State, Decision, Results>(
  opts: CoworldHostOpts<State, Decision, Results>,
): Promise<CoworldHostHandle<Results>> {
  const host = opts.host ?? "0.0.0.0";
  // The platform injects one token per external slot; the slot count IS the token count.
  const tokens = opts.tokens;
  const slots = tokens.length;

  const app = express();
  mountClient(app, opts.client);
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const ends = new Map<number, SlotEnds>();
  const endsFor = (slot: number): SlotEnds => {
    let e = ends.get(slot);
    if (!e) {
      e = {};
      ends.set(slot, e);
    }
    return e;
  };

  // Resolves once every slot has an external player connected — the cue to start
  // driving. A slot that never connects falls back to the always-legal baseline
  // (its RemotePlayerPilot times out), so one absent player can't hang the host.
  const connectedPlayers = new Set<number>();
  let markAllConnected!: () => void;
  const allPlayersConnected = new Promise<void>((r) => (markAllConnected = r));

  // The runner is created below (after listen); the `/global` spectator handler
  // reads its current public snapshot on connect, so hold a forward reference.
  let runner: GameRunner<State, Decision> | null = null;
  // The one-shot roster frame (seat → player name), built once the runner exists.
  // Sent to every spectator on connect and led into the replay; see below.
  let rosterFrame: ServerMessage | null = null;
  const spectators = new Set<WebSocket>();

  // Cheap-talk substrate. A player posts lines on its reply; the host routes each by
  // visibility into this per-episode bus, hands a seat its slice on the next
  // observation (`inboxFor`), and emits PUBLIC lines into the spectator/replay feed
  // as `talk` events (DMs stay private to the bus). The engine never reads any of it.
  const bus = new MessageBus<ObservedMessage>();
  const inboxFor = (seat: number): ObservedMessage[] => bus.visibleTo(seat);
  // Assigned once the replay/spectator fan-out exists (below). A talk line can only
  // arrive after a player has acted, which is strictly after that wiring is in place.
  let emitFrame: (m: ServerMessage) => void = () => {};
  const onTalk = (seat: number, turn: number, lines: TalkLine[]): void => {
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;
      // Resolve the recipient: a real OTHER slot is a private aside, everything else
      // (self / out-of-range / absent) is a public broadcast. `visibleToSeat` folds
      // the sender into its own DM, so it always sees its own line.
      const to: Audience =
        line.to == null || line.to === seat || line.to < 0 || line.to >= slots ? "public" : [line.to];
      bus.post({ from: seat, to, text, turn });
      if (to === "public") emitFrame({ type: "event", event: { turn, seat, kind: "talk", text, to } satisfies FeedEvent });
    }
  };

  // Per slot the two ends meet here: a `role=pilot` socket is the game-side
  // RemotePlayerPilot (sends observation, reads reply); a `role=player` socket is
  // the external policy (reads observation, sends reply). Relay frames verbatim —
  // the bridge never reads the view, so it can't leak a redacted seat's secrets —
  // and synthesize the welcome/final the protocol's player runtime expects. A
  // `global` connection is a read-only spectator.
  wss.on("connection", (ws: WebSocket, slot: number, role: "pilot" | "player" | "global") => {
    if (role === "global") {
      spectators.add(ws);
      // Lead with the roster (seat → player name) so the console can label seats,
      // then the current public snapshot (non-empty even before the episode starts).
      if (rosterFrame) ws.send(JSON.stringify(rosterFrame));
      const snapshot: ServerMessage = { type: "snapshot", snapshot: runner!.snapshot(null) };
      ws.send(JSON.stringify(snapshot));
      ws.on("close", () => spectators.delete(ws));
      return;
    }
    const e = endsFor(slot);
    if (role === "pilot") {
      e.pilot = ws;
    } else {
      e.player = ws;
      ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, slot, config: opts.welcomeConfig(slots) }));
      connectedPlayers.add(slot);
      if (connectedPlayers.size === slots) markAllConnected();
    }
    ws.on("message", (raw: Buffer) => {
      const peer = role === "pilot" ? endsFor(slot).player : endsFor(slot).pilot;
      peer?.send(raw.toString());
    });
  });

  const authParams = (url: URL): { slot: number; role: "pilot" | "player" } | { error: string } => {
    const slot = Number(url.searchParams.get("slot"));
    const token = url.searchParams.get("token");
    const role = url.searchParams.get("role") === "pilot" ? "pilot" : "player";
    if (!Number.isInteger(slot) || slot < 0 || slot >= tokens.length) return { error: "bad slot" };
    if (token !== tokens[slot]) return { error: "bad token" };
    return { slot, role };
  };

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname === GLOBAL_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, -1, "global"));
      return;
    }
    if (url.pathname !== PLAYER_PATH) {
      socket.destroy();
      return;
    }
    const auth = authParams(url);
    if ("error" in auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, auth.slot, auth.role));
  };
  server.on("upgrade", onUpgrade);

  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const port = (server.address() as AddressInfo).port;
  const publicHost = host === "0.0.0.0" ? "localhost" : host;
  const base = `ws://${publicHost}:${port}${PLAYER_PATH}`;
  const playerUrls = tokens.map((token, slot) => `${base}?slot=${slot}&token=${token}`);

  // Each `makeRemotePilot(slot)` binds external slot N to this bridge (role=pilot)
  // and is tracked so `close()` can tear it down; internal pilots (e.g. an
  // in-process LlmPilot) the game adds in buildPilots are left to the runner.
  const remotePilots: RemotePlayerPilot<State, Decision>[] = [];
  const makeRemotePilot: MakeRemotePilot<State, Decision> = (slot) => {
    const pilot = new RemotePlayerPilot<State, Decision>({
      url: `${base}?role=pilot`,
      slot,
      token: tokens[slot]!,
      actTimeoutMs: opts.actTimeoutMs,
      inboxFor,
      onTalk,
      chessClockMs: opts.chessClockMs,
      chessClockCreditFor: opts.chessClockCreditFor as ((state: unknown, seat: number) => number) | undefined,
    });
    remotePilots.push(pilot);
    return pilot;
  };
  const defaultBuildPilots: NonNullable<typeof opts.buildPilots> = (mk) => {
    const pilots = new Map<number, SeatPilot<State, Decision>>();
    for (let slot = 0; slot < slots; slot++) {
      pilots.set(slot, { pilot: mk(slot), guidance: "", model: null, name: opts.playerNames?.[slot] ?? "" });
    }
    return pilots;
  };
  const pilots = (opts.buildPilots ?? defaultBuildPilots)(makeRemotePilot);

  runner = new GameRunner<State, Decision>(opts.module, pilots, {
    // Pass undefined through (NOT String(undefined) === "undefined") so an unpinned
    // seed lets the runner mint a fresh random board per episode.
    seed: opts.seed === undefined ? undefined : String(opts.seed),
    rules: opts.rules,
    stepDelayMs: opts.runner?.stepDelayMs,
    autoAdvance: opts.runner?.autoAdvance,
    simultaneousPaceMs: opts.runner?.simultaneousPaceMs,
    episodeDeadlineMs: opts.runner?.episodeDeadlineMs,
    // Coworld episodes must be deterministic + reproducible, so any free-form timed
    // phase (Game.openPhase, e.g. werecog's discussion window) collapses to an
    // instant here — its wall-clock would break replay/eval parity.
    openPhaseTimeoutMs: 0,
  });

  // Build the one-shot roster ("lobby") frame: seat → player name, taken from each
  // SeatPilot's `name` (the game's buildPilots sets it to the platform-injected
  // player/policy name). It rides a "running" phase so consoles that gate the lobby
  // view on `phase === "lobby"` keep showing the game; it only carries the roster so
  // the live console + replay viewer label seats by name instead of a fixed role label.
  rosterFrame = {
    type: "lobby",
    lobby: {
      gameId: opts.module.game.id,
      generation: runner.generation,
      phase: "running",
      seats: [...pilots.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seat, p]) => ({
          seat,
          name: p.name,
          kind: "bot" as const,
          ready: true,
          connected: true,
          bot: { model: p.model, guidance: p.guidance, autopilot: true },
          joinToken: "",
        })),
      autoAdvance: {
        enabled: opts.runner?.autoAdvance?.enabled ?? false,
        maxTimeMs: opts.runner?.autoAdvance?.maxTimeMs ?? 0,
      },
      // Coworld episodes carry no lobby, so there are no chosen rule knobs here —
      // a game's per-episode knobs ride its module factory (config), not rules.
      rules: {},
    },
  };

  // Capture the spectator frame stream as the replay timeline (the same
  // ServerMessages the live console consumes, so the React replay viewer renders
  // it with no special casing) AND fan it out to any `/global` spectator. Lead the
  // replay with the roster frame so a replay viewer has seat names before turn 0.
  const replayFrames: ServerMessage[] = [rosterFrame];
  const broadcast = (m: ServerMessage): void => {
    replayFrames.push(m);
    const frame = JSON.stringify(m);
    for (const ws of spectators) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  };
  runner.onMessage(broadcast);
  // Route public `talk` events (posted by `onTalk` as players speak) through the
  // same spectator/replay fan-out, so chat lands in the live feed AND the replay.
  emitFrame = broadcast;

  const scoresFor = opts.scoresFor ?? ((score, n) => Array.from({ length: n }, (_, seat) => score[seat] ?? 0));

  const finished = (async (): Promise<Results> => {
    // Wait for every external player to connect before driving; a straggler past
    // the deadline is left to the baseline fallback so it can't stall the host.
    await Promise.race([allPlayersConnected, sleep(opts.connectDeadlineMs)]);
    await runner!.start();

    const scoreBySeat = opts.module.game.score(runner!.state);
    const scores = scoresFor(scoreBySeat, slots);
    const results = opts.results.build(scores, runner!.state);

    // Resolve players FIRST — send `final` before writing the artifacts the hosted
    // worker waits on. Each player emits its bedrock_usage log line on `final`, and
    // the worker collects player logs + tears down pods as soon as results.json and
    // the replay exist; writing those first would race (and usually lose) that line.
    const finalFrame = JSON.stringify({ type: "final", scores });
    for (let slot = 0; slot < slots; slot++) endsFor(slot).player?.send(finalFrame);

    await writeResults(opts.results.schema, results);
    // Stamp the host's own Bedrock token usage (autopilot/LlmPilot seats this
    // process drove) onto the replay envelope — the one game-agnostic artifact —
    // so per-episode cost is readable without enabling account-level invocation
    // logging. Remote player policies tally their own usage in their player logs.
    if (hasReplayUri())
      await writeReplay({
        protocol: "cogweb.replay.v1",
        ...(opts.replayMeta?.(runner!.state, results) ?? {}),
        frames: replayFrames,
        usage: bedrockUsageTotals(),
      });

    return results;
  })();

  return {
    url: `http://${publicHost}:${port}`,
    playerUrls,
    finished,
    close: async () => {
      for (const p of remotePilots) p.close();
      server.removeListener("upgrade", onUpgrade);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((res, rej) => wss.close((err) => (err ? rej(err) : res())));
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

// ── replay mode ──────────────────────────────────────────────────────────────
// The platform restarts the SAME game image with COGAME_LOAD_REPLAY_URI (and no
// config) to verify the recorded episode is renderable: it health-checks
// `/healthz`, `GET /client/replay`, and expects a non-empty first frame on the
// `/replay` websocket. The saved replay is `{ protocol: "cogweb.replay.v1",
// frames: ServerMessage[] }`; the host streams those frames to every replay
// client on connect, the same frames the live `/global` feed emits.

/** Load recorded frames from a file://, bare-path, or http(s):// URI. The hosted
 *  store can hand the replay back zlib- or gzip-compressed (the runner writes
 *  `replay.json.z`), so sniff the magic bytes and inflate before parsing. */
export async function loadReplayFrames(uri: string): Promise<ServerMessage[]> {
  let buf: Buffer;
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`load replay ${uri} -> HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = readFileSync(uri.startsWith("file://") ? fileURLToPath(uri) : uri);
  }
  let text: string;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    text = gunzipSync(buf).toString("utf8"); // gzip
  } else if (buf.length >= 1 && buf[0] === 0x78) {
    text = inflateSync(buf).toString("utf8"); // zlib (what the runner writes)
  } else {
    text = buf.toString("utf8"); // raw JSON (a local replay file)
  }
  const data = JSON.parse(text) as { frames?: ServerMessage[] };
  if (!Array.isArray(data.frames)) throw new Error(`replay payload has no frames array: ${uri}`);
  return data.frames;
}

export interface ReplayServerHandle {
  url: string;
  close(): Promise<void>;
}

/** Serve a recorded episode: `/healthz`, the React replay console, and the
 *  recorded `ServerMessage` frames on the `/replay` (and `/global`) websocket. */
export async function runCoworldReplay(opts: {
  loadReplayUri: string;
  client: CoworldClient;
  host?: string;
  port?: number;
}): Promise<ReplayServerHandle> {
  const host = opts.host ?? "0.0.0.0";
  const frames = await loadReplayFrames(opts.loadReplayUri);

  const app = express();
  mountClient(app, opts.client);
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    for (const f of frames) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  });

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path !== REPLAY_PATH && path !== GLOBAL_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  };
  server.on("upgrade", onUpgrade);

  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const port = (server.address() as AddressInfo).port;
  const publicHost = host === "0.0.0.0" ? "localhost" : host;

  return {
    url: `http://${publicHost}:${port}`,
    close: async () => {
      server.removeListener("upgrade", onUpgrade);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((res, rej) => wss.close((err) => (err ? rej(err) : res())));
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

// ── game-host CLI entrypoint ───────────────────────────────────────────────────

export interface CoworldGameCliOpts<Config, Results> {
  /** App name, used as the log prefix (e.g. "cogsul"). */
  name: string;
  configSchema: ZodType<Config>;
  runGame: (opts: { config: Config; host: string; port: number }) => Promise<CoworldHostHandle<Results>>;
  runReplay: (opts: { loadReplayUri: string; host: string; port: number }) => Promise<ReplayServerHandle>;
  /** Keep `/healthz`, `/client/*` and `/global` answering for this long AFTER the
   *  episode finishes and the artifacts are written, then exit 0. The hosted
   *  worker health-checks the container while it collects player logs, and a host
   *  that exits the instant it writes results fails that check (lantern 0.1.3).
   *  Bounded on purpose: it is a linger, not a wait. */
  shutdownGraceMs?: number;
}

/**
 * The coworld game-host entrypoint the platform launches (manifest `gameRun`).
 * Reads the platform-injected env (`COGAME_HOST`/`COGAME_PORT`, and
 * `COGAME_LOAD_REPLAY_URI` for replay mode — the frozen platform contract),
 * dispatches replay-vs-episode, prints each slot's player URL so the platform can
 * wire the external player containers, and exits 0 once the episode finishes and
 * artifacts are written. Replay mode never "finishes" — the open server keeps the
 * process alive while the platform health-checks it and tears the container down.
 */
export async function runCoworldGameCli<Config, Results extends { scores: number[] }>(
  opts: CoworldGameCliOpts<Config, Results>,
): Promise<void> {
  const host = process.env.COGAME_HOST ?? "0.0.0.0";
  const port = Number(process.env.COGAME_PORT ?? "8080");

  const loadReplayUri = process.env.COGAME_LOAD_REPLAY_URI;
  if (loadReplayUri) {
    const handle = await opts.runReplay({ loadReplayUri, host, port });
    console.log(`[${opts.name}] coworld replay-host listening at ${handle.url}`);
    return;
  }

  const config = await readConfig(opts.configSchema);
  const handle = await opts.runGame({ config, host, port });
  console.log(`[${opts.name}] coworld game-host listening at ${handle.url}`);
  for (const [slot, url] of handle.playerUrls.entries()) {
    console.log(`[${opts.name}]   slot ${slot}: ${url}`);
  }

  const results = await handle.finished;
  console.log(`[${opts.name}] episode finished; scores=${JSON.stringify(results.scores)}`);
  const linger = opts.shutdownGraceMs ?? 0;
  if (linger > 0) {
    console.log(`[${opts.name}] lingering ${linger}ms so the worker can finish its checks`);
    await sleep(linger);
  }
  await handle.close();
  process.exit(0);
}
