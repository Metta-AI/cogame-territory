import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import type { GameModule } from "@cogweb/core";
const gameModule: GameModule<{ turn: number }, { move: string }> = {
  game: {
    id: "recipient",
    minPlayers: 2,
    maxPlayers: 2,
    newGame: () => ({ turn: 0 }),
    turnOf: (state) => state.turn,
    pendingActors: (state) => (state.turn < 2 ? [state.turn] : []),
    decisionSchema: () => z.object({ move: z.string() }),
    applyDecision: (state) => ({ state: { turn: state.turn + 1 } }),
    isFinished: (state) => state.turn === 2,
    score: () => ({ 0: 0, 1: 0 }),
    redact: (state) => state,
    baselineDecision: () => ({ move: "baseline" }),
  },
};
import { runCoworldHost } from "../src/host.js";
import { runCoworldPlayer } from "../src/player-runtime.js";

afterEach(() => vi.unstubAllEnvs());
it.each([0, 99, 1])(
  "keeps recipient %i private and records the registered game identity",
  async (recipient) => {
    const directory = await mkdtemp(join(tmpdir(), "coworld-recipient-"));
    vi.stubEnv("COWORLD_GAME_NAME", "registered-countdown-private");
    vi.stubEnv("COGAME_SAVE_TRAJECTORY_URI", join(directory, "trajectory.jsonl"));
    vi.stubEnv("COGAME_SAVE_REPLAY_URI", join(directory, "replay.json"));
    vi.stubEnv("COGAME_RESULTS_URI", join(directory, "results.json"));
    const host = await runCoworldHost({
      module: gameModule,
      seed: "recipient",
      tokens: ["a", "b"],
      host: "127.0.0.1",
      connectDeadlineMs: 1000,
      actTimeoutMs: 1000,
      welcomeConfig: () => ({}),
      results: {
        schema: z.object({ scores: z.array(z.number()) }),
        build: (scores) => ({ scores }),
      },
      client: { distDir: join(directory, "absent"), title: "Countdown" },
    });
    try {
      const players = host.playerUrls.map((connect, seat) =>
        runCoworldPlayer({
          module: gameModule,
          connect,
          decide: ({ view }) => gameModule.game.baselineDecision(view, seat),
          talk: (ctx) => {
            const messages = seat === 0 ? [{ to: recipient, text: "private intent" }] : [];
            ctx.recordAttempt({
              prompt: "private prompt",
              response: JSON.stringify({ messages }),
              error: null,
              parsedAction: messages,
              generation: {
                model: "scripted-unit-transport",
                inputTokens: null,
                outputTokens: null,
                latencyMs: null,
                messages: [{ role: "user" as const, content: "private prompt" }],
                response: JSON.stringify({ messages }),
              },
            });
            return messages;
          },
        }),
      );
      await Promise.all([host.finished, ...players]);
      const trajectory = JSON.parse(await readFile(join(directory, "trajectory.jsonl"), "utf8"));
      const replay = await readFile(join(directory, "replay.json"), "utf8");
      expect(trajectory.episode.game).toBe("registered-countdown-private");
      expect(
        trajectory.decisions.every(
          (decision: { game: string }) => decision.game === "registered-countdown-private",
        ),
      ).toBe(true);
      const speech = trajectory.decisions.find(
        (decision: { executed_action: { kind?: string }; seat: string }) =>
          Array.isArray(decision.executed_action) && decision.seat === "0",
      );
      expect(speech).toBeDefined();
      if (recipient === 1)
        expect(speech).toMatchObject({
          action_status: "accepted",
          executed_action: [{ to: 1, text: "private intent" }],
        });
      else
        expect(speech).toMatchObject({
          action_status: "fallback",
          selected_attempt_id: null,
          executed_action: [],
          attempts: [
            {
              accepted: false,
              rejection_reason: "Private recipient must be another external player slot",
            },
          ],
        });
      expect(replay).not.toContain("private intent");
      expect(replay).not.toContain("private prompt");
    } finally {
      await host.close();
    }
  },
);
