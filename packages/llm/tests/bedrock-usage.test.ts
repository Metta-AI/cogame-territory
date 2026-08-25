// Token-usage capture + attribution. A fake `send` returns a Bedrock `usage`
// block (and records the command input), so we assert WITHOUT real AWS that
// `converse` surfaces per-turn usage, the process ledger accumulates across
// turns/instances, and `requestMetadata` is attached for invocation-log
// attribution.
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, it, expect } from "vitest";

import {
  BedrockLlmClient,
  bedrockRequestMetadataFromEnv,
  bedrockUsageTotals,
  resetBedrockUsage,
  type BedrockSend,
} from "../src/bedrock.js";

const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** A fake transport that always "works", returns a fixed usage block, and
 *  records each command's input so tests can assert what was sent. */
function fakeSend(inputs: ConverseCommand["input"][] = []): BedrockSend {
  return {
    async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
      inputs.push(cmd.input);
      return {
        output: { message: { role: "assistant", content: [{ text: "ok" }] } },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 7, cacheWriteInputTokens: 3 },
        $metadata: {},
      } as ConverseCommandOutput;
    },
  };
}

const ping = { system: "s", messages: [{ role: "user" as const, text: "u" }] };

afterEach(() => resetBedrockUsage());

describe("BedrockLlmClient usage capture", () => {
  it("surfaces per-turn usage on the result", async () => {
    const client = new BedrockLlmClient({ client: fakeSend(), model: HAIKU });
    const r = await client.converse(ping);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 });
  });

  it("accumulates a process-wide ledger across turns and clients", async () => {
    await new BedrockLlmClient({ client: fakeSend(), model: HAIKU }).converse(ping);
    await new BedrockLlmClient({ client: fakeSend(), model: HAIKU }).converse(ping);
    expect(bedrockUsageTotals()).toEqual({
      calls: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 14,
      cacheWriteTokens: 6,
    });
  });

  it("resets the ledger", async () => {
    await new BedrockLlmClient({ client: fakeSend(), model: HAIKU }).converse(ping);
    resetBedrockUsage();
    expect(bedrockUsageTotals()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("requestMetadata attribution", () => {
  it("attaches constructor-supplied metadata to every invocation", async () => {
    const inputs: ConverseCommand["input"][] = [];
    const meta = { coworld_id: "cow_abc", episode_id: "ereq_123", slot: "0" };
    const client = new BedrockLlmClient({ client: fakeSend(inputs), model: HAIKU, requestMetadata: meta });
    await client.converse(ping);
    expect(inputs[0]?.requestMetadata).toEqual(meta);
  });

  it("omits requestMetadata when none is configured", async () => {
    const inputs: ConverseCommand["input"][] = [];
    await new BedrockLlmClient({ client: fakeSend(inputs), model: HAIKU }).converse(ping);
    expect(inputs[0]?.requestMetadata).toBeUndefined();
  });

  it("reads metadata from BEDROCK_REQUEST_METADATA", () => {
    expect(bedrockRequestMetadataFromEnv({ BEDROCK_REQUEST_METADATA: '{"coworld_id":"cow_x","slot":0}' } as never)).toEqual({
      coworld_id: "cow_x",
      slot: "0",
    });
    expect(bedrockRequestMetadataFromEnv({} as never)).toBeUndefined();
  });
});
