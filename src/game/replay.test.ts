// TEST 12 — the recorded replay envelope.
//
// This runs a REAL episode: the actual coworld host, nine actual player processes
// over the actual `cogweb.player.v1` websocket bridge, writing the actual
// artifacts through `COGAME_*_URI`. It is the in-process twin of the `docker-smoke`
// job, so a broken frame stream fails here in seconds instead of in CI minutes.
//
// It asserts the envelope parses under `ReplayArtifact`, and independently that
// `players[]`, `config`, `results` and the frame stream are what the viewer needs:
// ONE SNAPSHOT PER TURN plus a terminal snapshot, and every `kind` a member of the
// declared event vocabulary.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReplayArtifact } from "@cogweb/protocol";
import { runCoworldPlayer } from "@cogweb/coworld";

import { runCoworldGame } from "../coworld/server";
import { territoryModule } from "./game";
import type { TerritoryDecision, TerritorySeamState, TerritoryView } from "./game";
import type { TerritoryObservation } from "./redact";
import { rederiveReplay } from "./rederive";
import { applyFrame, emptyStore } from "../client/net/feed";
import { makeCogwebDecoder } from "../client/net/cogweb-feed";
import { scriptedDecide } from "./scripted";
import { EVENT_KINDS } from "../shared/engine/log";
import { MAX_TURNS, SEATS } from "../shared/engine/constants";
import { gameSnapshotSchema } from "../shared/protocol";
import { TerritoryReplay } from "../shared/replay";
import { territoryResultsSchema } from "../coworld/results";

const POLICY_NAMES = [
  "territory-steward",
  "territory-condottiere",
  "territory-homesteader",
  "territory-raider",
  "territory-homesteader",
  "territory-raider",
  "territory-homesteader",
  "territory-raider",
  "territory-homesteader",
];

let work: string;
let replay: unknown;
let results: unknown;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "territory-replay-"));
  process.env.COGAME_RESULTS_URI = `file://${join(work, "results.json")}`;
  process.env.COGAME_SAVE_REPLAY_URI = `file://${join(work, "replay.json")}`;

  const tokens = Array.from({ length: SEATS }, (_, i) => `token-${i}`);
  const handle = await runCoworldGame({
    host: "127.0.0.1",
    port: 0,
    config: {
      tokens,
      num_agents: SEATS,
      players: POLICY_NAMES.map((name) => ({ name })),
      seed: 7,
      variant: "open",
      turns: MAX_TURNS,
      paceMs: 0,
    },
  });

  // Nine real player clients: five homesteaders and four raiders, the cert mix.
  const players = handle.playerUrls.map((url, slot) =>
    runCoworldPlayer<TerritorySeamState, TerritoryDecision, TerritoryView>({
      module: territoryModule,
      connect: url,
      decide: (ctx) => scriptedDecide(slot >= 5 ? "raider" : "homesteader", ctx.view as TerritoryObservation),
    }),
  );

  await handle.finished;
  await Promise.all(players);
  await handle.close();

  replay = JSON.parse(readFileSync(join(work, "replay.json"), "utf8"));
  results = JSON.parse(readFileSync(join(work, "results.json"), "utf8"));
}, 120_000);

afterAll(() => {
  delete process.env.COGAME_RESULTS_URI;
  delete process.env.COGAME_SAVE_REPLAY_URI;
  rmSync(work, { recursive: true, force: true });
});

describe("the recorded replay", () => {
  it("parses under ReplayArtifact and under Territory's own envelope schema", () => {
    expect(() => ReplayArtifact.parse(replay)).not.toThrow();
    expect(() => TerritoryReplay.parse(replay)).not.toThrow();
  });

  it("is strict UTF-8 and round-trips byte-for-byte", () => {
    const bytes = readFileSync(join(work, "replay.json"));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(JSON.parse(text)).toEqual(replay);
  });

  it("carries players[]: alias + policy + player, nine of them", () => {
    const env = TerritoryReplay.parse(replay);
    expect(env.players).toHaveLength(SEATS);
    env.players.forEach((p, i) => {
      expect(p.seat).toBe(i);
      expect(p.alias).toMatch(/^[A-Z]/);
      // The REAL policy name is spectator-side only — it is here, and nowhere in
      // any observation (asserted by the no-alias-leak client test).
      expect(p.policy).toBe(POLICY_NAMES[i]);
      expect(p.player).toBeNull();
    });
    // Nine distinct aliases.
    expect(new Set(env.players.map((p) => p.alias)).size).toBe(SEATS);
  });

  it("carries config: seed, variant, seats, turns and the rule constants", () => {
    const env = TerritoryReplay.parse(replay);
    expect(env.config).toMatchObject({
      seats: SEATS,
      turns: MAX_TURNS,
      variant: "open",
      seed: 7,
      ticksPerTurn: 25,
      razeOpensTurn: 4,
      flingRange: 2,
      salvageMult: 4,
    });
  });

  it("carries results: reason, nine scores, fallbacks and the pool", () => {
    const env = TerritoryReplay.parse(replay);
    const parsed = territoryResultsSchema.parse(env.results);
    expect(parsed).toEqual(territoryResultsSchema.parse(results));
    expect(["complete", "elimination", "deadline"]).toContain(parsed.reason);
    expect(parsed.scores).toHaveLength(SEATS);
    expect(parsed.fallbacks).toHaveLength(SEATS);
    expect(parsed.razes).toHaveLength(SEATS);
    expect(parsed.poolEnd).toBeLessThanOrEqual(parsed.poolStart);
    expect(parsed.turnsPlayed).toBeGreaterThan(0);
    // A local scripted episode reaches the horizon and nobody had to fall back.
    expect(parsed.reason).toBe("complete");
    expect(parsed.turnsPlayed).toBe(MAX_TURNS);
    expect(parsed.fallbacks.reduce((a, b) => a + b, 0)).toBe(0);
    expect(parsed.scores.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("has one snapshot per turn plus a terminal snapshot, and a leading roster", () => {
    const env = TerritoryReplay.parse(replay);
    expect(env.frames[0]).toMatchObject({ type: "lobby" });
    const turns = env.frames
      .filter((f): f is Extract<typeof f, { type: "snapshot" }> => f.type === "snapshot")
      .map((f) => f.snapshot.turn);
    const distinct = [...new Set(turns)].sort((a, b) => a - b);
    // Turns 1..18 plus the terminal snapshot at turn 19.
    expect(distinct).toEqual(Array.from({ length: MAX_TURNS + 1 }, (_, i) => i + 1));
  });

  it("emits only the declared event vocabulary", () => {
    const env = TerritoryReplay.parse(replay);
    const kinds = new Set<string>();
    for (const f of env.frames) if (f.type === "event") kinds.add(f.event.kind);
    expect(kinds.size).toBeGreaterThan(3);
    for (const kind of kinds) expect(EVENT_KINDS).toContain(kind as (typeof EVENT_KINDS)[number]);
    // The endcard is there exactly once, so the final panel needs no derivation.
    const endcards = env.frames.filter((f) => f.type === "event" && f.event.kind === "endcard");
    expect(endcards).toHaveLength(1);
  });

  it("RE-DERIVES every recorded frame from the recorded events, frame by frame", () => {
    // Item 2's property, over the bytes a real episode wrote: feed the recorded
    // EVENTS (the seed in the first snapshot + every seat's recorded submission in
    // its `actPrompt` frame) back through the sim and reproduce the recorded
    // per-turn state exactly. This is the same function `src/client/App.tsx` runs
    // in the browser, so what the viewer draws is this re-derivation, not the
    // recorded snapshots it is checked against.
    const env = TerritoryReplay.parse(replay);
    const derived = rederiveReplay(env.frames);
    expect(derived.mismatch).toBeNull();
    // Turns 1..18 plus the terminal snapshot at turn 19, every one reproduced.
    expect(derived.snapshots).toHaveLength(MAX_TURNS + 1);
    expect(derived.verified).toBe(MAX_TURNS + 1);
    // And the re-derivation is a real re-simulation, not a copy: it never reads a
    // recorded snapshot except to compare, so the states it produced are equal
    // frame by frame to the recorded ones.
    const recorded = new Map<number, unknown>();
    for (const f of env.frames) if (f.type === "snapshot") recorded.set(f.snapshot.turn, f.snapshot.state);
    for (const snap of derived.snapshots) {
      expect(gameSnapshotSchema.parse(recorded.get(snap.turn))).toEqual(gameSnapshotSchema.parse(snap));
    }
  });

  it("and the VIEWER adopts that re-derivation on these bytes", () => {
    // `App.tsx` swaps the store's timeline for the re-derivation only when the
    // re-derivation covers every recorded frame. This is that condition, checked
    // on the real artifact: without it the page would quietly fall back to
    // drawing the recorded snapshots and only the jsdom test would notice.
    const env = TerritoryReplay.parse(replay);
    const store = emptyStore();
    const decode = makeCogwebDecoder();
    for (const frame of env.frames) for (const message of decode(frame)) applyFrame(store, message);
    expect(store.snapshots).toHaveLength(MAX_TURNS + 1);
    expect(rederiveReplay(env.frames).snapshots).toHaveLength(store.snapshots.length);
  });

  it("every snapshot carries the whole board and every seat's public state", () => {
    const env = TerritoryReplay.parse(replay);
    for (const f of env.frames) {
      if (f.type !== "snapshot") continue;
      const state = f.snapshot.state as { tiles: unknown[]; cogs: unknown[]; seed: number };
      expect(state.tiles).toHaveLength(169);
      expect(state.cogs).toHaveLength(SEATS);
      // The seed is in `config` AND in every snapshot.
      expect(state.seed).toBe(7);
    }
  });
});
