import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActAttempt, TextGeneration } from "@cogweb/protocol";
import { OpenRouterLlmClient, llmUsageTotals, resetLlmUsage } from "../src/openrouter.js";
import { robustDecide } from "../src/robust-decide.js";

const callId = "01234567-89ab-4cde-8123-456789abcdef";
const response = {
  model: "checkpoint/test",
  choices: [{ message: { content: '{"take":2}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};
const ping = {
  system: "rules",
  messages: [{ role: "user" as const, text: "private observation" }],
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetLlmUsage();
});

describe("native direct text action", () => {
  it("uses the canonical sidecar model and preserves the exact text/body/call identity", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "http://sidecar");
    vi.stubEnv("COWORLD_LLM_MODEL", "checkpoint/test");
    vi.stubEnv("OPENROUTER_API_KEY", "must-not-leave-host");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), {
        headers: { "X-Softmax-Llm-Call-Id": callId, "X-Coworld-Checkpoint-Sha256": "weights-sha" },
      }),
    );
    let generation: TextGeneration | undefined;
    const result = await new OpenRouterLlmClient({ fetch }).complete({
      ...ping,
      slot: 8,
      recordGeneration: (g) => {
        generation = g;
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://sidecar/v1/chat/completions");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe("Bearer sidecar");
    expect(headers.get("X-Coworld-Player-Slot")).toBe("8");
    const request = JSON.parse(String(init!.body));
    expect(request).toEqual({
      model: "checkpoint/test",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "private observation" },
      ],
      temperature: 0,
      max_tokens: 1024,
    });
    expect(result.text).toBe('{"take":2}');
    expect(generation).toMatchObject({
      request,
      rawResponse: response,
      platformCallId: callId,
      modelIdentity: "weights-sha",
      inferenceMode: "text_action",
      response: result.text,
    });
    expect(llmUsageTotals()).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
  });

  it.each(["http", "malformed", "network"])(
    "keeps failed %s request evidence without inventing a call ID",
    async (kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (kind === "network") fetch.mockRejectedValue(new Error("network timeout"));
      else
        fetch.mockResolvedValue(
          new Response(kind === "http" ? "provider rejected" : "not JSON", {
            status: kind === "http" ? 429 : 200,
            headers: { "X-Softmax-Llm-Call-Id": callId },
          }),
        );
      const attempts: ActAttempt[] = [];
      const markFallback = vi.fn();
      const decision = await robustDecide({
        client: new OpenRouterLlmClient({ fetch, apiKey: "local-test-key" }),
        system: ping.system,
        renderUser: () => ping.messages[0]!.text,
        validate: () => ({ take: 2 }),
        baseline: () => ({ take: 0 }),
        recordAttempt: (a) => attempts.push(a),
        markFallback,
        maxAttempts: 1,
      });
      expect(decision).toEqual({ take: 0 });
      expect(markFallback).toHaveBeenCalledOnce();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.generation!.request).toMatchObject({
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "private observation" },
        ],
      });
      expect(attempts[0]!.platformCallId).toBe(kind === "network" ? null : callId);
      expect(attempts[0]!.generation!.rawResponse).toBe(
        kind === "network" ? undefined : kind === "http" ? "provider rejected" : "not JSON",
      );
      expect(attempts[0]!.generation!.latencyMs).toEqual(
        kind === "network" ? null : expect.any(Number),
      );
    },
  );

  it("records rejected text and exact re-rendered retry before selecting a valid parsed action", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...response, choices: [{ message: { content: '{"take":-1}' } }] }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(response)));
    const attempts: ActAttempt[] = [];
    const markFallback = vi.fn();
    const result = await robustDecide({
      client: new OpenRouterLlmClient({ fetch, apiKey: "fixture" }),
      system: "rules",
      renderUser: (reason) => (reason ? `view\n${reason}` : "view"),
      validate: (candidate) => {
        const parsed = candidate as { take: number };
        if (parsed.take < 0) throw new Error("illegal take");
        return parsed;
      },
      baseline: () => ({ take: 0 }),
      recordAttempt: (a) => attempts.push(a),
      markFallback,
      maxAttempts: 2,
    });
    expect(result).toEqual({ take: 2 });
    expect(attempts.map((a) => a.error)).toEqual(["illegal take", null]);
    expect(attempts[1]!.generation!.messages[1]!.content).toBe("view\nillegal take");
    expect(attempts[1]!.parsedAction).toEqual(result);
    expect(markFallback).not.toHaveBeenCalled();
  });
});
