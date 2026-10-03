import { afterEach, expect, it, vi } from "vitest";
import { OpenRouterLlmClient } from "../src/openrouter.js";
import type { TextGeneration } from "@cogweb/protocol";
afterEach(() => vi.unstubAllEnvs());
it("keeps an explicit frozen environment policy independent of the learner checkpoint and decoder", async () => {
  vi.stubEnv("COWORLD_LLM_ENDPOINT", "http://native.test");
  vi.stubEnv("COWORLD_LLM_MODEL", "checkpoint/learner");
  vi.stubEnv("COWORLD_LLM_TEMPERATURE", "0");
  const calls: Array<{ request: unknown; headers: Headers }> = [];
  const generations: TextGeneration[] = [];
  const client = new OpenRouterLlmClient({
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init!.body));
      calls.push({ request, headers: new Headers(init!.headers) });
      return new Response(
        JSON.stringify({ model: request.model, choices: [{ message: { content: "{}" } }] }),
        {
          headers: {
            "X-Softmax-Llm-Call-Id":
              calls.length === 1
                ? "b4e6c678-31c0-4c29-9bc3-0a13070433db"
                : "57214416-6428-4473-a7f5-c7327e16bccf",
          },
        },
      );
    },
  });
  for (const purpose of [
    { kind: "learner" as const },
    {
      kind: "environment" as const,
      model: "frozen/persona",
      decoder: { temperature: 0.7, topP: 1, maxTokens: 96 },
    },
  ]) {
    let generation!: TextGeneration;
    await client.complete({
      purpose,
      signal: AbortSignal.timeout(1000),
      slot: 1,
      model: "untrusted/override",
      system: "rules",
      messages: [{ role: "user", text: "private" }],
      recordGeneration: (g) => {
        generation = structuredClone(g);
      },
    });
    generations.push(generation);
  }
  expect(calls[0]!.request).toMatchObject({ model: "checkpoint/learner", temperature: 0 });
  expect(calls[0]!.headers.get("X-Coworld-Player-Slot")).toBe("1");
  expect(calls[1]!.request).toMatchObject({
    model: "frozen/persona",
    temperature: 0.7,
    top_p: 1,
    max_tokens: 96,
  });
  expect(calls[1]!.headers.get("X-Coworld-Player-Slot")).toBeNull();
  expect(generations[1]!.inferenceMode).toBeUndefined();
  expect(generations[1]!.purpose).toMatchObject({ kind: "environment", model: "frozen/persona" });
  expect(generations[1]!.rawResponse).toEqual(expect.any(String));
});
