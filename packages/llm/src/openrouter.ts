// Native Anthropic Messages transport to OpenRouter or the hosted inference gateway.
import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

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
  toolInput?: unknown;
  usage: LlmUsage;
  /** Transport request ID supplied by the native SDK for decision telemetry. */
  providerRequestId?: string | null;
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

/** Injectable SDK seam; tests exercise native Messages bodies without network access. */
export interface MessagesClient {
  create(
    input: MessageCreateParamsNonStreaming,
    options: { signal: AbortSignal; headers?: Record<string, string> },
  ): Promise<Message & { _request_id?: string | null }>;
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

export class OpenRouterLlmClient {
  readonly #client: MessagesClient | null;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #hostedGateway: boolean;

  constructor(
    opts: {
      client?: MessagesClient;
      model?: string;
      timeoutMs?: number;
      maxTokens?: number;
      prefix?: string;
    } = {},
  ) {
    const config = llmConfigFromEnv({ prefix: opts.prefix });
    this.#model = process.env.COWORLD_LLM_ENDPOINT
      ? process.env.COWORLD_LLM_MODEL ?? opts.model ?? config.model
      : opts.model ?? config.model;
    this.#timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    this.#maxTokens = opts.maxTokens ?? 1024;
    const endpoint = process.env.COWORLD_LLM_ENDPOINT || undefined;
    this.#hostedGateway = Boolean(endpoint);
    const apiKey = endpoint ? "hosted-gateway" : process.env.OPENROUTER_API_KEY;
    this.#client =
      opts.client ??
      (apiKey
        ? new Anthropic({
            baseURL: endpoint ?? "https://openrouter.ai/api",
            apiKey: null,
            authToken: apiKey,
            maxRetries: 0,
            timeout: this.#timeoutMs,
          }).messages
        : null);
  }

  get model(): string {
    return this.#model;
  }

  async complete(req: {
    system: string;
    slot?: number;
    messages: LlmMessage[];
    tool?: ToolSpec;
    maxTokens?: number;
    model?: string;
  }): Promise<LlmResult> {
    if (!this.#client) {
      throw new MissingLlmCredentialsError(
        "Set COWORLD_LLM_ENDPOINT or OPENROUTER_API_KEY for LLM play",
      );
    }
    const callId = crypto.randomUUID();
    const input: MessageCreateParamsNonStreaming = {
      model: this.#hostedGateway ? process.env.COWORLD_LLM_MODEL ?? this.#model : req.model || this.#model,
      system: req.system,
      messages: req.messages.map(({ role, text }) => ({ role, content: text })),
      max_tokens: req.maxTokens ?? this.#maxTokens,
      ...(!this.#hostedGateway
        ? {
            trace: {
              trace_id: callId,
              platform_call_id: callId,
              generation_name: "anthropic_messages",
              schema_version: "1",
              source: "host",
              metadata_origin: "host_client",
              caller: "internal_tool",
            },
          }
        : {}),
    };
    if (req.tool) {
      input.tools = [
        {
          name: req.tool.name,
          description: req.tool.description,
          input_schema: req.tool.inputSchema as Tool["input_schema"],
        },
      ];
      input.tool_choice = { type: "tool", name: req.tool.name };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const output = await this.#client.create(input, {
        signal: controller.signal,
        headers: this.#hostedGateway
          ? (req.slot === undefined ? {} : { "X-Coworld-Player-Slot": String(req.slot) })
          : { "X-OpenRouter-Metadata": "enabled" },
      });
      const text = output.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      const tool = output.content.find((block) => block.type === "tool_use");
      const usage: LlmUsage = {
        inputTokens: output.usage.input_tokens,
        outputTokens: output.usage.output_tokens,
        cacheReadTokens: output.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: output.usage.cache_creation_input_tokens ?? 0,
      };
      processUsage = {
        calls: processUsage.calls + 1,
        inputTokens: processUsage.inputTokens + usage.inputTokens,
        outputTokens: processUsage.outputTokens + usage.outputTokens,
        cacheReadTokens: processUsage.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: processUsage.cacheWriteTokens + usage.cacheWriteTokens,
      };
      return {
        text,
        usage,
        providerRequestId: output._request_id,
        ...(tool ? { toolInput: tool.input } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
