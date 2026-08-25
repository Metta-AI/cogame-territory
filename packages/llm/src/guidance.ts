// Operator steering: prepend a human directive to a rendered prompt so the
// operator can nudge a pilot on its NEXT decision without changing the game. An
// empty/whitespace directive is a no-op (returns the base prompt unchanged).

/** Prepend operator `guidance` to `basePrompt` when non-empty; else pass through. */
export function applyGuidance(basePrompt: string, guidance: string): string {
  const directive = guidance.trim();
  if (!directive) return basePrompt;
  return `Operator guidance (follow it): ${directive}\n\n${basePrompt}`;
}
