// One direct text-action transport for local and hosted Coworld policies.
import { z } from "zod";
import {
  GenerationEvidenceError,
  SamplingEvidence,
  GenerationPurpose,
  type TextGeneration,
} from "@cogweb/protocol";

export interface LlmMessage {
  role: "user" | "assistant";
  text: string;
}
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  generation: TextGeneration;
  providerRequestId: string | null;
  platformCallId: string | null;
}

export interface LlmUsageTotals extends LlmUsage {
  calls: number;
}

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
let processUsage: LlmUsageTotals = { calls: 0, ...ZERO_USAGE };

export function llmUsageTotals(): LlmUsageTotals {
  return { ...processUsage };
}

export function resetLlmUsage(): void {
  processUsage = { calls: 0, ...ZERO_USAGE };
}

export interface LlmConfig {
  model: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(
  opts: { prefix?: string; env?: NodeJS.ProcessEnv } = {},
): LlmConfig {
  const env = opts.env ?? process.env;
  const prefix = opts.prefix ? `${opts.prefix}_` : "";
  const timeout = env[`${prefix}LLM_TIMEOUT_MS`] ?? env.LLM_TIMEOUT_MS;
  return {
    model: env[`${prefix}LLM_MODEL`] ?? env.LLM_MODEL ?? "anthropic/claude-haiku-4.5",
    timeoutMs: timeout ? Number(timeout) : 30_000,
  };
}

class MissingLlmCredentialsError extends Error {}

/** Only absent local configuration permits offline certification's baseline path.
 * HTTP authentication errors and provider failures still surface to the caller. */
export function isCredentialsUnavailable(error: unknown): boolean {
  return error instanceof MissingLlmCredentialsError;
}

const CompletionResponse = z.object({
  model: z.string().min(1),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  sampling_evidence: SamplingEvidence.optional(),
});

export class OpenRouterLlmClient {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #temperature: number;
  readonly #hostedGateway: boolean;
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(
    opts: {
      fetch?: typeof fetch;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      maxTokens?: number;
      temperature?: number;
      prefix?: string;
    } = {},
  ) {
    const config = llmConfigFromEnv({ prefix: opts.prefix });
    const endpoint = process.env.COWORLD_LLM_ENDPOINT;
    this.#hostedGateway = Boolean(endpoint);
    this.#model =
      (endpoint ? process.env.COWORLD_LLM_MODEL : undefined) ?? opts.model ?? config.model;
    this.#timeoutMs = z
      .number()
      .int()
      .positive()
      .max(600_000)
      .parse(opts.timeoutMs ?? config.timeoutMs);
    this.#maxTokens = opts.maxTokens ?? 1024;
    this.#temperature = opts.temperature ?? Number(process.env.COWORLD_LLM_TEMPERATURE ?? 0);
    this.#endpoint = (endpoint ?? opts.baseUrl ?? "https://openrouter.ai/api").replace(/\/+$/, "");
    this.#apiKey = endpoint ? "sidecar" : (opts.apiKey ?? process.env.OPENROUTER_API_KEY);
    this.#fetch = opts.fetch ?? fetch;
  }

  get model(): string {
    return this.#model;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  async complete(req: {
    purpose: GenerationPurpose;
    signal: AbortSignal;
    system: string;
    slot?: number;
    messages: LlmMessage[];
    maxTokens?: number;
    model?: string;
    recordGeneration: (generation: TextGeneration) => void;
  }): Promise<LlmResult> {
    req.signal.throwIfAborted();
    if (!this.#apiKey)
      throw new MissingLlmCredentialsError(
        "Set COWORLD_LLM_ENDPOINT or OPENROUTER_API_KEY for LLM play",
      );
    const messages: TextGeneration["messages"] = [
      { role: "system", content: req.system },
      ...req.messages.map(({ role, text }) => ({ role, content: text })),
    ];
    const purpose = GenerationPurpose.parse(req.purpose);
    const environment = purpose.kind === "environment" ? purpose : null;
    const request = {
      model: environment
        ? environment.model
        : this.#hostedGateway
          ? this.#model
          : req.model || this.#model,
      messages,
      max_tokens: environment ? environment.decoder.maxTokens : (req.maxTokens ?? this.#maxTokens),
      temperature: environment ? environment.decoder.temperature : this.#temperature,
      ...(environment ? { top_p: environment.decoder.topP } : {}),
    };
    const startedAt = performance.now();
    const generation: TextGeneration = {
      purpose,
      model: request.model,
      messages,
      response: "",
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      inferenceMode: purpose.kind === "learner" ? "text_action" : undefined,
      platformCallId: null,
      request,
      decoder: {
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        ...(environment ? { top_p: environment.decoder.topP } : {}),
        timeout_ms: this.#timeoutMs,
      },
    };
    req.recordGeneration(generation);
    try {
      const response = await this.#fetch(`${this.#endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          ...(this.#hostedGateway && purpose.kind === "learner" && req.slot !== undefined
            ? { "X-Coworld-Player-Slot": String(req.slot) }
            : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
      Object.assign(generation, {
        latencyMs: performance.now() - startedAt,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        providerRequestId: response.headers.get("x-request-id"),
        platformCallId: response.headers.get("X-Softmax-Llm-Call-Id"),
        modelIdentity: response.headers.get("X-Coworld-Checkpoint-Sha256"),
        tokenizerIdentity: response.headers.get("X-Coworld-Tokenizer-Sha256"),
        chatTemplateSha256: response.headers.get("X-Coworld-Chat-Template-Sha256"),
      });
      req.recordGeneration(generation);
      const rawBody = await response.text();
      Object.assign(generation, {
        response: rawBody,
        rawResponse: rawBody,
        latencyMs: performance.now() - startedAt,
      });
      req.recordGeneration(generation);
      if (!response.ok)
        throw new GenerationEvidenceError(
          `Text completion failed (${response.status}): ${rawBody}`,
          generation,
        );
      const rawResponse: unknown = JSON.parse(rawBody);
      const output = CompletionResponse.parse(rawResponse);
      req.signal.throwIfAborted();
      const text = output.choices[0]!.message.content;
      const usage: LlmUsage = {
        inputTokens: output.usage?.prompt_tokens ?? 0,
        outputTokens: output.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      Object.assign(generation, {
        model: output.model,
        response: text,
        inputTokens: output.usage?.prompt_tokens ?? null,
        outputTokens: output.usage?.completion_tokens ?? null,
        stopReason: output.choices[0]!.finish_reason,
        samplingEvidence: output.sampling_evidence,
        latencyMs: performance.now() - startedAt,
      });
      req.recordGeneration(generation);
      processUsage = {
        calls: processUsage.calls + 1,
        inputTokens: processUsage.inputTokens + usage.inputTokens,
        outputTokens: processUsage.outputTokens + usage.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      return {
        text,
        usage,
        generation,
        platformCallId: generation.platformCallId ?? null,
        providerRequestId: response.headers.get("x-request-id"),
      };
    } finally {
      generation.latencyMs = performance.now() - startedAt;
      req.recordGeneration(generation);
    }
  }
}
