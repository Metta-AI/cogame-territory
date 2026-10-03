import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OpenRouterLlmClient, robustDecide } from "@cogweb/llm";
import type { GameModule } from "@cogweb/core";
import { runCoworldHost } from "../src/host.js";
import { runCoworldPlayer } from "../src/player-runtime.js";

afterEach(() => vi.unstubAllEnvs());

it("cancels the external native request and retains its evidence before deadline fallback capture", async () => {
  const module: GameModule<{ turn: number }, { move: string }> = {
    game: {
      id: "external-cancellation",
      minPlayers: 1,
      maxPlayers: 1,
      newGame: () => ({ turn: 0 }),
      turnOf: (state) => state.turn,
      pendingActors: (state) => (state.turn === 0 ? [0] : []),
      decisionSchema: () => z.object({ move: z.string() }),
      applyDecision: () => ({ state: { turn: 1 } }),
      isFinished: (state) => state.turn === 1,
      score: () => ({ 0: 0 }),
      redact: (state) => state,
      baselineDecision: () => ({ move: "baseline" }),
    },
  };
  let stopped = false;
  let calls = 0;
  const client = new OpenRouterLlmClient({
    model: "saved-model",
    baseUrl: "http://native.test",
    apiKey: "fixture",
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      calls++;
      await new Promise<void>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        ),
      );
      throw new Error("Aborted native request cannot continue");
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "external-cancellation-"));
  vi.stubEnv("COGAME_SAVE_TRAJECTORY_URI", join(dir, "trajectory.json"));
  vi.stubEnv("COGAME_RESULTS_URI", pathToFileURL(join(dir, "results.json")).href);
  const host = await runCoworldHost({
    module,
    tokens: ["owned-player"],
    host: "127.0.0.1",
    connectDeadlineMs: 1000,
    actTimeoutMs: 1000,
    runner: { autoAdvance: { enabled: true, maxTimeMs: 50 } },
    welcomeConfig: () => ({}),
    client: { distDir: join(dir, "absent"), title: "Cancel" },
    results: { schema: z.object({ scores: z.array(z.number()) }), build: (scores) => ({ scores }) },
  });
  try {
    await Promise.all([
      host.finished,
      runCoworldPlayer({
        module,
        connect: host.playerUrls[0],
        decide: (ctx) =>
          robustDecide({
            client,
            signal: ctx.signal,
            purpose: { kind: "learner" },
            slot: ctx.playerSlot,
            system: "rules",
            renderUser: () => "exact external private prompt",
            validate: (value) => z.object({ move: z.string() }).parse(value),
            baseline: () => ({ move: "baseline" }),
            recordAttempt: ctx.recordAttempt,
            markFallback: ctx.markFallback,
          }),
      }),
    ]);
    const records = JSON.parse(await readFile(join(dir, "trajectory.json"), "utf8")).decisions;
    expect(stopped).toBe(true);
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action_status: "fallback",
      executed_action: { move: "baseline" },
      attempts: [
        expect.objectContaining({
          model: "saved-model",
          platform_call_id: null,
          request: expect.objectContaining({
            messages: [
              { role: "system", content: "rules" },
              { role: "user", content: "exact external private prompt" },
            ],
          }),
        }),
      ],
    });
    expect(records[0]!.attempts[0]!.raw_response).toBeNull();
  } finally {
    await host.close();
  }
});
