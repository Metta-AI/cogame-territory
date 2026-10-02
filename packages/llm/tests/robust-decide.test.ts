// `robustDecide`'s failure ladder, which is what the "degrade, never hang" table
// promises: a rejected reply re-prompts once, a TRANSPORT failure re-prompts once,
// and either one, once the attempts are spent, plays the seat's baseline. Nothing
// throws out of `robustDecide` — a throw here propagates out of the player process
// (`src/game/player.ts`), which loses the seat for the rest of the episode instead
// of degrading it to its scripted move.
import { afterEach, describe, expect, it, vi } from "vitest";

import { robustDecide } from "../src/robust-decide";
import { OpenRouterLlmClient, type LlmResult } from "../src/openrouter";

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string): LlmResult => ({
  text,
  usage: zeroUsage,
  providerRequestId: null,
  platformCallId: null,
  generation: {
    model: "fixture",
    messages: [{ role: "user", content: "u" }],
    response: text,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    inferenceMode: "text_action",
  },
});

/** A client whose Nth `converse` call does whatever the Nth entry says. */
function fakeClient(script: Array<LlmResult | Error>): {
  client: OpenRouterLlmClient;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    complete: async (): Promise<LlmResult> => {
      const step = script[calls] ?? script[script.length - 1]!;
      calls += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  } as unknown as OpenRouterLlmClient;
  return { client, calls: () => calls };
}

const throttle = (): Error =>
  Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
afterEach(() => vi.unstubAllEnvs());

interface Move {
  move: string;
}

async function run(
  script: Array<LlmResult | Error>,
  maxAttempts = 2,
): Promise<{ decision: Move; attempts: Array<{ error: string | null }>; calls: number }> {
  const { client, calls } = fakeClient(script);
  const attempts: Array<{ error: string | null }> = [];
  const decision = await robustDecide<Move>({
    client,
    system: "s",
    renderUser: () => "u",
    validate: (candidate) => {
      const move = (candidate as { move?: unknown } | null)?.move;
      if (typeof move !== "string") throw new Error("no move in reply");
      return { move };
    },
    baseline: () => ({ move: "scripted" }),
    recordAttempt: (a) => attempts.push({ error: a.error }),
    maxAttempts,
    markFallback: () => {},
  });
  return { decision, attempts, calls: calls() };
}

describe("robustDecide on a transport failure", () => {
  it("RETRIES ONCE and uses the reply when the retry lands", async () => {
    const out = await run([throttle(), reply('{"move":"claim"}')]);
    expect(out.decision).toEqual({ move: "claim" });
    expect(out.calls).toBe(2);
    // Both the failure and the good attempt are in the transcript.
    expect(out.attempts.map((a) => a.error !== null)).toEqual([true, false]);
  });

  it("falls back to the SCRIPTED baseline when the retry fails too — it never throws", async () => {
    const out = await run([throttle(), throttle()]);
    expect(out.decision).toEqual({ move: "scripted" });
    expect(out.calls).toBe(2);
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts.every((a) => a.error !== null)).toBe(true);
  });

  it("plays the baseline IMMEDIATELY on a no-credentials error, with no retry storm", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const error = await new OpenRouterLlmClient()
      .complete({ system: "s", messages: [], recordGeneration: () => {} })
      .catch((error) => error);
    const out = await run([error, error]);
    expect(out.decision).toEqual({ move: "scripted" });
    expect(out.calls).toBe(1);
    expect(out.attempts).toHaveLength(1);
  });

  it("still retries once and falls back on an unparseable reply", async () => {
    const out = await run([reply("sorry, no JSON here"), reply("still nothing")]);
    expect(out.decision).toEqual({ move: "scripted" });
    expect(out.calls).toBe(2);
    expect(out.attempts).toHaveLength(2);
  });
});
