// Cheap-talk lines between Cogs: public broadcasts + private DMs. Talk is free,
// public or private, and binds nobody — it is the political side-channel the
// spectator console surfaces, and (unlike cogherence) it is engine STATE here so
// `(seed, variant, submissions)` reproduces the transcript too.

/** "public" (everyone) or one seat index (a DM). */
export type Audience = "public" | number;

export interface Message {
  seq: number;
  turn: number;
  from: number;
  to: Audience;
  text: string;
}

/** A seat sees a message iff it is public, it sent it, or it received it. */
export const messageVisibleTo = (m: Message, seat: number): boolean =>
  m.to === "public" || m.from === seat || m.to === seat;
