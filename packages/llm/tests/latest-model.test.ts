// Live model discovery: parsing Bedrock Claude ids, ordering candidates
// best-first (newest of the requested tier, then fallbacks), and the
// BedrockLlmClient resolving through an injected `lister` so a configured Opus id
// runs on the NEWEST available Opus instead of degrading. No real AWS.
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, it, expect } from "vitest";

import { BedrockLlmClient, type BedrockSend } from "../src/bedrock.js";
import { parseClaudeModel, orderCandidates } from "../src/latest-model.js";

const OPUS_48 = "us.anthropic.claude-opus-4-8";
const OPUS_47 = "us.anthropic.claude-opus-4-7";
const SONNET_46 = "us.anthropic.claude-sonnet-4-6";
const SONNET_45 = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const HAIKU_45 = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
// The invalid id daveey's policy shipped — parses to tier=opus but Bedrock 400s it.
const OPUS_BAD = "us.anthropic.claude-opus-4-8-20251101-v1:0";

const ping = { system: "s", messages: [{ role: "user" as const, text: "u" }] };

function fakeSend(working: Set<string>, calls: string[] = []): BedrockSend {
  return {
    async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
      const modelId = cmd.input.modelId ?? "";
      calls.push(modelId);
      if (!working.has(modelId)) {
        const e = new Error("The provided model identifier is invalid.");
        (e as { name: string }).name = "ValidationException";
        throw e;
      }
      return {
        output: { message: { role: "assistant", content: [{ text: `ok:${modelId}` }] } },
        $metadata: {},
      } as ConverseCommandOutput;
    },
  };
}

describe("parseClaudeModel", () => {
  it("parses modern and legacy naming, and the invalid-suffix opus id", () => {
    expect(parseClaudeModel(OPUS_48)).toMatchObject({ tier: "opus", major: 4, minor: 8, date: 0 });
    expect(parseClaudeModel(SONNET_45)).toMatchObject({ tier: "sonnet", major: 4, minor: 5, date: 20250929 });
    expect(parseClaudeModel("anthropic.claude-3-5-sonnet-20240620-v1:0")).toMatchObject({ tier: "sonnet", major: 3, minor: 5, date: 20240620 });
    // daveey's bad id still parses to its tier (so we can honor it).
    expect(parseClaudeModel(OPUS_BAD)).toMatchObject({ tier: "opus", major: 4, minor: 8 });
    expect(parseClaudeModel("amazon.titan-text")).toBeNull();
  });

  it("treats a major-only id's 8-digit date as the date, not the minor", () => {
    // `claude-sonnet-4-20250514` is Sonnet 4 (minor 0), NOT 4.20250514.
    expect(parseClaudeModel("us.anthropic.claude-sonnet-4-20250514-v1:0")).toMatchObject({
      tier: "sonnet",
      major: 4,
      minor: 0,
      date: 20250514,
    });
  });
});

describe("orderCandidates", () => {
  const pool = [HAIKU_45, OPUS_47, SONNET_45, OPUS_48, SONNET_46];

  it("puts the newest version of the preferred tier first", () => {
    expect(orderCandidates(pool, "opus")[0]).toBe(OPUS_48);
    expect(orderCandidates(pool, "sonnet")[0]).toBe(SONNET_46);
  });

  it("falls to the most-capable other tier (newest) when the preferred tier is absent", () => {
    expect(orderCandidates([SONNET_46, SONNET_45, HAIKU_45], "opus")[0]).toBe(SONNET_46);
  });

  it("with no preferred tier, picks the most capable, newest overall", () => {
    expect(orderCandidates(pool, null)[0]).toBe(OPUS_48);
  });

  it("dedupes the same version, preferring the us. inference profile over global.", () => {
    const out = orderCandidates(["global.anthropic.claude-opus-4-8", OPUS_48], "opus");
    expect(out).toEqual([OPUS_48]);
  });

  it("orders distinct dated snapshots of the same major.minor newest-date first", () => {
    const older = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const newer = "us.anthropic.claude-3-5-sonnet-20241022-v1:0";
    expect(orderCandidates([older, newer], "sonnet")).toEqual([newer, older]);
  });

  it("ranks a minor-versioned model above a major-only one of the same tier/major", () => {
    const majorOnly = "us.anthropic.claude-sonnet-4-20250514-v1:0"; // sonnet 4.0
    expect(orderCandidates([majorOnly, SONNET_45], "sonnet")[0]).toBe(SONNET_45); // 4.5 > 4.0
  });
});

describe("BedrockLlmClient live discovery", () => {
  it("runs a configured Opus id on the NEWEST available Opus", async () => {
    const calls: string[] = [];
    const client = new BedrockLlmClient({
      client: fakeSend(new Set([OPUS_47, OPUS_48, SONNET_46, HAIKU_45]), calls),
      model: OPUS_BAD, // invalid, but tier=opus
      lister: async () => [OPUS_47, SONNET_46, OPUS_48, HAIKU_45],
    });
    const r = await client.converse(ping);
    expect(r.text).toBe(`ok:${OPUS_48}`);
    expect(client.model).toBe(OPUS_48); // newest opus, not the bad configured id
    expect(calls[0]).toBe(OPUS_48); // went straight to it
    expect(calls).not.toContain(OPUS_BAD);
  });

  it("honors the tier and only drops to another when Opus is entirely unavailable", async () => {
    const client = new BedrockLlmClient({
      client: fakeSend(new Set([SONNET_46, SONNET_45, HAIKU_45])),
      model: OPUS_BAD, // wants opus, but the account grants none
      lister: async () => [SONNET_46, SONNET_45, HAIKU_45],
    });
    const r = await client.converse(ping);
    expect(client.model).toBe(SONNET_46); // newest of the next-best tier
    expect(r.text).toBe(`ok:${SONNET_46}`);
  });

  it("falls back to static candidates when discovery (ListInferenceProfiles) is denied", async () => {
    const calls: string[] = [];
    const client = new BedrockLlmClient({
      client: fakeSend(new Set([HAIKU_45]), calls),
      model: "configured-but-broken",
      lister: async () => {
        const e = new Error("not authorized to ListInferenceProfiles");
        (e as { name: string }).name = "AccessDeniedException";
        throw e;
      },
    });
    const r = await client.converse(ping);
    expect(r.text).toBe(`ok:${HAIKU_45}`); // resolved via static MODEL_CANDIDATES
    expect(calls).toContain(HAIKU_45);
  });
});
