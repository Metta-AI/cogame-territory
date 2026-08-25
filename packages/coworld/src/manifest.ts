// The coworld manifest: the document a game publishes so the Softmax platform
// can run it. It declares the container runnables (the game server, one or more
// player policies, and a commissioner) plus JSON-Schema contracts for the
// per-episode config and results. Genericized from cognames'
// coworld_manifest_template.json — a game supplies its id, schemas, players,
// docs, and variants; everything structural lives here.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A JSON Schema (draft 2020-12) object, carried opaquely in the manifest. */
export const JsonSchema = z.object({}).passthrough();
export type JsonSchema = z.infer<typeof JsonSchema>;

/** A typed reference: inline text or a URL, used for docs/protocols. */
export const ContentRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("uri"), value: z.string().url() }),
]);
export type ContentRef = z.infer<typeof ContentRef>;

export const DocPage = z.object({
  id: z.string(),
  title: z.string(),
  content: ContentRef,
});
export type DocPage = z.infer<typeof DocPage>;

/**
 * Optional compute profile mirrored into the platform's Kubernetes pod spec. Values are k8s
 * quantity strings (e.g. "8", "512Mi"). Only the player role honors a CPU `limit` today: it caps
 * every player pod at that many cores and pins its math-library thread pools to match, so a player
 * behaves the same on any node size. Omitted, players get no limit and may burst to the whole node.
 */
export const RunnableResources = z.object({
  requests: z
    .object({
      cpu: z.string().optional(),
      memory: z.string().optional(),
    })
    .optional(),
  limits: z
    .object({
      cpu: z.string().optional(),
    })
    .optional(),
});
export type RunnableResources = z.infer<typeof RunnableResources>;

/** How a container is launched: image + argv (+ any fixed environment). */
export const Runnable = z.object({
  type: z.enum(["game", "player", "commissioner"]),
  image: z.string(),
  run: z.array(z.string()).min(1),
  /** Fixed environment for this runnable. A single image ships every policy and
   *  is switched by env (e.g. PLAYER_SCRIPTED / PLAYER_PROMPT), so the manifest —
   *  not the argv — is what tells the dispatcher (and `tools/ci/docker_smoke.sh`)
   *  which policy a certification slot runs. */
  env: z.record(z.string(), z.string()).optional(),
  source_url: z.string().url().optional(),
  resources: RunnableResources.optional(),
});
export type Runnable = z.infer<typeof Runnable>;

/** The game runnable carries its config/results contracts and docs. */
export const GameRunnable = Runnable.extend({
  type: z.literal("game"),
});
export type GameRunnable = z.infer<typeof GameRunnable>;

export const GameSection = z.object({
  name: z.string(),
  description: z.string(),
  owner: z.string(),
  runnable: GameRunnable,
  replay_viewer: z.object({ bundle: z.string().min(1) }).optional(),
  config_schema: JsonSchema,
  results_schema: JsonSchema,
  protocols: z.record(z.string(), ContentRef).default({}),
  docs: z
    .object({
      readme: ContentRef.optional(),
      pages: z.array(DocPage).default([]),
    })
    .default({ pages: [] }),
});
export type GameSection = z.infer<typeof GameSection>;

/** A selectable player policy (baseline, LLM, …). */
export const PlayerRunnable = Runnable.extend({
  type: z.literal("player"),
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
});
export type PlayerRunnable = z.infer<typeof PlayerRunnable>;

export const CommissionerRunnable = z.object({
  type: z.literal("commissioner"),
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  image: z.string(),
  run: z.array(z.string()).optional(),
  source_url: z.string().url().optional(),
});
export type CommissionerRunnable = z.infer<typeof CommissionerRunnable>;

/** A named preset of game config the platform can offer. */
export const Variant = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  game_config: z.record(z.string(), z.unknown()),
});
export type Variant = z.infer<typeof Variant>;

/** The offline certification run: a config plus the players for each slot. */
export const Certification = z.object({
  game_config: z.record(z.string(), z.unknown()),
  players: z.array(z.object({ player_id: z.string() })),
});
export type Certification = z.infer<typeof Certification>;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export const CoworldManifest = z.object({
  $schema: z.string().url().optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** Wall-clock budget the platform gives one episode of this coworld, in
   *  minutes. TOP LEVEL (not under `game`) — that is where the dispatcher reads
   *  it. A game whose host settles inside 60 % of this can never overrun. */
  episode_timeout_minutes: z.number().int().positive().optional(),
  game: GameSection,
  player: z.array(PlayerRunnable).min(1),
  commissioner: z.array(CommissionerRunnable).default([]),
  reporter: z.array(z.unknown()).default([]),
  grader: z.array(z.unknown()).default([]),
  diagnoser: z.array(z.unknown()).default([]),
  optimizer: z.array(z.unknown()).default([]),
  variants: z.array(Variant).default([]),
  certification: Certification.optional(),
});
export type CoworldManifest = z.infer<typeof CoworldManifest>;

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

/**
 * Inputs a game supplies to assemble its manifest. The game owns its id,
 * description, schemas (typically from `zod-to-json-schema` over its config and
 * results models), player policies, docs, and variants; this module supplies
 * the structure and validates the result.
 */
export interface BuildManifestOpts {
  /** Stable game id, e.g. "cognames". Used as the game `name`. */
  id: string;
  description: string;
  owner: string;
  /** Container image for the game + bundled player runnables. */
  gameImage: string;
  /** argv for the game server runnable. */
  gameRun: string[];
  sourceUrl?: string;
  /** Discovery tags for the Coworld catalog; certification requires at least three. */
  tags?: string[];
  /** Wall-clock budget for one episode, in minutes (top-level in the manifest). */
  episodeTimeoutMinutes?: number;
  /** Package-relative static replay bundle built by `tools/build_replay_viewer.sh`. */
  replayViewerBundle?: string;
  /** JSON Schema for the per-episode config (seed/playerCount/…). */
  configSchema: JsonSchema;
  /** JSON Schema for the results artifact (scores/replayUri/…). */
  resultsSchema: JsonSchema;
  /** Player policies; at least one (the certifying baseline). */
  players: PlayerRunnable[];
  commissioners?: CommissionerRunnable[];
  protocols?: Record<string, ContentRef>;
  readme?: ContentRef;
  docs?: DocPage[];
  variants?: Variant[];
  certification?: Certification;
  schemaUrl?: string;
}

/** Assemble and validate a coworld manifest for a game. */
export function buildManifest(opts: BuildManifestOpts): CoworldManifest {
  return CoworldManifest.parse({
    $schema: opts.schemaUrl,
    tags: opts.tags,
    episode_timeout_minutes: opts.episodeTimeoutMinutes,
    game: {
      name: opts.id,
      description: opts.description,
      owner: opts.owner,
      runnable: {
        type: "game",
        image: opts.gameImage,
        run: opts.gameRun,
        source_url: opts.sourceUrl,
      },
      replay_viewer: opts.replayViewerBundle ? { bundle: opts.replayViewerBundle } : undefined,
      config_schema: opts.configSchema,
      results_schema: opts.resultsSchema,
      protocols: opts.protocols ?? {},
      docs: { readme: opts.readme, pages: opts.docs ?? [] },
    },
    player: opts.players,
    commissioner: opts.commissioners ?? [],
    variants: opts.variants ?? [],
    certification: opts.certification,
  });
}
