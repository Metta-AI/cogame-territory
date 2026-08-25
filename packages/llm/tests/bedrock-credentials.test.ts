// The OFFLINE / no-AWS-credentials path — the one `coworld certify` runs in a
// container with no creds. The AWS SDK credential chain stalls on the absent EC2
// IMDS endpoint before failing, so re-resolving it on EVERY turn pushes a full
// game past the 60s default cert timeout. The client must observe "no credentials"
// once, cache it, and short-circuit every later turn (no IMDS re-probe), so the
// pilot falls through to its always-legal baseline fast.
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Autopilot, DecideContext, Game } from "@cogweb/core";
import { describe, it, expect } from "vitest";

import { BedrockLlmClient, type BedrockSend } from "../src/bedrock.js";
import { LlmPilot } from "../src/llm-pilot.js";

const SONNET = "us.anthropic.claude-sonnet-4-6";
const ping = { system: "s", messages: [{ role: "user" as const, text: "u" }] };

/** A transport that simulates the no-credentials stall: it counts every send and,
 *  after an optional delay (standing in for the IMDS timeout), throws the AWS SDK's
 *  `CredentialsProviderError`. */
function noCredsSend(calls: { n: number }, delayMs = 0): BedrockSend {
  return {
    async send(): Promise<ConverseCommandOutput> {
      calls.n++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const e = new Error("Could not load credentials from any providers (please configure ...)");
      (e as { name: string }).name = "CredentialsProviderError";
      throw e;
    },
  };
}

type Decision = { move: string };
const BASELINE: Decision = { move: "baseline" };

const autopilot: Autopilot<null, Decision> = {
  systemPrompt: () => "sys",
  renderObservation: () => "obs",
};

function offlineContext(): DecideContext<null, Decision> {
  return {
    game: { baselineDecision: () => BASELINE } as unknown as Game<null, Decision>,
    state: null,
    seat: 0,
    guidance: "",
    validate: (c) => c as Decision,
    recordAttempt: () => {},
  };
}

describe("BedrockLlmClient offline (no credentials) fast-fail", () => {
  it("caches the no-credentials failure and never re-probes the transport", async () => {
    const calls = { n: 0 };
    const client = new BedrockLlmClient({ client: noCredsSend(calls), model: SONNET });

    await expect(client.converse(ping)).rejects.toThrow(/could not load credentials/i);
    // Later turns must short-circuit on the cached failure — no second IMDS probe.
    await expect(client.converse(ping)).rejects.toThrow(/could not load credentials/i);
    await expect(client.converse(ping)).rejects.toThrow(/could not load credentials/i);

    expect(calls.n).toBe(1);
  });

  it("offline LlmPilot.decide falls back to baseline fast across a full game's turns", async () => {
    const calls = { n: 0 };
    // 100ms per probe stands in for the IMDS stall: 12 turns of re-probing would be
    // >1s (and grows with game length); one cached probe keeps the whole game tiny.
    const client = new BedrockLlmClient({ client: noCredsSend(calls, 100), model: SONNET });
    const pilot = new LlmPilot<null, Decision>({ client, autopilot, modelFor: () => "", messagesFor: () => [] });
    const ctx = offlineContext();

    const start = performance.now();
    for (let turn = 0; turn < 12; turn++) {
      expect(await pilot.decide(ctx)).toEqual(BASELINE);
    }
    const elapsed = performance.now() - start;

    expect(calls.n).toBe(1); // probed once for the whole game, not once per turn
    expect(elapsed).toBeLessThan(1000); // 12 turns stay well under the cert timeout budget
  });
});
