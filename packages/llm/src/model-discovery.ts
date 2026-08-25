// Probe which Bedrock models this AWS account/region can actually invoke, so the
// autopilot picker offers only working models. Model access varies per account
// (e.g. Opus 4.8 is granted on softmax-org but not everywhere), so a static
// enabled-flag lies — the probe's success IS the availability signal. A failed
// probe means the model isn't usable (no access / not found / no credentials),
// not a bug, so it's classified "unavailable" rather than aborting discovery.
import { BedrockLlmClient, MODEL_CANDIDATES, type BedrockSend } from "./bedrock.js";

// The candidate list lives with the client (it now self-heals against it too).
export { MODEL_CANDIDATES };

/** Resolves true iff `modelId` can be invoked in this account/region right now. */
export type ModelProbe = (modelId: string) => Promise<boolean>;

/**
 * Probe each candidate and keep the ones that respond. Returns the available
 * subset in candidate (best-first) order. The `client` supplies the transport
 * (`BedrockSend`) and region; tests inject a fake `client` so no AWS is hit.
 */
export async function discoverModels(
  client: { send: BedrockSend },
  opts: { candidates?: readonly string[]; probe?: ModelProbe } = {},
): Promise<string[]> {
  const candidates = opts.candidates ?? MODEL_CANDIDATES;
  const probe = opts.probe ?? defaultProbe(client.send);
  const checks = await Promise.all(
    candidates.map(async (id) => {
      try {
        return (await probe(id)) ? id : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

/** A tiny one-token `converse` per model over the injected transport; success ⇒
 *  available. Reuses `BedrockLlmClient` so a model that passes here works for
 *  real calls (same code path). */
function defaultProbe(send: BedrockSend): ModelProbe {
  return async (modelId) => {
    const client = new BedrockLlmClient({ client: send, model: modelId, maxTokens: 1 });
    try {
      await client.converse({ system: "ping", messages: [{ role: "user", text: "ping" }], maxTokens: 1 });
      return true;
    } catch {
      return false;
    }
  };
}
