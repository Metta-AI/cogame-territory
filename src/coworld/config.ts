// The per-episode coworld config the platform injects at `COGAME_CONFIG_URI`.
// The shape mirrors `src/game/coworld.ts`'s `config_schema` (the manifest
// contract). This is the FIXED NINE-SEAT Territory coworld: the runner injects
// one `tokens` entry per slot, and the platform overwrites `players[].name` with
// the seated policy/player names at dispatch — those names are used ONLY for the
// roster frame and the replay envelope; the agents themselves only ever see the
// nine fixed anonymous aliases.
import { z } from "zod";
import { BATCH_MIN_MS, MAX_TURNS, SEATS } from "../shared/engine/constants.js";

/** The fixed seat count of this coworld package. Nine, everywhere. */
export const COWORLD_SEATS = SEATS;

export const coworldConfigSchema = z
  .object({
    tokens: z.array(z.string().min(1)).length(COWORLD_SEATS),
    // The league ladder injects num_agents (= the fixed seat count) into every
    // episode's game_config to size the round; the host is fixed at nine seats,
    // so it only has to TOLERATE the key — a .strict() schema WITHOUT it crashes
    // the host on every league episode.
    num_agents: z.literal(COWORLD_SEATS).optional(),
    players: z.array(z.object({ name: z.string().min(1) }).strict()).length(COWORLD_SEATS),
    /** Present -> a reproducible board (the cert fixture pins one); absent -> a
     *  fresh random board each episode (the league default). */
    seed: z.number().int().optional(),
    variant: z.enum(["open", "rooms", "inside_out"]).optional(),
    /** Floor on the spacing between batch starts. The cert fixture pins 0. */
    paceMs: z.number().int().nonnegative().optional(),
    /** Turn horizon; exists so the cert fixture can pin it. */
    turns: z.number().int().positive().optional(),
  })
  .strict();

export type CoworldConfig = z.infer<typeof coworldConfigSchema>;

export const configVariant = (c: CoworldConfig): "open" | "rooms" | "inside_out" => c.variant ?? "open";
export const configTurns = (c: CoworldConfig): number => c.turns ?? MAX_TURNS;
export const configPaceMs = (c: CoworldConfig): number => c.paceMs ?? BATCH_MIN_MS;
