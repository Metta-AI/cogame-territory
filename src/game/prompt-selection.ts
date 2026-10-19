import { z } from "zod";

export const PROMPT_BANK = "territory-rules-v2";
export const TRAINING_VARIANTS = [
  "canonical",
  "plain",
  "numbered",
  "questions",
  "reordered",
] as const;
export const promptVariantSchema = z.enum([
  ...TRAINING_VARIANTS,
  "heldout-briefing",
  "heldout-reference",
  "mixed",
]);
export const promptSelectionSchema = z
  .object({
    promptVariant: promptVariantSchema.default("canonical"),
    promptSeed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(
    (value) => value.promptVariant !== "mixed" || value.promptSeed !== undefined,
    "mixed wording requires an explicit promptSeed",
  )
  .transform((value) => ({
    promptVariant: value.promptVariant,
    promptSeed: value.promptSeed ?? 0,
  }));
export type PromptSelection = z.infer<typeof promptSelectionSchema>;

export function selectedVariant(selection: PromptSelection): Exclude<PromptSelection["promptVariant"], "mixed"> {
  return selection.promptVariant === "mixed"
    ? TRAINING_VARIANTS[selection.promptSeed % TRAINING_VARIANTS.length]!
    : selection.promptVariant;
}

export function selectionMetadata(selection: PromptSelection) {
  return {
    bank: PROMPT_BANK,
    variant: selectedVariant(selection),
    selection: selection.promptVariant,
    seed: selection.promptSeed,
  };
}
