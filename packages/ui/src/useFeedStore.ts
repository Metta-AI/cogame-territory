// useFeedStore — connect a ServerMessage stream and reduce it into one store
// that drives every shared panel (scrubber, feed, autopilot, roster). The SAME
// reducer serves a live socket and a replay: feed a recorded message log through
// `applyFrame` and you get an identical store. Frames are validated at the
// boundary with `parseServerMessage`; a `reset` (or a snapshot from a newer
// generation) drops the stale game's history so panels never mix two games.
import { useEffect, useRef, useState } from "react";
import {
  parseServerMessage,
  type ActPromptWire,
  type ClientMessage,
  type FeedEvent,
  type LobbyState,
  type RunStatus,
  type ServerMessage,
  type Snapshot,
} from "@cogweb/protocol";
import { loadReplayFrames } from "./replay";

/** The reduced view of the stream. `snapshots` is the immutable timeline. */
export interface FeedStore {
  snapshots: Snapshot[];
  events: FeedEvent[];
  status: RunStatus | null;
  /** Act-prompt transcripts keyed by seat, newest last (capped per seat). */
  actPrompts: Record<number, ActPromptWire[]>;
  lobby: LobbyState | null;
  /** The current game generation; bumps on every reset. */
  generation: number;
  /** The run can't be reached: the socket kept closing before delivering any
   *  frame, which means there's no live instance behind this URL — an unknown or
   *  reaped game (a finished match that's been garbage-collected, or a stale id).
   *  Set after a few empty closes, at which point the hook stops reconnecting; a
   *  consumer should render a terminal "this game has ended" state. */
  unavailable: boolean;
  /** A static replay failed to fetch, decompress, or validate. Consumers render
   *  this instead of leaving the viewer on an indefinite loading state. */
  error: string | null;
}

export function emptyFeedStore(): FeedStore {
  return {
    snapshots: [],
    events: [],
    status: null,
    actPrompts: {},
    lobby: null,
    generation: 0,
    unavailable: false,
    error: null,
  };
}

/** A live instance backfills a frame the instant a socket connects, so a healthy
 *  link never closes empty. This many consecutive frameless closes means the
 *  instance isn't there (unknown/reaped) — stop reconnecting and surface it. */
const GONE_AFTER_EMPTY_CLOSES = 3;

/** The minimal socket surface the hook drives. A WebSocket satisfies it; tests
 *  inject a fake. `send` carries client messages back to the server. */
export interface FeedSocket {
  onMessage(fn: (data: string) => void): void;
  onClose(fn: () => void): void;
  send(data: string): void;
  close(): void;
}

/** Reduce one frame into a NEW store (immutable: panels can compare by reference).
 *  A frame from an older generation is ignored; a newer generation resets first.
 *
 *  `snapshotKey` sets the timeline granularity: a new snapshot whose key EQUALS the
 *  tail's key REPLACES the tail instead of appending, so a mid-turn re-render doesn't
 *  duplicate a timeline row. Default (no `snapshotKey`) collapses one entry per turn.
 *  A game returns a finer key — e.g. `${turn}-${phase}` — to keep several snapshots
 *  within a turn (coguire's merger phases), or returns `null` to NEVER collapse, so
 *  EVERY snapshot is its own beat-frame: a replay can then scrub to and dwell on each
 *  beat within a turn (the roll, each production payout, each trade, each build) that
 *  would otherwise be overwritten by the turn's final snapshot and never seen. */
export function applyFrame(store: FeedStore, m: ServerMessage, snapshotKey?: (snap: Snapshot) => string | null): FeedStore {
  if (m.type === "reset") {
    if (m.generation <= store.generation && store.generation !== 0) return store;
    return { ...emptyFeedStore(), generation: m.generation };
  }

  if (m.type === "snapshot") {
    const g = m.snapshot.generation;
    if (g < store.generation) return store;
    const base = g > store.generation ? { ...emptyFeedStore(), generation: g } : store;
    const keyOf = snapshotKey ?? ((s: Snapshot) => String(s.turn));
    const key = keyOf(m.snapshot);
    const tail = base.snapshots[base.snapshots.length - 1];
    const tailKey = tail ? keyOf(tail) : null;
    // A null key never collapses — every snapshot appends as its own beat-frame.
    const snapshots =
      key !== null && tailKey === key
        ? [...base.snapshots.slice(0, -1), m.snapshot]
        : [...base.snapshots, m.snapshot];
    return { ...base, snapshots };
  }

  if (m.type === "event") return { ...store, events: [...store.events, m.event] };
  if (m.type === "status") return { ...store, status: m.status };
  if (m.type === "lobby") {
    // A "lobby"-phase frame means no live run (pre-game, or a Reset to a fresh
    // lobby): drop any prior game's status/timeline/transcripts so the new
    // lobby's open seats don't wear stale per-seat run badges. A "finished" frame
    // keeps the final run state so standings still show.
    if (m.lobby.phase === "lobby") {
      return { ...emptyFeedStore(), lobby: m.lobby, generation: m.lobby.generation };
    }
    return { ...store, lobby: m.lobby, generation: m.lobby.generation };
  }

  // actPrompt — append to the seat's transcript, capped to the last 20.
  const seat = m.actPrompt.seat;
  const prior = store.actPrompts[seat] ?? [];
  const next = [...prior, m.actPrompt].slice(-20);
  return { ...store, actPrompts: { ...store.actPrompts, [seat]: next } };
}

/** Wrap a browser WebSocket as a FeedSocket. */
function webSocketFactory(url: string): () => FeedSocket {
  return () => {
    const ws = new WebSocket(url);
    return {
      onMessage: (fn) => ws.addEventListener("message", (e) => fn(String(e.data))),
      onClose: (fn) => ws.addEventListener("close", () => fn()),
      send: (data) => ws.send(data),
      close: () => ws.close(),
    };
  };
}

interface FeedTimelineOptions {
  /** Timeline granularity. A snapshot whose key equals the tail's key replaces it
   *  (default: `String(turn)`, one entry per turn). Return `${turn}-${phase}` to keep
   *  several snapshots within a turn (coguire's merger phases), or `null` to never
   *  collapse — every snapshot becomes its own scrubbable beat-frame (replay mode). */
  snapshotKey?: (snap: Snapshot) => string | null;
}

export type UseFeedStoreOptions = FeedTimelineOptions &
  (
    | {
        /** Live mode: a WebSocket URL the hook connects (and reconnects) to. */
        socketUrl: string;
        connect?: never;
        replayUrl?: never;
      }
    | {
        /** Custom live/test connection factory. */
        connect: () => FeedSocket;
        socketUrl?: never;
        replayUrl?: never;
      }
    | {
        /** Static mode: an HTTP(S) replay artifact loaded entirely in-browser. */
        replayUrl: string;
        socketUrl?: never;
        connect?: never;
      }
  );

export interface FeedStoreHandle {
  store: FeedStore;
  send: (msg: ClientMessage) => void;
}

/** Connect a stream and keep a reduced store in React state. On socket death,
 *  reconnect with capped backoff and let the server backfill repopulate cleanly. */
export function useFeedStore(opts: UseFeedStoreOptions): FeedStoreHandle {
  const { socketUrl, connect, replayUrl, snapshotKey } = opts;
  const [store, setStore] = useState<FeedStore>(emptyFeedStore);
  const sockRef = useRef<FeedSocket | null>(null);
  // Read through a ref so an inline snapshotKey arrow (new identity every render)
  // neither goes stale nor forces the socket effect to reconnect.
  const snapshotKeyRef = useRef(snapshotKey);
  snapshotKeyRef.current = snapshotKey;

  useEffect(() => {
    if (replayUrl !== undefined) {
      const abort = new AbortController();
      setStore(emptyFeedStore());
      void loadReplayFrames(replayUrl, abort.signal).then(
        (frames) => {
          if (abort.signal.aborted) return;
          setStore(frames.reduce((prev, frame) => applyFrame(prev, frame, snapshotKeyRef.current), emptyFeedStore()));
        },
        (reason: unknown) => {
          if (abort.signal.aborted) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setStore({ ...emptyFeedStore(), error: `Replay failed to load: ${message}` });
        },
      );
      return () => abort.abort();
    }

    const factory = connect ?? (socketUrl ? webSocketFactory(socketUrl) : null);
    if (!factory) return;

    let stopped = false;
    let attempt = 0;
    let emptyCloses = 0; // consecutive closes that delivered no frame
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = (): void => {
      if (stopped) return;
      const sock = factory();
      sockRef.current = sock;
      let gotFrame = false; // did THIS connection deliver any frame?
      sock.onMessage((data) => {
        gotFrame = true;
        emptyCloses = 0;
        const parsed = parseServerMessage(JSON.parse(data));
        attempt = 0; // inbound traffic proves the link is healthy
        setStore((prev) => applyFrame(prev, parsed, snapshotKeyRef.current));
      });
      sock.onClose(() => {
        if (stopped) return;
        sockRef.current = null;
        // A socket that closes before delivering ANY frame means there's no live
        // instance behind this URL: the hub destroys the upgrade for an unknown or
        // reaped game (a finished match that's been GC'd, a stale id). A live
        // instance always backfills a frame on connect, so a healthy link never
        // lands here. After a few such empty closes, give up the reconnect loop and
        // surface a terminal "gone" state instead of spinning forever.
        if (!gotFrame && ++emptyCloses >= GONE_AFTER_EMPTY_CLOSES) {
          setStore((prev) => ({ ...emptyFeedStore(), generation: prev.generation + 1, unavailable: true }));
          return;
        }
        // Wipe before reconnecting so the server's backfill repopulates without
        // duplicating events; bump generation so any stale in-flight frame drops.
        setStore((prev) => ({ ...emptyFeedStore(), generation: prev.generation + 1 }));
        const delay = Math.min(8000, 500 * 2 ** attempt++);
        timer = setTimeout(open, delay);
      });
    };
    open();

    return () => {
      stopped = true;
      clearTimeout(timer);
      sockRef.current?.close();
      sockRef.current = null;
    };
    // snapshotKey is read through snapshotKeyRef, so it stays out of the deps: an
    // inline `(snap) => …` arrow gets a new identity every render and would otherwise
    // tear down and reconnect the socket on each one.
  }, [socketUrl, connect, replayUrl]);

  const send = (msg: ClientMessage): void => {
    sockRef.current?.send(JSON.stringify(msg));
  };

  return { store, send };
}
