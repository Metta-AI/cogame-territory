// Private attempts retain exact Unicode. Public replay contains applied game actions.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GameRunner } from "../src/runner.js";
import type { SeatPilot } from "../src/runner.js";
import type { Game, GameModule } from "../src/game.js";
import type { ActPromptWire } from "@cogweb/protocol";

const EMOJI = "\u{1F9F1}"; // 🧱 — one code point, a UTF-16 surrogate PAIR

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
async function recordOne(attempt: {
  prompt: string;
  response: string;
  error: string | null;
}): Promise<{ wire: ActPromptWire; privateAttempts: unknown }> {
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
  let privateAttempts: unknown;
  const runner = new GameRunner(gameModule, pilots, {
    autoAdvance: { enabled: false, maxTimeMs: 0 },
    onDecision: (event) => {
      privateAttempts = event.attempts;
    },
  });
  runner.onMessage((m) => {
    if (m.type === "actPrompt") frames.push(m.actPrompt);
  });
  await runner.start();
  expect(frames).toHaveLength(1);
  return { wire: frames[0]!, privateAttempts };
}

describe("private decision evidence and public replay", () => {
  it.each([null, `${EMOJI.repeat(900)} rejected`])(
    "keeps exact evidence private and exposes the applied action",
    async (error) => {
      const attempt = { prompt: EMOJI.repeat(20_000), response: EMOJI.repeat(9_000), error };
      const { wire, privateAttempts } = await recordOne(attempt);
      expect(privateAttempts).toEqual([attempt]);
      expect(wire.executedAction).toEqual({ v: 1 });
      expect(wire.attempts).toEqual([
        {
          prompt: "",
          response: "",
          error: error === null ? null : "Private player decision failed",
        },
      ]);
      const bytes = Buffer.from(JSON.stringify({ type: "actPrompt", actPrompt: wire }), "utf8");
      expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).toEqual({
        type: "actPrompt",
        actPrompt: wire,
      });
    },
  );
});
