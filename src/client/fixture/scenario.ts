// A REAL played scenario, shared by the renderer fixture (test 14) and the client
// unit tests (test 15). It runs the actual engine — no hand-written frames — so a
// panel that renders here renders the bytes the game really writes.
//
// It deliberately includes the nastiest legible content the chrome will ever see:
// FULL-CAP (200-rune) talk lines mixing CJK and emoji on every seat, long policy
// names, razes, a smear, a strike and an elimination.

import { newGame, stepTurn } from "../../shared/engine/game";
import { MAX_SAY_LEN } from "../../shared/engine/constants";
import type { GameState } from "../../shared/engine/types";
import type { Submission } from "../../shared/engine/orders";
import { observe } from "../../game/redact";
import { homesteader, raider } from "../../game/scripted";
import { toSnapshot, type GameSnapshot } from "../../shared/snapshot";
import type { ClientTurnEvent } from "../../shared/protocol";
import type { Message } from "../../shared/messages";
import type { StampedEvent } from "../net/feed";

/** A talk line at exactly the cap: CJK + emoji, so a byte-boundary truncation or
 *  a fixed-width row would be caught immediately. */
export function fullCapLine(seat: number): string {
  const unit = "領土は永遠に貧しくなる🧱🔥";
  let s = `#${seat} `;
  while (Array.from(s).length < MAX_SAY_LEN) s += unit;
  return Array.from(s).slice(0, MAX_SAY_LEN).join("");
}

/** Long, ugly policy names — the ones that would collapse a fixed-width plate. */
export const FIXTURE_POLICY_NAMES = [
  "territory-steward",
  "territory-condottiere",
  "territory-homesteader",
  "territory-raider",
  "territory-steward-v3-long-name",
  "daveey-1",
  "territory-condottiere",
  "territory-homesteader",
  "territory-raider",
];

export interface Scenario {
  state: GameState;
  snapshot: GameSnapshot;
  events: StampedEvent[];
  messages: Message[];
}

/** Play `turns` turns of a real nine-seat game and flatten it for the panels. */
export function playScenario(seed = 7, turns = 7): Scenario {
  let state = newGame(seed, "open");
  for (let t = 0; t < turns; t++) {
    const submissions: Record<number, Submission> = {};
    for (const seat of state.cogOrder) {
      if (state.cogs[seat]!.life === "eliminated") continue;
      const view = observe(state, seat);
      const base = seat % 3 === 1 ? raider(view) : homesteader(view);
      const messages =
        state.turn === 1 || state.turn === 4
          ? [{ to: seat === 0 ? null : "Sable", text: fullCapLine(seat) }]
          : [];
      submissions[seat] = { ...base, messages };
    }
    state = stepTurn(state, submissions);
    if (state.settled !== null) break;
  }

  const events: StampedEvent[] = [];
  const messages: Message[] = [];
  for (const rec of state.log) {
    for (const ev of rec.events) {
      events.push({ turn: rec.turn, event: ev as ClientTurnEvent });
      if (ev.kind === "talk") {
        messages.push({
          seq: messages.length,
          turn: rec.turn,
          from: ev.seat,
          to: ev.to === null ? "public" : ev.to,
          text: ev.text,
        });
      }
    }
  }
  return { state, snapshot: toSnapshot(state), events, messages };
}
