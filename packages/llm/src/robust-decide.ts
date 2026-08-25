// The robust decide loop — the shared backbone for BOTH action decisions and
// message generation. Ask the model for one decision, parse it (tool input when
// a tool is offered, else the first JSON object in the text), then `validate`
// (schema + legality). On a thrown rejection, re-prompt INCLUDING the reason and
// retry up to `maxAttempts`; on exhaustion fall back to `baseline()` so a flaky
// model never stalls a turn. Every attempt is reported via `recordAttempt` for
// the autopilot transcript surfaced in the UI.
//
// The catch here is legitimate control flow: catching a validation/parse
// rejection to re-prompt, falling back to baseline on exhaustion, and treating a
// terminal no-credentials transport error as an immediate baseline (re-prompting
// is futile — there is no model to reach). Other transport errors still surface.
import type { ActAttempt } from "@cogweb/protocol";
import { isCredentialsUnavailable } from "./bedrock.js";
import type { BedrockLlmClient, ConverseMessage, ToolSpec } from "./bedrock.js";

/**
 * Pull the first JSON object out of a model reply (handles ```json fences and
 * surrounding prose). Throws if none parses — that throw is caught by the loop
 * and re-prompted like any other rejection.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const braced = (() => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
  })();
  for (const candidate of [fenced, braced, text]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate; if all fail we throw below.
    }
  }
  throw new Error("no JSON object in reply");
}

export interface RobustDecideOpts<Decision> {
  client: BedrockLlmClient;
  /** System prompt: rules, strategy, output-format contract. */
  system: string;
  /** Render the user turn. Re-rendered each attempt with the prior rejection
   *  reason (null on the first try) so the retry re-states the error. */
  renderUser: (rejection: string | null) => string;
  /** Validate a candidate (schema + legality); returns the typed decision, or
   *  THROWS a human-readable reason suitable for re-prompting. */
  validate: (candidate: unknown) => Decision;
  /** An always-legal decision used when every attempt is exhausted. */
  baseline: () => Decision;
  /** Record one attempt (prompt, response, rejection-or-null) for the transcript. */
  recordAttempt: (attempt: ActAttempt) => void;
  /** Max model calls before falling back. Defaults to 3. */
  maxAttempts?: number;
  /** Optional tool for structured output; when present the model is forced to
   *  call it and its input is validated; when absent, JSON is extracted from text. */
  tool?: ToolSpec;
}

/** Run the retry-then-fallback loop and return a validated decision. */
export async function robustDecide<Decision>(opts: RobustDecideOpts<Decision>): Promise<Decision> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let rejection: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt = opts.renderUser(rejection);
    const messages: ConverseMessage[] = [{ role: "user", text: prompt }];
    let reply;
    try {
      reply = await opts.client.converse({ system: opts.system, messages, tool: opts.tool });
    } catch (err) {
      // No credentials (offline cert): terminal and unrecoverable — retrying just
      // re-fails. Record it and play baseline now so the turn resolves instantly.
      if (!isCredentialsUnavailable(err)) throw err; // throttle/timeout etc. still surface
      opts.recordAttempt({ prompt, response: "", error: err instanceof Error ? err.message : String(err) });
      return opts.baseline();
    }
    const response = opts.tool ? JSON.stringify(reply.toolInput ?? null) : reply.text;

    try {
      // Parse AND validate inside the same try: a parse failure (no JSON in the
      // reply) is a rejection to re-prompt exactly like a legality rejection.
      const candidate = opts.tool ? reply.toolInput : extractJson(reply.text);
      const decision = opts.validate(candidate);
      opts.recordAttempt({ prompt, response, error: null });
      return decision;
    } catch (err) {
      rejection = err instanceof Error ? err.message : String(err);
      opts.recordAttempt({ prompt, response, error: rejection });
    }
  }

  return opts.baseline();
}
