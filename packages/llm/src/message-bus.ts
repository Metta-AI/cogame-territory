// The inter-player messaging bus: seats post public broadcasts + private DMs
// here, and each seat queries a redacted view. Cheap talk only — the engine never
// reads these; the autopilot surfaces them into observations.
//
// Visibility model (from Polis): a seat sees a message iff it is PUBLIC or the
// seat sent it or received it. `to: "public"` is visible to everyone; `to:
// number[]` is the explicit recipient list, and the sender always sees its own.
import type { Audience } from "@cogweb/protocol";

/** The minimal shape every message must have to be routed by visibility. */
export interface BusMessage {
  from: number;
  to: Audience;
  text: string;
  turn: number;
}

/** True when `seat` may see `msg`: public, or it sent / received it. */
export function visibleToSeat(seat: number, msg: BusMessage): boolean {
  if (msg.to === "public") return true;
  if (msg.from === seat) return true;
  return msg.to.includes(seat);
}

type Sub<Msg> = (msg: Msg) => void;

/**
 * An append-only message log with per-seat visibility. Parameterized on the
 * concrete message type so a game can carry extra fields (id, seq, kind) while
 * still routing on the `BusMessage` core.
 */
export class MessageBus<Msg extends BusMessage = BusMessage> {
  #log: Msg[] = [];
  #subs: Sub<Msg>[] = [];

  /** Append `msg`, then notify subscribers (the websocket fan-out). Returns it. */
  post(msg: Msg): Msg {
    this.#log.push(msg);
    for (const sub of this.#subs) sub(msg);
    return msg;
  }

  /** Messages `seat` may see (public + its own sent/received DMs), in order. */
  visibleTo(seat: number): Msg[] {
    return this.#log.filter((m) => visibleToSeat(seat, m));
  }

  /** Every message, in post order (the public/operator omniscient view). */
  all(): Msg[] {
    return [...this.#log];
  }

  /** Subscribe to posts; returns an unsubscribe handle. */
  onPost(cb: Sub<Msg>): () => void {
    this.#subs.push(cb);
    return () => {
      this.#subs = this.#subs.filter((s) => s !== cb);
    };
  }
}
