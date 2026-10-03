import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GameRunner, type GameModule, type DecisionTelemetryEvent } from "@cogweb/core";
import { OpenRouterLlmClient } from "../src/openrouter.js";
import { LlmPilot } from "../src/llm-pilot.js";

type State = { turn: number };
type Decision = { move: string };
const module: GameModule<State, Decision> = {
  game: {
    id: "cancellation",
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("joins a deadline-aborted native body and freezes its started request and received headers", async () => {
  vi.useFakeTimers();
  vi.stubEnv("COWORLD_LLM_ENDPOINT", "http://native.test");
  let stopped = false;
  const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
    const signal = options.signal!;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      }),
      {
        headers: {
          "X-Softmax-Llm-Call-Id": "a2ce1fb3-dc06-4733-8df4-cc271161e014",
          "x-request-id": "received-request",
        },
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const pilot = new LlmPilot<State, Decision>({
    purposeFor: () => ({ kind: "learner" }),
    client: new OpenRouterLlmClient({ model: "fixed-model", timeoutMs: 1000 }),
    autopilot: {
      systemPrompt: () => "rules",
      renderObservation: () => "exact private observation",
    },
    modelFor: () => "fixed-model",
    messagesFor: () => [],
  });
  const records: DecisionTelemetryEvent<unknown>[] = [];
  const runner = new GameRunner(
    module,
    new Map([
      [0, { pilot, purpose: "learner" as const, guidance: "", model: "fixed-model", name: "" }],
    ]),
    {
      autoAdvance: { enabled: true, maxTimeMs: 10 },
      onDecision: (event) => {
        expect(stopped).toBe(true);
        records.push(event);
      },
    },
  );
  const done = runner.start();
  await vi.advanceTimersByTimeAsync(10);
  await done;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    status: "fallback",
    decision: { move: "baseline" },
    attempts: [
      expect.objectContaining({
        platformCallId: "a2ce1fb3-dc06-4733-8df4-cc271161e014",
        providerRequestId: "received-request",
        generation: expect.objectContaining({
          request: expect.objectContaining({
            messages: [
              { role: "system", content: "rules" },
              { role: "user", content: "exact private observation" },
            ],
          }),
        }),
      }),
    ],
  });
  expect(records[0]!.attempts[0]!.error).toContain("Decision deadline expired");
  expect(records[0]!.attempts[0]!.generation!.rawResponse).toBeUndefined();
});

it("bounds a non-cooperative pilot and rejects late mutation of sealed evidence", async () => {
  vi.useFakeTimers();
  const generation = {
    model: "fixed",
    messages: [{ role: "user" as const, content: "private" }],
    response: "started",
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
  let lateWrite!: () => void;
  let settle!: (decision: Decision) => void;
  const records: import("@cogweb/core").DecisionTelemetryEvent<unknown>[] = [];
  const pilot: import("@cogweb/core").SeatPilot<State, Decision> = {
    purpose: "learner",
    guidance: "",
    model: "fixed",
    name: "",
    pilot: {
      kind: "llm",
      decide: (ctx) => {
        const attempt = {
          generationId: "local-started-attempt",
          prompt: "private",
          response: "started",
          error: null,
          generation,
        };
        ctx.recordAttempt(attempt);
        lateWrite = () => ctx.recordAttempt({ ...attempt, response: "late" });
        return new Promise<Decision>((resolve) => {
          settle = resolve;
        });
      },
    },
  };
  const runner = new GameRunner(module, new Map([[0, pilot]]), {
    autoAdvance: { enabled: true, maxTimeMs: 10 },
    onDecision: (record) => records.push(record),
  });
  try {
    const done = runner.start();
    await vi.advanceTimersByTimeAsync(20);
    await done;
    generation.response = "mutated transport object";
    expect(lateWrite).toThrow("Decision evidence is sealed");
    settle({ move: "late" });
    await Promise.resolve();
    expect(records).toMatchObject([
      {
        status: "fallback",
        decision: { move: "baseline" },
        attempts: [{ response: "started", generation: { response: "started" } }],
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});
