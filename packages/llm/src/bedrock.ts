// The single seam between a pilot and a real model. Everything above this
// interface is deterministic and testable; the only non-determinism lives behind
// `converse`. Tests inject a fake `BedrockSend`, so they make NO real AWS calls.
//
// Anthropic-on-Bedrock via `ConverseCommand`. `converse` does one
// request/response and, when a `tool` is supplied, asks for structured output
// the model returns as a `toolUse` block; otherwise it returns the joined text.
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message as BedrockMessage,
  type Tool,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import { bedrockProfileLister, orderCandidates, parseClaudeModel, type ProfileLister } from "./latest-model.js";

/** The recursive JSON document type Bedrock's tool `inputSchema.json` accepts. A
 *  game's `inputSchema` is opaque JSON Schema (typed `unknown` upstream); this is
 *  the one boundary cast where it crosses into the SDK's document shape. */
type ToolInputJson = Extract<ToolInputSchema, { json: unknown }>["json"];

const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_REGION = "us-west-2";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;
/** Cap the one-time model-discovery list so a slow/no-credentials AWS provider
 *  chain can't stall the first turn — past this we use the static fallback. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/** True iff the environment carries credentials the AWS SDK can resolve WITHOUT
 *  the slow EC2 instance-metadata (IMDS) probe — env keys, an IRSA web-identity
 *  token, ECS/Pod-Identity container creds, or a named profile. Discovery only runs
 *  when one is present: the tournament's IRSA pods have `AWS_WEB_IDENTITY_TOKEN_FILE`,
 *  but an offline/no-creds container (e.g. local `coworld certify`) has none — there,
 *  a `ListInferenceProfiles` call would stall on the unreachable IMDS endpoint and
 *  hang the episode, so we skip straight to the static fallback. */
function hasResolvableAwsCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AWS_ACCESS_KEY_ID ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      env.AWS_PROFILE,
  );
}

/** Reject if `promise` doesn't settle within `ms` (the timer is always cleared). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Static fallback model ids, best-first, used ONLY when live discovery
 *  (`ListInferenceProfiles`) is unavailable (e.g. the role lacks the list
 *  permission). The live path is authoritative and always-latest; this list just
 *  has to keep SOMETHING resolving across tiers. Every id here must be a real,
 *  invokable profile (a stale/invalid id silently degrades pilots — the bug this
 *  replaced shipped `claude-opus-4-8-20251101-v1:0`, which Bedrock rejects). */
export const MODEL_CANDIDATES: readonly string[] = [
  "us.anthropic.claude-opus-4-8",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
];

/** True iff the error means the model id is not usable in this account/region —
 *  the recoverable case the client falls through on. NOT throttling/timeouts/etc.,
 *  which are real failures to surface. AWS-SDK errors carry a `name`; we also
 *  sniff the message for the common Bedrock access phrasings. */
export function isModelUnavailable(err: unknown): boolean {
  const name = (err as { name?: unknown }).name;
  if (name === "AccessDeniedException" || name === "ResourceNotFoundException" || name === "ValidationException") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /model identifier is invalid|not authorized|don'?t have access|marketplace|not found/i.test(msg);
}

/** True iff the error means the AWS SDK could not resolve ANY credentials — the
 *  offline/no-creds case `coworld certify` runs in. It is terminal (every retry
 *  re-stalls on the absent IMDS endpoint and fails identically), so the client
 *  caches it and short-circuits later turns instead of re-probing. Distinct from
 *  `isModelUnavailable` (an access/grant gap with creds present) — a creds error
 *  must NOT be mistaken for "try the next model". */
export function isCredentialsUnavailable(err: unknown): boolean {
  if ((err as { name?: unknown }).name === "CredentialsProviderError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /could not load credentials/i.test(msg);
}

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One conversation turn handed to `converse`. */
export interface ConverseMessage {
  role: "user" | "assistant";
  text: string;
}

/** Token usage for one model turn, mirroring Bedrock's `usage` block. Zeroed when
 *  the response omits it (an injected fake transport, or a no-credentials turn
 *  that never reached the model). `cache*` are prompt-cache hits/writes. */
export interface ConverseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The flattened result of one model turn. `toolInput` is present iff a `tool`
 *  was offered and the model answered with a tool-use block. `usage` is the
 *  per-turn token cost (also tallied into the process-wide ledger). */
export interface ConverseResult {
  text: string;
  toolInput?: unknown;
  usage: ConverseUsage;
}

/** Running token totals for the current process. A coworld game host (or player)
 *  runs as ONE process per episode, so this module-level tally captures every
 *  turn across however many `BedrockLlmClient`/`LlmPilot` instances the process
 *  creates — no need to thread a client handle through pilot construction. The
 *  host writes `bedrockUsageTotals()` into the replay at episode end; a player
 *  logs it on `final`. This is the in-process counterpart to Bedrock model-
 *  invocation logging (which only exists where the account enables it). */
export interface BedrockUsageTotals extends ConverseUsage {
  /** Number of model turns that reached Bedrock (fallback turns don't count). */
  calls: number;
}

const ZERO_USAGE: ConverseUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

let processUsage: BedrockUsageTotals = { calls: 0, ...ZERO_USAGE };

/** A snapshot of this process's Bedrock token usage so far. */
export function bedrockUsageTotals(): BedrockUsageTotals {
  return { ...processUsage };
}

/** Reset the process ledger (e.g. between episodes in a reused runtime). */
export function resetBedrockUsage(): void {
  processUsage = { calls: 0, ...ZERO_USAGE };
}

/**
 * The minimal slice of `BedrockRuntimeClient` used here — lets a fake `{ send }`
 * be injected for tests without `as never` casts or any AWS network.
 */
export interface BedrockSend {
  send(cmd: ConverseCommand, opts: { abortSignal: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockConfig {
  model: string;
  region: string;
  timeoutMs: number;
}

/**
 * Resolve model/region/timeout from env (libraries never read env deep inside).
 * `prefix` lets an app namespace its vars (e.g. `COGNAMES` →
 * `COGNAMES_BEDROCK_MODEL`); the unprefixed `BEDROCK_*` / `AWS_REGION` are the
 * fallback so a plain shell works out of the box.
 */
export function bedrockConfigFromEnv(opts: { prefix?: string; env?: NodeJS.ProcessEnv } = {}): BedrockConfig {
  const env = opts.env ?? process.env;
  const p = opts.prefix ? `${opts.prefix}_` : "";
  const model = env[`${p}BEDROCK_MODEL`] ?? env.BEDROCK_MODEL ?? DEFAULT_MODEL;
  const region = env[`${p}BEDROCK_REGION`] ?? env.BEDROCK_REGION ?? env.AWS_REGION ?? DEFAULT_REGION;
  const timeoutRaw = env[`${p}BEDROCK_TIMEOUT_MS`] ?? env.BEDROCK_TIMEOUT_MS;
  return {
    model,
    region,
    timeoutMs: timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS,
  };
}

/** Optional `requestMetadata` attached to every Bedrock turn so the account's
 *  model-invocation logs can be attributed to a coworld/episode/slot. The
 *  platform sets `BEDROCK_REQUEST_METADATA` to a JSON object of string→string
 *  (e.g. `{"coworld_id":"...","episode_id":"...","slot":"0"}`); absent ⇒ none.
 *  Bad JSON crashes — the platform owns the value, so a malformed one is a bug to
 *  surface, not swallow. */
export function bedrockRequestMetadataFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const raw = env.BEDROCK_REQUEST_METADATA;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
  return Object.keys(out).length ? out : undefined;
}

/** The Bedrock-backed client. The underlying transport can be injected so tests
 *  exercise body-building/parsing with no network. */
export class BedrockLlmClient {
  readonly #client: BedrockSend;
  // Not readonly: resolved to the discovered/working model once, then stuck.
  #model: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  // Live model discovery (ListInferenceProfiles). Null when a transport is injected
  // (tests / the discovery probe) so unit tests never reach AWS; then the static
  // MODEL_CANDIDATES fallback is used. Resolution runs once, cached in #candidates.
  readonly #lister: ProfileLister | null;
  // An explicitly-injected lister (tests) always runs; the auto-constructed real
  // one is gated on a fast credential signal so offline envs skip the IMDS stall.
  readonly #listerInjected: boolean;
  #candidates: string[] | null = null;
  #resolved = false;
  // Attribution tags echoed into every Bedrock invocation log (coworld/episode/
  // slot). Null when neither an opt nor BEDROCK_REQUEST_METADATA supplies them.
  readonly #requestMetadata: Record<string, string> | undefined;
  // Once any AWS call proves there are NO credentials (the offline cert case), the
  // failure is cached here and every later turn re-throws it WITHOUT touching the
  // SDK again — otherwise each turn re-stalls on the absent IMDS endpoint and a
  // full game blows past the cert timeout.
  #credentialsUnavailable: Error | null = null;

  constructor(
    opts: {
      client?: BedrockSend;
      model?: string;
      region?: string;
      timeoutMs?: number;
      maxTokens?: number;
      prefix?: string;
      lister?: ProfileLister;
      requestMetadata?: Record<string, string>;
    } = {},
  ) {
    const cfg = bedrockConfigFromEnv({ prefix: opts.prefix });
    const region = opts.region ?? cfg.region;
    this.#client = opts.client ?? (new BedrockRuntimeClient({ region }) as unknown as BedrockSend);
    this.#model = opts.model ?? cfg.model;
    this.#timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    this.#maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#requestMetadata = opts.requestMetadata ?? bedrockRequestMetadataFromEnv();
    // Discover live only when we own a real transport. An injected `client` must
    // not reach AWS, so discovery is off there unless a `lister` is supplied.
    this.#lister = opts.lister ?? (opts.client ? null : bedrockProfileLister(region));
    this.#listerInjected = opts.lister !== undefined;
  }

  /** The model id this client invokes (drives the autopilot picker default). */
  get model(): string {
    return this.#model;
  }

  /** One model turn. With `tool`, forces that tool and returns its parsed input
   *  in `toolInput`; without, returns the concatenated text blocks.
   *
   *  Model selection is automatic and always-latest: on first use the client lists
   *  the account's Claude inference profiles and builds a best-first candidate list
   *  — the NEWEST version of the configured model's tier first, then its older
   *  versions, then other tiers (opus→sonnet→haiku) — and invokes the first that
   *  works, sticking to it. So a policy configured for any Opus id runs on the
   *  newest Opus the account actually grants, rather than silently degrading to a
   *  weaker tier. If discovery is unavailable it falls back to the static
   *  MODEL_CANDIDATES. If NONE works the last error is re-raised (never silent). */
  async converse(req: { system: string; messages: ConverseMessage[]; tool?: ToolSpec; maxTokens?: number }): Promise<ConverseResult> {
    if (this.#credentialsUnavailable) throw this.#credentialsUnavailable;
    await this.#ensureResolved();
    // Discovery may have just proven there are no credentials; don't bother invoking.
    if (this.#credentialsUnavailable) throw this.#credentialsUnavailable;
    const candidates = this.#candidates ?? [this.#model];
    let lastErr: unknown = null;
    for (const id of candidates) {
      try {
        const result = await this.#invoke(id, req);
        if (id !== this.#model) {
          console.warn(`[bedrock] resolved model "${this.#model}" → "${id}"`);
          this.#model = id;
        }
        this.#candidates = [id]; // known-good; later turns invoke it directly
        return result;
      } catch (err) {
        if (isCredentialsUnavailable(err)) {
          // No creds at all — cache so every later turn fails instantly, then surface.
          this.#credentialsUnavailable = err instanceof Error ? err : new Error(String(err));
          throw err;
        }
        if (!isModelUnavailable(err)) throw err; // throttle/timeout on a real model — surface it
        lastErr = err;
      }
    }
    // No candidate is usable (e.g. an offline / no-credentials env). Collapse to a
    // single candidate so subsequent turns probe ONCE instead of re-walking the whole
    // list every turn — that per-turn fan-out, with slow no-cred resolution, is what
    // timed out offline certification. The caller's robustDecide folds this into the
    // baseline, as before.
    this.#candidates = [candidates[0] ?? this.#model];
    throw lastErr ?? new Error("No Bedrock model candidates to invoke");
  }

  /** Build the best-first candidate list once. Live discovery (the account's Claude
   *  profiles, newest-of-tier first) when a lister is configured; otherwise the
   *  static MODEL_CANDIDATES, still tier-ordered. The configured model's tier is the
   *  preference; its exact version is NOT pinned — we always take the latest. The
   *  configured id is appended as a last resort so a valid-but-unlisted id still works. */
  async #ensureResolved(): Promise<void> {
    if (this.#resolved) return;
    this.#resolved = true;
    const tier = parseClaudeModel(this.#model)?.tier ?? null;
    let ids: string[] = [];
    if (this.#lister && (this.#listerInjected || hasResolvableAwsCredentials())) {
      const lister = this.#lister;
      try {
        // Bound discovery: in a no-credentials env the AWS provider chain can be
        // slow to give up, so never let the one-time list hang the first turn —
        // fall back to the static candidates instead.
        ids = orderCandidates(await withTimeout(lister(), DISCOVERY_TIMEOUT_MS), tier);
      } catch (err) {
        const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
        console.warn(`[bedrock] model discovery unavailable (${reason}); using static fallback`);
        // No credentials at discovery ⇒ none for invoke either: cache so converse
        // fails fast instead of stalling on IMDS again per turn. (An access/grant
        // gap is NOT this — creds are present, invoke may still work, so fall through.)
        if (isCredentialsUnavailable(err)) this.#credentialsUnavailable = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (ids.length === 0) ids = orderCandidates(MODEL_CANDIDATES, tier);
    if (!ids.includes(this.#model)) ids.push(this.#model);
    this.#candidates = ids;
  }

  /** One Bedrock turn against a specific model id (no fallback). */
  async #invoke(
    modelId: string,
    req: { system: string; messages: ConverseMessage[]; tool?: ToolSpec; maxTokens?: number },
  ): Promise<ConverseResult> {
    const messages: BedrockMessage[] = req.messages.map((m) => ({ role: m.role, content: [{ text: m.text }] }));
    const input: ConverseCommandInput = {
      modelId,
      system: [{ text: req.system }],
      messages,
      inferenceConfig: { maxTokens: req.maxTokens ?? this.#maxTokens },
    };
    if (this.#requestMetadata) input.requestMetadata = this.#requestMetadata;
    if (req.tool) {
      const tool: Tool = {
        toolSpec: {
          name: req.tool.name,
          description: req.tool.description,
          inputSchema: { json: req.tool.inputSchema as ToolInputJson },
        },
      };
      input.toolConfig = { tools: [tool], toolChoice: { tool: { name: req.tool.name } } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const out = await this.#client.send(new ConverseCommand(input), { abortSignal: controller.signal });
      const blocks = out.output?.message?.content ?? [];
      const text = blocks
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
      const usage: ConverseUsage = {
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
        cacheReadTokens: out.usage?.cacheReadInputTokens ?? 0,
        cacheWriteTokens: out.usage?.cacheWriteInputTokens ?? 0,
      };
      processUsage = {
        calls: processUsage.calls + 1,
        inputTokens: processUsage.inputTokens + usage.inputTokens,
        outputTokens: processUsage.outputTokens + usage.outputTokens,
        cacheReadTokens: processUsage.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: processUsage.cacheWriteTokens + usage.cacheWriteTokens,
      };
      const result: ConverseResult = { text, usage };
      if (toolUse) result.toolInput = toolUse.input;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
