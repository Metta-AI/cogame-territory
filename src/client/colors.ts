// TWO NAME SPACES, kept strictly apart.
//
// IN-GAME (what the agents see): nine fixed anonymous aliases, index-ordered.
// They are the only names in any observation, any DM address and every `text` the
// engine renders. They come off the snapshot.
//
// SPECTATOR-SIDE (replay only): the REAL policy/player names ride the one-shot
// `lobby` roster frame the host emits, and the replay envelope's `players[]`.
// The scorebug shows `Cobalt · daveey-1`; the agents only ever saw `Cobalt`.
// Nothing in this module ever feeds a prompt.

import { ALIASES, SEAT_COLORS } from "../shared/engine/constants";

export const seatColor = (seat: number): string => SEAT_COLORS[seat % SEAT_COLORS.length]!;

/** The in-game alias for a seat. */
export const seatAlias = (seat: number): string => ALIASES[seat] ?? `Seat ${seat}`;

let policyNames: readonly string[] = [];

/** Hydrate the spectator-side policy names from the roster frame (seat-ordered). */
export const setPolicyNames = (names: readonly string[]): void => {
  policyNames = names;
};

/** The real policy/player name for a seat, or "" when the replay carries none. */
export const policyName = (seat: number): string => policyNames[seat] ?? "";

/** `Cobalt · daveey-1` when a policy name is known, else just the alias. */
export const seatLabel = (seat: number): string => {
  const policy = policyName(seat);
  return policy ? `${seatAlias(seat)} \u00b7 ${policy}` : seatAlias(seat);
};
