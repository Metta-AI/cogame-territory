import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenRouterLlmClient,
  isCredentialsUnavailable,
  llmConfigFromEnv,
  llmUsageTotals,
  resetLlmUsage,
  type MessagesClient,
} from "../src/openrouter.js";
import type { Game } from "@cogweb/core";
import { LlmPilot } from "../src/llm-pilot.js";
import { robustDecide } from "../src/robust-decide.js";

const ping = { system: "system", messages: [{ role: "user" as const, text: "observation" }] };
const response = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "anthropic/claude-haiku-4.5",
  content: [
    { type: "text", text: "answer", citations: null },
    { type: "tool_use", id: "t", name: "move", input: { take: 2 } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  stop_details: null,
  container: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetLlmUsage();
});

describe("native OpenRouter messages", () => {
  it("sends native tools to the hosted endpoint without forwarding a real credential", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "http://127.0.0.1:9100");
    vi.stubEnv("OPENROUTER_API_KEY", "must-not-leave-host");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json", "request-id": "native-request-test" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("COWORLD_LLM_MODEL", "anthropic/claude-sonnet-4.6");
    const client = new OpenRouterLlmClient({ model: "retired-model" });
    const result = await client.complete({
      ...ping,
      slot: 2,
      tool: { name: "move", description: "Choose a move", inputSchema: { type: "object" } },
    });
    const call = fetch.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    expect(String(call[0])).toBe("http://127.0.0.1:9100/v1/messages");
    expect(new Headers(call[1].headers).get("authorization")).toBe("Bearer hosted-gateway");
    const body = JSON.parse(String(call[1].body));
    expect(body).toMatchObject({
      model: "anthropic/claude-sonnet-4.6",
      system: "system",
      messages: [{ role: "user", content: "observation" }],
      max_tokens: 1024,
      tool_choice: { type: "tool", name: "move" },
    });
    expect(body.trace).toBeUndefined();
    expect(new Headers(call[1].headers).get("X-Coworld-Player-Slot")).toBe("2");
    expect(new Headers(call[1].headers).has("X-OpenRouter-Metadata")).toBe(false);
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
    expect(result.toolInput).toEqual({ take: 2 });
    expect(result.text).toBe("answer");
    expect(result.providerRequestId).toBe("native-request-test");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
    await client.complete(ping);
    expect(llmUsageTotals()).toEqual({
      calls: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 14,
      cacheWriteTokens: 6,
    });
  });

  it("attributes a game-hosted pilot decision to the acting seat", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "http://sidecar");
    vi.stubEnv("COWORLD_LLM_MODEL", "anthropic/claude-sonnet-4.6");
    const create = vi.fn<MessagesClient["create"]>().mockResolvedValue(response as never);
    const pilot = new LlmPilot<null, number>({
      client: new OpenRouterLlmClient({ client: { create }, model: "retired-model" }),
      autopilot: {
        systemPrompt: () => "rules", renderObservation: () => "private view",
        tool: () => ({ name: "move", description: "move", inputSchema: { type: "object" } }),
      },
      modelFor: () => "", messagesFor: () => [],
    });
    const game = { baselineDecision: () => 0 } as unknown as Game<null, number>;
    const result = await pilot.decide({ game, state: null, seat: 1, guidance: [],
      validate: (candidate: unknown) => (candidate as { take: number }).take,
      recordAttempt: () => {},
    });
    expect(result).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].model).toBe("anthropic/claude-sonnet-4.6");
    expect(create.mock.calls[0]![1].headers?.["X-Coworld-Player-Slot"]).toBe("1");
  });

  it("uses direct OpenRouter bearer authentication for local play", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "");
    vi.stubEnv("OPENROUTER_API_KEY", "local-test-key");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new OpenRouterLlmClient();
    await client.complete(ping);
    await client.complete(ping);
    const call = fetch.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    expect(String(call[0])).toBe("https://openrouter.ai/api/v1/messages");
    expect(new Headers(call[1].headers).get("authorization")).toBe("Bearer local-test-key");
    expect(new Headers(call[1].headers).get("X-OpenRouter-Metadata")).toBe("enabled");
    const { trace } = JSON.parse(String(call[1].body));
    expect(trace).toEqual({
      trace_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      platform_call_id: trace.trace_id,
      generation_name: "anthropic_messages",
      schema_version: "1",
      source: "host",
      metadata_origin: "host_client",
      caller: "internal_tool",
    });
    const nextCall = fetch.mock.calls[1] as unknown as [string | URL | Request, RequestInit];
    const nextTrace = JSON.parse(String(nextCall[1].body)).trace;
    expect(nextTrace.platform_call_id).toBe(nextTrace.trace_id);
    expect(nextTrace.trace_id).not.toBe(trace.trace_id);
  });

  it("falls back immediately only when local configuration is absent", async () => {
    vi.stubEnv("COWORLD_LLM_ENDPOINT", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const client = new OpenRouterLlmClient();
    await expect(client.complete(ping)).rejects.toSatisfy(isCredentialsUnavailable);
    expect(
      await robustDecide({
        client,
        system: "s",
        renderUser: () => "u",
        validate: () => 2,
        baseline: () => 1,
        recordAttempt: () => {},
      }),
    ).toBe(1);
    expect(llmUsageTotals().calls).toBe(0);
  });

  it("surfaces transport failures without trying another model", async () => {
    const create = vi.fn<MessagesClient["create"]>().mockRejectedValue(new Error("rate limited"));
    await expect(new OpenRouterLlmClient({ client: { create } }).complete(ping)).rejects.toThrow(
      "rate limited",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request at the configured timeout", async () => {
    const client: MessagesClient = {
      create: (_input, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    await expect(new OpenRouterLlmClient({ client, timeoutMs: 5 }).complete(ping)).rejects.toThrow(
      "aborted",
    );
  });

  it("resolves prefixed native model and timeout settings", () => {
    expect(
      llmConfigFromEnv({
        prefix: "GAME",
        env: { GAME_LLM_MODEL: "anthropic/claude-sonnet-4.5", GAME_LLM_TIMEOUT_MS: "5000" },
      }),
    ).toEqual({ model: "anthropic/claude-sonnet-4.5", timeoutMs: 5000 });
  });
});
