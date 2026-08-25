// Translate @cogweb/protocol ServerMessages — the wire the coworld host speaks
// and the replay records — into the client's own frames, so one FeedStore drives
// every panel. Territory's game module already produces exactly the data the
// client wants: the public redacted view IS a GameSnapshot (it rides in
// `snapshot.state`) and every board event carries its typed event in
// `event.data`. So this is a thin re-envelope, not a reinterpretation — and each
// payload is validated at the boundary, because replay bytes are untrusted.
import { ServerMessage as CogwebMessage } from "@cogweb/protocol";
import type { LobbyState, RunStatus } from "@cogweb/protocol";
import { gameSnapshotSchema, turnEventSchema } from "../../shared/protocol";
import type { ServerMessage, ServerStatus } from "../../shared/protocol";
import type { GameSnapshot } from "../../shared/snapshot";

/** Lower a host RunStatus into the client's ServerStatus. `phase` comes from the
 *  latest snapshot (it is not on the wire status); the board renders from
 *  snapshots and this only drives the chrome. */
function toServerStatus(
  run: RunStatus,
  snap: GameSnapshot | null,
  roster: ServerStatus["roster"],
): ServerStatus {
  const finished = run.phase === "finished";
  const entries = Object.entries(run.seatStatus);
  return {
    turn: run.turn,
    phase: snap?.phase ?? "commit",
    finished,
    cogCount: entries.length || Object.keys(run.scores ?? {}).length,
    pending: entries.filter(([, s]) => s === "acting" || s === "thinking").map(([k]) => Number(k)),
    done: entries.filter(([, s]) => s === "waiting" || s === "ready").map(([k]) => Number(k)),
    ...(run.deadline != null ? { phaseDeadlineAt: run.deadline } : {}),
    ...(snap ? { turnLimit: snap.turns } : {}),
    started: run.phase !== "lobby",
    ended: finished,
    ...(roster ? { roster } : {}),
  };
}

const rosterOf = (lobby: LobbyState): NonNullable<ServerStatus["roster"]> =>
  lobby.seats.map((s) => ({ seat: s.seat, name: s.name }));

/**
 * Build a stateful decoder: @cogweb ServerMessage -> client ServerMessage[].
 * Stateful per CONNECTION (the latest snapshot for the status phase, the latest
 * roster) — make a fresh one per socket so a reconnect's backfill replays
 * cleanly. Unparseable / unmappable frames yield [].
 */
export function makeCogwebDecoder(): (raw: unknown) => ServerMessage[] {
  let snap: GameSnapshot | null = null;
  let roster: ServerStatus["roster"];

  return (raw: unknown): ServerMessage[] => {
    const parsed = CogwebMessage.safeParse(raw);
    if (!parsed.success) return [];
    const m = parsed.data;
    switch (m.type) {
      case "snapshot": {
        // The opaque `state` IS the public GameSnapshot — validate at the boundary.
        const s = gameSnapshotSchema.safeParse(m.snapshot.state);
        if (!s.success) return [];
        snap = s.data;
        return [{ type: "snapshot", snapshot: s.data }];
      }
      case "event": {
        const ev = turnEventSchema.safeParse(m.event.data);
        if (!ev.success) return [];
        return [{ type: "event", event: ev.data, turn: m.event.turn }];
      }
      case "status":
        return [{ type: "serverStatus", status: toServerStatus(m.status, snap, roster) }];
      case "lobby":
        roster = rosterOf(m.lobby);
        return [
          {
            type: "serverStatus",
            status: {
              turn: 0,
              phase: snap?.phase ?? "commit",
              finished: false,
              cogCount: m.lobby.seats.length,
              pending: [],
              done: [],
              started: m.lobby.phase !== "lobby",
              roster,
            },
          },
        ];
      case "actPrompt": {
        const a = m.actPrompt;
        const last = a.attempts[a.attempts.length - 1];
        const content = last ? `${last.prompt}\n\n→ ${last.response}${last.error ? `\n\n! ${last.error}` : ""}` : "";
        return [
          {
            type: "actPrompt",
            seat: a.seat,
            turn: a.turn,
            usedFallback: a.usedFallback,
            model: a.model,
            content,
          },
        ];
      }
      case "reset":
        return [];
    }
  };
}
