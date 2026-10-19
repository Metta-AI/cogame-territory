import { z } from "zod";

export const PROMPT_BANK = "territory-rules-v1";
export const INTRODUCTIONS = {
  canonical: "You are one of nine Cogs painting your claim onto a hex lattice of resource walls.",
  plain: "Nine Cogs compete to claim resource walls on a hex lattice. You control one Cog.",
  numbered:
    "Your setting: a hex lattice of resource walls. Your role: one of nine Cogs claiming those walls.",
  questions:
    "Where are you playing? A hex lattice of resource walls. Who are you? One of nine Cogs making claims.",
  reordered:
    "On a hex lattice of resource walls, nine Cogs paint their claims. One of those Cogs is yours to control.",
  "heldout-briefing":
    "You control a Cog in a nine-Cog game of claiming resource walls across a hex lattice.",
  "heldout-reference":
    "Game setting: resource walls arranged on a hex lattice; participants: nine Cogs, including yours.",
} as const;

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

export function selectedVariant(selection: PromptSelection): keyof typeof INTRODUCTIONS {
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
