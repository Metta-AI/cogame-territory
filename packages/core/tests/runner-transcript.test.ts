// The RECORDED TRANSCRIPT is rune-safe (item 9).
//
// Every `actPrompt` attempt the runner collects is emitted as a replay frame, so
// every string on one is a string that reaches the replay: the prompt, the
// response (which carries the player's `note` and talk lines) and the captured
// error. A byte- or UTF-16-boundary truncation renders fine in a browser and fails
// a strict JSON parser, so the cap must land on CODE POINTS — and nothing may be
// recorded uncapped, because a player is free to send a 1 MB note.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GameRunner } from "../src/runner.js";
import type { SeatPilot } from "../src/runner.js";
import type { Game, GameModule } from "../src/game.js";
import type { ActPromptWire } from "@cogweb/protocol";

const EMOJI = "\u{1F9F1}"; // 🧱 — one code point, a UTF-16 surrogate PAIR

const runeLength = (s: string): number => Array.from(s).length;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

interface S {
  turn: number;
  done: boolean;
}
type D = { v: number };

const oneTurn: Game<S, D> = {
  id: "transcript-probe",
  minPlayers: 1,
  maxPlayers: 1,
  newGame: () => ({ turn: 1, done: false }),
  turnOf: (s) => s.turn,
  pendingActors: (s) => (s.done ? [] : [0]),
  decisionSchema: () => z.object({ v: z.number() }),
  applyDecision: () => ({ state: { turn: 2, done: true } }),
  isFinished: (s) => s.done,
  score: () => ({}),
  redact: (s) => s,
  baselineDecision: () => ({ v: 0 }),
};
const gameModule: GameModule<S, D> = { game: oneTurn };

/** Run one turn with a pilot that records one enormous attempt. */
async function recordOne(attempt: { prompt: string; response: string; error: string | null }): Promise<ActPromptWire> {
  const pilots = new Map<number, SeatPilot<S, D>>([
    [
      0,
      {
        pilot: {
          kind: "remote",
          decide: async (ctx) => {
            ctx.recordAttempt(attempt);
            return { v: 1 };
          },
        },
        guidance: "",
        model: null,
        name: "",
      },
    ],
  ]);
  const frames: ActPromptWire[] = [];
  const runner = new GameRunner(gameModule, pilots, { autoAdvance: { enabled: false, maxTimeMs: 0 } });
  runner.onMessage((m) => {
    if (m.type === "actPrompt") frames.push(m.actPrompt);
  });
  await runner.start();
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

describe("the recorded actPrompt transcript", () => {
  it("rune-caps the prompt, the response and the captured error", async () => {
    const wire = await recordOne({
      prompt: EMOJI.repeat(20_000),
      response: EMOJI.repeat(9_000),
      error: `${EMOJI.repeat(900)} rejected`,
    });
    const [attempt] = wire.attempts;
    expect(wire.attempts).toHaveLength(1);
    // The caps are on CODE POINTS, ellipsis inside the cap.
    expect(runeLength(attempt!.prompt)).toBe(16_000);
    expect(runeLength(attempt!.response)).toBe(4_000);
    expect(runeLength(attempt!.error!)).toBe(500);
    for (const s of [attempt!.prompt, attempt!.response, attempt!.error!]) {
      expect(s.endsWith("\u2026")).toBe(true);
      // No half of a surrogate pair survived the cut.
      expect(hasLoneSurrogate(s)).toBe(false);
    }
    // And the frame the replay writer serializes decodes under a FATAL decoder.
    const bytes = Buffer.from(JSON.stringify({ type: "actPrompt", actPrompt: wire }), "utf8");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(JSON.parse(decoded)).toEqual({ type: "actPrompt", actPrompt: wire });
  });

  it("leaves a normal-sized attempt untouched", async () => {
    const wire = await recordOne({ prompt: "the board", response: '{"v":1}', error: null });
    expect(wire.attempts[0]).toEqual({ prompt: "the board", response: '{"v":1}', error: null });
  });
});
