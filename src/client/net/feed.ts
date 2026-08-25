// Live/replay feed: apply @cogweb ServerMessage frames to a mutable store,
// notifying on each change. The store's snapshots feed the SAME renderers the
// live console uses, so a recording and a live game share one render path.
// Invalid inbound frames are DROPPED (validated at this boundary — the replay
// bytes are untrusted input to the browser).
import type { GameSnapshot } from "../../shared/snapshot";
import type { ClientTurnEvent, ServerMessage, ServerStatus } from "../../shared/protocol";
import type { Message } from "../../shared/messages";
import { setPolicyNames } from "../colors";

/** An actPrompt frame: what a seat's model saw and decided this turn. */
export type ActPromptFrame = Extract<ServerMessage, { type: "actPrompt" }>;

/** A board event tagged with the turn it resolved on, so views can show only the
 *  events that have happened up to the scrubber's current turn. */
export interface StampedEvent {
  turn: number;
  event: ClientTurnEvent;
}

export interface FeedStore {
  snapshots: GameSnapshot[];
  events: StampedEvent[];
  status: ServerStatus | null;
  actPrompts: Record<number, ActPromptFrame[]>;
  messages: Message[];
}

export const emptyStore = (): FeedStore => ({
  snapshots: [],
  events: [],
  status: null,
  actPrompts: {},
  messages: [],
});

/** Minimal socket surface (a fake is injected in tests). */
export interface LiveSocket {
  onMessage(fn: (data: string) => void): void;
  onClose?(fn: () => void): void;
  send(data: string): void;
  close(): void;
}

/** Apply one decoded ServerMessage to the store. */
export function applyFrame(store: FeedStore, m: ServerMessage): void {
  if (m.type === "snapshot") {
    const last = store.snapshots[store.snapshots.length - 1];
    if (last && m.snapshot.turn < last.turn) {
      store.snapshots = [];
      store.events = [];
      store.messages = [];
      store.actPrompts = {};
    }
    // ONE timeline entry per turn: a mid-turn snapshot REPLACES the turn's entry.
    const tail = store.snapshots[store.snapshots.length - 1];
    if (tail && tail.turn === m.snapshot.turn) store.snapshots[store.snapshots.length - 1] = m.snapshot;
    else store.snapshots.push(m.snapshot);
  } else if (m.type === "event") {
    store.events.push({ turn: m.turn, event: m.event });
    if (m.event.kind === "talk") {
      store.messages.push({
        seq: store.messages.length,
        turn: m.turn,
        from: m.event.seat,
        to: m.event.to === null ? "public" : m.event.to,
        text: m.event.text,
      });
    }
  } else if (m.type === "serverStatus") {
    store.status = m.status;
    // The REAL policy/player names arrive here, spectator-side only.
    if (m.status.roster) {
      const names: string[] = [];
      for (const r of m.status.roster) names[r.seat] = r.name;
      setPolicyNames(names);
    }
  } else if (m.type === "actPrompt") {
    const list = (store.actPrompts[m.seat] ??= []);
    list.push(m);
    if (list.length > 20) list.shift();
  }
}

/** Decode one inbound @cogweb wire frame into zero or more client messages. */
export type FeedDecoder = (raw: unknown) => ServerMessage[];

export interface LiveConnection {
  stop: () => void;
}

/** Connect (and KEEP connected) a live feed: when the socket dies, retry with
 *  capped backoff, wiping the store right before each reconnect so the server's
 *  backfill repopulates it cleanly. */
export function connectLiveFeed(
  store: FeedStore,
  makeSocket: () => LiveSocket,
  onChange: () => void,
  makeDecoder: () => FeedDecoder,
): LiveConnection {
  let stopped = false;
  let sock: LiveSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const open = (): void => {
    if (stopped) return;
    sock = makeSocket();
    const decode = makeDecoder();
    sock.onMessage((data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return; // drop unparseable inbound
      }
      attempt = 0;
      for (const msg of decode(raw)) applyFrame(store, msg);
      onChange();
    });
    sock.onClose?.(() => {
      if (stopped) return;
      const delay = Math.min(8000, 500 * 2 ** attempt++);
      timer = setTimeout(() => {
        const fresh = emptyStore();
        store.snapshots = fresh.snapshots;
        store.events = fresh.events;
        store.messages = fresh.messages;
        store.actPrompts = fresh.actPrompts;
        store.status = null;
        onChange();
        open();
      }, delay);
    });
  };
  open();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      sock?.close();
    },
  };
}
