// BedrockLlmClient model resolution WITHOUT live discovery (no `lister` ⇒ static
// MODEL_CANDIDATES fallback, tier-ordered): it invokes the best-first candidate
// that works and sticks to it, so an account-specific access gap can no longer
// silently degrade a pilot. (Live ListInferenceProfiles discovery is covered in
// latest-model.test.ts.) No real AWS: a fake `send` decides which model ids "work"
// by inspecting `command.input.modelId`.
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, it, expect } from "vitest";

import { BedrockLlmClient, MODEL_CANDIDATES, isModelUnavailable, type BedrockSend } from "../src/bedrock.js";

const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

function fakeSend(working: Set<string>, calls: string[] = []): BedrockSend {
  return {
    async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
      const modelId = cmd.input.modelId ?? "";
      calls.push(modelId);
      if (!working.has(modelId)) {
        const e = new Error("Model access is denied due to ... AWS Marketplace ...");
        (e as { name: string }).name = "AccessDeniedException";
        throw e;
      }
      return {
        output: { message: { role: "assistant", content: [{ text: `ok:${modelId}` }] } },
        $metadata: {},
      } as ConverseCommandOutput;
    },
  };
}

const ping = { system: "s", messages: [{ role: "user" as const, text: "u" }] };

describe("isModelUnavailable", () => {
  it("flags model-access errors, not throttles/timeouts", () => {
    expect(isModelUnavailable(Object.assign(new Error("x"), { name: "AccessDeniedException" }))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error("x"), { name: "ValidationException" }))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error("x"), { name: "ResourceNotFoundException" }))).toBe(true);
    expect(isModelUnavailable(new Error("The provided model identifier is invalid."))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error("rate"), { name: "ThrottlingException" }))).toBe(false);
    expect(isModelUnavailable(new Error("network timeout"))).toBe(false);
  });
});

describe("BedrockLlmClient self-healing model discovery", () => {
  it("resolves to the newest working candidate, never the bad configured id", async () => {
    const calls: string[] = [];
    const client = new BedrockLlmClient({ client: fakeSend(new Set([HAIKU]), calls), model: "bad-model" });
    const r = await client.converse(ping);
    expect(r.text).toBe(`ok:${HAIKU}`);
    expect(client.model).toBe(HAIKU); // switched permanently
    expect(calls).toContain(HAIKU);
    expect(calls).not.toContain("bad-model"); // a working candidate resolved before the invalid configured id
    expect(calls[0]).toContain("opus"); // tried the most-capable candidate first
  });

  it("does not re-probe once a working model is found", async () => {
    const calls: string[] = [];
    const client = new BedrockLlmClient({ client: fakeSend(new Set([HAIKU]), calls), model: "bad-model" });
    await client.converse(ping);
    const afterFirst = calls.length;
    await client.converse(ping); // second turn: should invoke HAIKU directly
    expect(calls.slice(afterFirst)).toEqual([HAIKU]);
  });

  it("uses the configured model directly when it works (no probing)", async () => {
    const calls: string[] = [];
    const client = new BedrockLlmClient({ client: fakeSend(new Set([HAIKU]), calls), model: HAIKU });
    await client.converse(ping);
    expect(calls).toEqual([HAIKU]);
  });

  it("re-raises the original error when no model is usable", async () => {
    const client = new BedrockLlmClient({ client: fakeSend(new Set()), model: "bad-model" });
    await expect(client.converse(ping)).rejects.toThrow(/Marketplace/);
  });

  it("collapses to one candidate after a total failure, so later turns probe once", async () => {
    // The offline/no-credentials path: with nothing usable, the first turn walks the
    // whole candidate list, but later turns must NOT re-walk it (that per-turn fan-out
    // timed out offline certification). They probe exactly once → fold into baseline.
    const calls: string[] = [];
    const client = new BedrockLlmClient({ client: fakeSend(new Set(), calls), model: "bad-model" });
    await expect(client.converse(ping)).rejects.toThrow();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(1); // first turn tried multiple candidates
    await expect(client.converse(ping)).rejects.toThrow();
    expect(calls.length - afterFirst).toBe(1); // every later turn: a single probe
  });

  it("MODEL_CANDIDATES spans tiers (opus + haiku) so something resolves everywhere", () => {
    expect(MODEL_CANDIDATES).toContain(HAIKU);
    expect(MODEL_CANDIDATES.some((m) => m.includes("opus"))).toBe(true);
  });
});
