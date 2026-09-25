import { z } from "zod";

export type JevJsonValue =
  | string
  | number
  | boolean
  | null
  | JevJsonValue[]
  | { [key: string]: JevJsonValue };

export type JevContent = string | JevJsonValue[] | { [key: string]: JevJsonValue };

const jevJsonValueSchema: z.ZodType<JevJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jevJsonValueSchema),
    z.record(jevJsonValueSchema),
  ]),
);
const jevContentSchema: z.ZodType<JevContent> = z.union([
  z.string(),
  z.array(jevJsonValueSchema),
  z.record(jevJsonValueSchema),
]);

const jevQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: jevContentSchema.nullable().optional(),
    criteria: z
      .object({
        true: jevContentSchema.nullable().optional(),
        false: jevContentSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: jevContentSchema.nullable().optional(),
    criteria: z
      .record(jevContentSchema.nullable())
      .refine((criteria) => Object.keys(criteria).length > 0),
  }),
  z.object({
    type: z.literal("score"),
    instructions: jevContentSchema.nullable().optional(),
    criteria: z.array(jevContentSchema).min(1),
  }),
]);

const jevSystemOneRequestSchema = z.object({
  state: jevContentSchema,
  model: z.string().min(1),
  questions: z.record(jevQuestionSchema).refine((questions) => Object.keys(questions).length > 0),
});

const probabilitySchema = z.number().finite().min(0).max(1);
const distributionSchema = z.record(probabilitySchema).refine((probabilities) => {
  const values = Object.values(probabilities);
  // System One rounds each choice to hundredths, so total rounding error grows with the choice count.
  return Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) <= values.length * 0.005 + 1e-6;
}, "Jev probabilities must sum to one");

const jevAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probabilitySchema }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probabilitySchema,
    probabilities: distributionSchema,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    confidence: probabilitySchema,
    legend: z.record(z.unknown()),
    probabilities: distributionSchema,
  }),
]);

const jevSystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(jevAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().nullable().optional(),
    output_tokens: z.number().int().nonnegative().nullable().optional(),
    cost: z.number().nonnegative().optional(),
  }),
});

export type JevAnswer = z.infer<typeof jevAnswerSchema>;
export type JevSystemOneResponse = z.infer<typeof jevSystemOneResponseSchema>;

export type JevQuestion = z.infer<typeof jevQuestionSchema>;

export interface JevSystemOneRequest {
  state: JevContent;
  questions: Record<string, JevQuestion>;
  model?: string;
}

export interface JevClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Minimal TypeSafe System One client for Jev's typed judgment endpoint. */
export class JevClient {
  readonly #headers: Record<string, string>;
  readonly #hosted: boolean;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const sidecar = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
    this.#hosted = Boolean(sidecar);
    this.#headers = { accept: "application/json", "content-type": "application/json" };
    if (sidecar) {
      this.#baseUrl = sidecar.replace(/\/+$/, "");
      this.#model = options.model ?? "typesafe/jev-1.13";
    } else {
      const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for local Jev inference");
      this.#headers.authorization = `Bearer ${apiKey}`;
      this.#baseUrl = (
        options.baseUrl ??
        process.env.TYPESAFE_BASE_URL ??
        "https://api.typesafe.ai"
      ).replace(/\/+$/, "");
      this.#model = options.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
    }
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async systemOne(
    request: JevSystemOneRequest,
    playerSlot?: number,
  ): Promise<JevSystemOneResponse> {
    if (playerSlot !== undefined && (!Number.isInteger(playerSlot) || playerSlot < 0)) {
      throw new Error("Jev player slot must be a nonnegative integer");
    }
    const body = jevSystemOneRequestSchema.parse({
      state: request.state,
      model: request.model ?? this.#model,
      questions: request.questions,
    });
    let response: Response;
    let connectionRefusals = 0;
    let transientFailures = 0;
    for (;;) {
      try {
        response = await this.#fetch(`${this.#baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            ...this.#headers,
            ...(this.#hosted && playerSlot !== undefined
              ? { "X-Coworld-Player-Slot": String(playerSlot) }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        const cause = (error as Error & { cause?: { code?: string } }).cause;
        if (this.#hosted && cause?.code === "ECONNREFUSED" && connectionRefusals < 5) {
          connectionRefusals++;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw error;
      }
      if ((response.status !== 503 && response.status !== 529) || transientFailures === 2) break;
      transientFailures++;
      await new Promise((resolve) => setTimeout(resolve, 1000 * transientFailures));
    }
    if (!response.ok) {
      throw new Error(`Jev request failed (${response.status}): ${await response.text()}`);
    }
    const result = jevSystemOneResponseSchema.parse(await response.json());
    if (Object.keys(result.answers).length !== Object.keys(body.questions).length) {
      throw new Error("Jev returned answers for the wrong question set");
    }
    for (const [name, question] of Object.entries(body.questions)) {
      const answer = result.answers[name];
      if (!answer || answer.type !== question.type) {
        throw new Error(`Jev returned the wrong answer type for ${JSON.stringify(name)}`);
      }
      if (question.type === "choice" && answer.type === "choice") {
        const choices = Object.keys(question.criteria);
        if (
          !choices.includes(answer.choice) ||
          Object.keys(answer.probabilities).length !== choices.length ||
          !choices.every((choice) => Object.hasOwn(answer.probabilities, choice))
        ) {
          throw new Error(`Jev returned the wrong choice set for ${JSON.stringify(name)}`);
        }
        if (
          Object.values(answer.probabilities).some(
            (p) => p > answer.probabilities[answer.choice]! + 1e-6,
          )
        ) {
          throw new Error(`Jev choice is not the most probable option for ${JSON.stringify(name)}`);
        }
      }
    }
    return result;
  }
}
