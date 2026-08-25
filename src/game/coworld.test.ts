// The manifest template is GENERATED (`pnpm emit-manifest`) from
// `buildTerritoryManifest()`. This test is what makes that true: it fails the
// build the moment the committed file drifts from the generator, so nobody can
// hand-edit the one document `coworld build` reads at release time.
//
// It also pins the facts phases 40/50/60 depend on by name: nine seats EVERYWHERE,
// bounded arrays in both schemas, the static replay bundle, both protocol docs,
// every declared runnable seated in the certification fixture, and the policy set.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildTerritoryManifest } from "./coworld";
import { MAX_TURNS, SEATS } from "../shared/engine/constants";

const committed = JSON.parse(readFileSync(new URL("../../coworld_manifest_template.json", import.meta.url), "utf8"));
const policies = JSON.parse(readFileSync(new URL("../../tools/ci/policies.json", import.meta.url), "utf8")) as Array<{
  name: string;
  run: string;
  env: Record<string, string>;
  player?: string;
}>;

const PINNED_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Every array-typed property of a JSON Schema object, recursively. */
function arrayProps(schema: unknown, path = "", out: string[] = []): string[] {
  if (typeof schema !== "object" || schema === null) return out;
  const s = schema as Record<string, unknown>;
  if (s.type === "array") {
    if (typeof s.minItems !== "number" || typeof s.maxItems !== "number") out.push(path);
  }
  for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
    arrayProps(v, `${path}.${k}`, out);
  }
  if (s.items) arrayProps(s.items, `${path}[]`, out);
  return out;
}

describe("coworld_manifest_template.json", () => {
  it("is exactly the generator's output", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildTerritoryManifest())));
  });

  it("names the game `territory` — no underscore, so the secret namespace matches", () => {
    expect(committed.game.name).toBe("territory");
    expect(committed.game.runnable.type).toBe("game");
    expect(committed.game.runnable.image).toBe("{{TERRITORY_IMAGE}}");
    expect(committed.game.runnable.run).toEqual(["/bin/territory"]);
    expect(committed.tags).toEqual(["board", "territory", "mixed-motive", "negotiation"]);
    expect(committed.episode_timeout_minutes).toBe(20);
  });

  it("declares the STATIC replay bundle, never a pod viewer", () => {
    expect(committed.game.replay_viewer).toEqual({ bundle: "build/static-replay-viewer" });
  });

  it("bounds EVERY array in both schemas (the cert validator rejects an unbounded one)", () => {
    expect(arrayProps(committed.game.config_schema, "config")).toEqual([]);
    expect(arrayProps(committed.game.results_schema, "results")).toEqual([]);
    expect(committed.game.config_schema.properties.tokens.minItems).toBe(SEATS);
    expect(committed.game.config_schema.properties.tokens.maxItems).toBe(SEATS);
    expect(committed.game.config_schema.properties.players.minItems).toBe(SEATS);
    expect(committed.game.config_schema.properties.players.maxItems).toBe(SEATS);
    expect(committed.game.results_schema.required).toEqual(["scores", "reason"]);
    expect(committed.game.results_schema.properties.reason.enum).toEqual([
      "complete",
      "elimination",
      "deadline",
    ]);
    expect(committed.game.results_schema.additionalProperties).toBe(false);
  });

  it("puts num_agents = 9 in EVERY variant and in the certification fixture", () => {
    expect(committed.variants.map((v: { id: string }) => v.id)).toEqual(["open", "rooms", "inside_out"]);
    for (const v of committed.variants) {
      expect(v.game_config.num_agents).toBe(SEATS);
      expect(v.game_config.players).toHaveLength(SEATS);
      expect(v.game_config.turns).toBe(MAX_TURNS);
      expect(v.description.length).toBeGreaterThan(0);
      // No pinned seed in a variant: a fresh board per league episode.
      expect(v.game_config.seed).toBeUndefined();
    }
    expect(committed.certification.game_config.num_agents).toBe(SEATS);
    expect(committed.certification.game_config.seed).toBe(7);
    expect(committed.certification.game_config.paceMs).toBe(0);
    expect(committed.certification.game_config.players).toHaveLength(SEATS);
    expect(committed.certification.players).toHaveLength(SEATS);
  });

  it("seats BOTH declared runnables in the certification fixture (homesteader x5, raider x4)", () => {
    const declared = committed.player.map((p: { id: string }) => p.id).sort();
    expect(declared).toEqual(["territory-homesteader", "territory-raider"]);
    const seated = committed.certification.players.map((p: { player_id: string }) => p.player_id);
    expect(seated.filter((id: string) => id === "territory-homesteader")).toHaveLength(5);
    expect(seated.filter((id: string) => id === "territory-raider")).toHaveLength(4);
    for (const id of declared) expect(seated).toContain(id);
    // Both run the ONE entrypoint and are switched by env.
    for (const p of committed.player) {
      expect(p.run).toEqual(["/bin/territory-player"]);
      expect(p.image).toBe("{{TERRITORY_IMAGE}}");
      expect(Object.keys(p.env)).toEqual(["PLAYER_SCRIPTED"]);
      expect(p.description.length).toBeGreaterThan(20);
    }
  });

  it("ships BOTH protocol docs and a readme plus three pages", () => {
    expect(Object.keys(committed.game.protocols).sort()).toEqual(["global", "player"]);
    for (const doc of Object.values(committed.game.protocols) as Array<{ type: string; value: string }>) {
      expect(doc.type).toBe("text");
      expect(doc.value.length).toBeGreaterThan(200);
    }
    expect(committed.game.docs.readme.type).toBe("uri");
    expect(committed.game.docs.pages.map((p: { id: string }) => p.id)).toEqual([
      "rules.md",
      "strategy.md",
      "deadweight.md",
    ]);
  });
});

describe("tools/ci/policies.json", () => {
  it("is two LLM champions plus two scripted fillers, all from the same image", () => {
    expect(policies).toHaveLength(4);
    expect(policies.map((p) => p.name)).toEqual([
      "territory-steward",
      "territory-condottiere",
      "territory-homesteader",
      "territory-raider",
    ]);
    for (const p of policies) expect(p.run).toBe("/bin/territory-player");
    // Four DISTINCT policy bodies: identical content dedupes on upload.
    expect(new Set(policies.map((p) => JSON.stringify(p.env))).size).toBe(4);
  });

  it("both champions are PLAYER_PROMPT with USE_BEDROCK and the PINNED model", () => {
    for (const name of ["territory-steward", "territory-condottiere"]) {
      const p = policies.find((x) => x.name === name)!;
      expect(p.env.PLAYER_PROMPT!.length).toBeGreaterThan(200);
      // USE_BEDROCK is NOT optional: the platform gates the player pod's Bedrock
      // sidecar on it, and without it a PLAYER_PROMPT seat silently plays scripted.
      expect(p.env.USE_BEDROCK).toBe("true");
      expect(p.env.BEDROCK_MODEL).toBe(PINNED_MODEL);
      expect(p.env.PLAYER_SCRIPTED).toBeUndefined();
    }
  });

  it("champion #2 carries the daveey-1 player id so the version is owned by it", () => {
    const champ2 = policies.find((p) => p.name === "territory-condottiere")!;
    expect(champ2.player).toBe("ply_bac48eb1-662e-44f8-973d-f3e016dccf5d");
    // Nobody else does: a version uploaded as daveey cannot later be submitted as
    // daveey-1 (409 "already assigned to player").
    expect(policies.filter((p) => p.player !== undefined)).toHaveLength(1);
  });

  it("the two fillers are the scripted baselines, and their names match the manifest", () => {
    const fillers = policies.filter((p) => p.env.PLAYER_SCRIPTED !== undefined);
    expect(fillers.map((p) => p.env.PLAYER_SCRIPTED)).toEqual(["homesteader", "raider"]);
    for (const f of fillers) expect(f.env.PLAYER_PROMPT).toBeUndefined();
  });
});
