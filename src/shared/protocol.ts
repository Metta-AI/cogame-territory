// The single wire/replay contract for the CLIENT: the recorded @cogweb frames are
// decoded into these, so a recording and a live game populate every panel
// identically. Snapshots are full public state; events mirror the engine's
// ResolveEvent | UpkeepEvent one-for-one, validated at the boundary (the replay
// bytes are untrusted input to the browser).
import { z } from "zod";
import { LobbyState } from "@cogweb/protocol";

const tileStateSchema = z.enum(["wall", "cracked", "rubble"]);
const lifeSchema = z.enum(["steady", "staggered", "eliminated"]);
const phaseSchema = z.enum(["commit", "resolve", "upkeep"]);
const variantSchema = z.enum(["open", "rooms", "inside_out"]);
const reasonSchema = z.enum(["complete", "elimination", "deadline"]);

const tileSnapshotSchema = z
  .object({
    q: z.number().int(),
    r: z.number().int(),
    state: tileStateSchema,
    yield: z.number().int(),
    effYield: z.number().int(),
    owner: z.number().int().nullable(),
    wet: z.boolean(),
    hearthOf: z.number().int().nullable(),
  })
  .strict();

const cogSnapshotSchema = z
  .object({
    seat: z.number().int(),
    alias: z.string(),
    life: lifeSchema,
    paint: z.number().int(),
    banked: z.number().int(),
    walls: z.number().int(),
    incomeLastTurn: z.number().int(),
    razesMade: z.number().int(),
    fallbacks: z.number().int(),
  })
  .strict();

export const gameSnapshotSchema = z
  .object({
    version: z.string(),
    seed: z.number(),
    turn: z.number().int(),
    turns: z.number().int(),
    phase: phaseSchema,
    variant: variantSchema,
    radius: z.number().int(),
    ticksPerTurn: z.number().int(),
    razeOpensTurn: z.number().int(),
    flingRange: z.number().int(),
    salvageMult: z.number().int(),
    poolStart: z.number(),
    poolEnd: z.number(),
    destroyed: z.number().int(),
    warsStarted: z.number().int(),
    settled: reasonSchema.nullable(),
    tiles: z.array(tileSnapshotSchema),
    cogs: z.array(cogSnapshotSchema),
  })
  .strict();

const orderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("claim"), tile: z.string() }).strict(),
  z.object({ type: z.literal("raze"), tile: z.string() }).strict(),
  z.object({ type: z.literal("transfer"), to: z.string(), amount: z.number().int() }).strict(),
]);

/** Every `kind` the engine emits — the WHOLE vocabulary the viewer draws from. */
export const turnEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), seat: z.number().int(), order: orderSchema, cost: z.number().int() }).strict(),
  z.object({ kind: z.literal("rejected"), seat: z.number().int(), reason: z.string() }).strict(),
  z.object({ kind: z.literal("talk"), seat: z.number().int(), to: z.number().int().nullable(), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("raze"),
      seat: z.number().int(),
      tile: z.string(),
      from_state: tileStateSchema,
      to_state: tileStateSchema,
      victim: z.number().int().nullable(),
      yield_before: z.number().int(),
      yield_after: z.number().int(),
    })
    .strict(),
  z.object({ kind: z.literal("salvage"), seat: z.number().int(), tile: z.string(), paint: z.number().int() }).strict(),
  z.object({ kind: z.literal("struck"), seat: z.number().int(), by: z.array(z.number().int()) }).strict(),
  z.object({ kind: z.literal("claim"), seat: z.number().int(), tile: z.string(), yield: z.number().int() }).strict(),
  z.object({ kind: z.literal("smear"), tile: z.string(), seats: z.array(z.number().int()) }).strict(),
  z
    .object({ kind: z.literal("voided"), seat: z.number().int(), tile: z.string(), reason: z.enum(["rubble", "owned"]) })
    .strict(),
  z
    .object({ kind: z.literal("transfer"), from: z.number().int(), to: z.number().int(), amount: z.number().int() })
    .strict(),
  z.object({ kind: z.literal("dried"), tiles: z.array(z.string()) }).strict(),
  z
    .object({ kind: z.literal("income"), seat: z.number().int(), paint: z.number().int(), walls: z.number().int() })
    .strict(),
  z.object({ kind: z.literal("recovered"), seat: z.number().int() }).strict(),
  z.object({ kind: z.literal("eliminated"), seat: z.number().int(), tilesReverted: z.number().int() }).strict(),
  z
    .object({
      kind: z.literal("endcard"),
      reason: reasonSchema,
      turnsPlayed: z.number().int(),
      scores: z.array(z.number()),
      walls: z.array(z.number().int()),
      destroyed: z.number().int(),
      poolStart: z.number(),
      poolEnd: z.number(),
      warsStarted: z.number().int(),
    })
    .strict(),
]);

export const messageSchema = z
  .object({
    seq: z.number().int(),
    turn: z.number().int(),
    from: z.number().int(),
    to: z.union([z.literal("public"), z.number().int()]),
    text: z.string(),
  })
  .strict();

export const serverStatusSchema = z
  .object({
    turn: z.number().int(),
    phase: phaseSchema,
    finished: z.boolean(),
    cogCount: z.number().int(),
    pending: z.array(z.number().int()).default([]),
    done: z.array(z.number().int()).default([]),
    phaseDeadlineAt: z.number().optional(),
    turnLimit: z.number().int().optional(),
    started: z.boolean().optional(),
    ended: z.boolean().optional(),
    /** Seat -> real policy/player name, from the one-shot `lobby` roster frame.
     *  SPECTATOR-SIDE ONLY: the agents only ever saw the alias. */
    roster: z.array(z.object({ seat: z.number().int(), name: z.string() }).strict()).optional(),
  })
  .strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: gameSnapshotSchema }).strict(),
  z.object({ type: z.literal("event"), event: turnEventSchema, turn: z.number().int() }).strict(),
  z.object({ type: z.literal("serverStatus"), status: serverStatusSchema }).strict(),
  z
    .object({
      type: z.literal("actPrompt"),
      seat: z.number().int(),
      turn: z.number().int(),
      usedFallback: z.boolean(),
      model: z.string().nullable(),
      content: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("message"), message: messageSchema }).strict(),
  z.object({ type: z.literal("lobby"), lobby: LobbyState }).strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerStatus = z.infer<typeof serverStatusSchema>;
export type ClientTurnEvent = z.infer<typeof turnEventSchema>;
