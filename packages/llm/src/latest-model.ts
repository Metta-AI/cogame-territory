// Discover the Bedrock Claude models this account/region actually offers and pick
// the newest of the requested tier. Replaces a hand-maintained model-id list (which
// drifted: it shipped invalid ids like `claude-opus-4-8-20251101-v1:0`, silently
// degrading every pilot to a weaker model). The control-plane `ListInferenceProfiles`
// is the source of truth; selection is pure and unit-tested against fake listings.
import { BedrockClient, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";

export type ClaudeTier = "opus" | "sonnet" | "haiku";

/** Best-first capability order, used only when the requested tier is unavailable. */
const TIER_RANK: Record<ClaudeTier, number> = { opus: 3, sonnet: 2, haiku: 1 };

/** Prefer a regional cross-region inference profile (`us.`) over `global.` over a
 *  bare foundation-model id, since on-demand invoke of the newer models needs a
 *  profile. Lower rank = preferred. */
function prefixRank(id: string): number {
  if (id.startsWith("us.")) return 0;
  if (id.startsWith("global.")) return 1;
  return 2;
}

export interface ClaudeModelId {
  id: string;
  tier: ClaudeTier;
  major: number;
  /** Minor version, or 0 for a major-only model (e.g. `claude-sonnet-4`). */
  minor: number;
  /** Release date `YYYYMMDD` (0 if the id carries none). Distinguishes dated
   *  snapshots of the same major.minor so "latest" picks the newest. */
  date: number;
}

/** Classify the numeric segments after the tier into {major, minor, date}. The
 *  first number is the major; an 8-digit number is the release date (NOT a minor —
 *  the bug this avoids: `claude-sonnet-4-20250514` is sonnet 4, not 4.20250514);
 *  any other trailing number is the minor (major-only ids leave it 0). */
function classifyVersion(numericTokens: string[]): { major: number; minor: number; date: number } {
  const major = Number(numericTokens[0]);
  let minor = 0;
  let date = 0;
  for (const tok of numericTokens.slice(1)) {
    if (tok.length === 8) date = Math.max(date, Number(tok));
    else if (minor === 0) minor = Number(tok);
  }
  return { major, minor, date };
}

/** Parse a Bedrock Claude id into {tier, major, minor, date}. Handles modern
 *  `claude-opus-4-8[-DATE][-v1:0]` (incl. major-only `claude-sonnet-4-DATE`) and
 *  legacy `claude-3-5-sonnet[-DATE]`. Returns null for non-Claude / unparseable ids. */
export function parseClaudeModel(id: string): ClaudeModelId | null {
  const modern = id.match(/claude-(opus|sonnet|haiku)-([\d-]+)/);
  if (modern) {
    const [, tier, nums] = modern;
    const tokens = (nums ?? "").split("-").filter((t) => /^\d+$/.test(t));
    if (tier && tokens.length > 0) return { id, tier: tier as ClaudeTier, ...classifyVersion(tokens) };
  }
  const legacy = id.match(/claude-(\d+)-(\d+)-(opus|sonnet|haiku)(?:-(\d{8}))?/);
  if (legacy) {
    const [, major, minor, tier, date] = legacy;
    if (tier && major && minor) {
      return { id, tier: tier as ClaudeTier, major: Number(major), minor: Number(minor), date: date ? Number(date) : 0 };
    }
  }
  return null;
}

/** Order candidate ids best-first for a preferred tier: the preferred tier's newest
 *  version wins, then its older versions, then other tiers (most capable first,
 *  newest first) so SOMETHING resolves even if the preferred tier is ungranted.
 *  "Newest" compares (major, minor, date) so distinct dated snapshots of the same
 *  major.minor are ordered by release date. Collapses only the SAME
 *  (tier, major, minor, date) — e.g. the `us.`/`global.` forms of one model — to
 *  its preferred id form. `preferredTier=null` ⇒ most capable, newest overall. */
export function orderCandidates(ids: readonly string[], preferredTier: ClaudeTier | null): string[] {
  const parsed = ids.map(parseClaudeModel).filter((m): m is ClaudeModelId => m !== null);

  const byVersion = new Map<string, ClaudeModelId>();
  for (const m of parsed) {
    const key = `${m.tier}-${m.major}.${m.minor}.${m.date}`;
    const cur = byVersion.get(key);
    if (!cur || prefixRank(m.id) < prefixRank(cur.id)) byVersion.set(key, m);
  }

  return [...byVersion.values()]
    .sort((a, b) => {
      const aPref = preferredTier !== null && a.tier === preferredTier;
      const bPref = preferredTier !== null && b.tier === preferredTier;
      if (aPref !== bPref) return aPref ? -1 : 1; // preferred tier first
      if (a.tier !== b.tier) return TIER_RANK[b.tier] - TIER_RANK[a.tier]; // most capable first
      if (a.major !== b.major) return b.major - a.major; // newest major first
      if (a.minor !== b.minor) return b.minor - a.minor; // newest minor first
      if (a.date !== b.date) return b.date - a.date; // newest dated snapshot first
      return prefixRank(a.id) - prefixRank(b.id);
    })
    .map((m) => m.id);
}

/** Lists the invokable Bedrock model ids (best-first is the caller's job). Injected
 *  so selection stays pure and tests hit no AWS. */
export type ProfileLister = () => Promise<string[]>;

/** Real lister: every Anthropic Claude inference profile in the region, paginated. */
export function bedrockProfileLister(region: string): ProfileLister {
  return async () => {
    // maxAttempts: 1 — don't retry; a missing grant / no creds should fail fast so
    // the client falls back to static candidates without stalling (see withTimeout).
    const client = new BedrockClient({ region, maxAttempts: 1 });
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const out = await client.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken }));
      for (const summary of out.inferenceProfileSummaries ?? []) {
        const id = summary.inferenceProfileId;
        if (id && /anthropic\.claude/.test(id)) ids.push(id);
      }
      nextToken = out.nextToken;
    } while (nextToken);
    return ids;
  };
}
