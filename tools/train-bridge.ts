// Persistent numeric decisions over Territory's pure production simulator.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { newGame, isFinished, scoreGame, stepTurn } from "../src/shared/engine/game.js";
import type { GameState, Variant } from "../src/shared/engine/types.js";
import { rejectionReason } from "../src/shared/engine/resolve.js";
import type { Submission } from "../src/shared/engine/orders.js";
import { observe, type TerritoryObservation } from "../src/game/redact.js";
import { scriptedDecide } from "../src/game/scripted.js";
import { SYSTEM_PROMPT, renderObservation } from "../src/game/prompt.js";

const [manifestPath, variantArg] = process.argv.slice(2);
if (!manifestPath || !variantArg) throw new Error("usage: node train-bridge.mjs MANIFEST VARIANT");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  variants: Array<{ id: Variant; game_config: { num_agents: number; turns: number } }>;
};
const variant = variantArg as Variant;
const config = manifest.variants.find((entry) => entry.id === variant)?.game_config;
if (!config || config.num_agents !== 9) throw new Error(`unknown certified variant: ${variantArg}`);

class Bridge {
  state!: GameState;
  pending: number[] = [];
  submissions: Record<number, Submission> = {};
  decisionId = 0;
  seed = 0;
  catalogCache: Array<Submission | null> | null = null;

  get seat(): number {
    return this.pending[0]!;
  }

  get view(): TerritoryObservation {
    return observe(this.state, this.seat);
  }

  catalog(): Array<Submission | null> {
    if (this.catalogCache !== null) return this.catalogCache;
    const view = this.view;
    const choices: Submission[] = [
      { orders: [], messages: [] },
      scriptedDecide("homesteader", view),
      scriptedDecide("raider", view),
    ];
    for (const tile of Object.keys(this.state.tiles).sort()) {
      choices.push({ orders: [{ type: "claim", tile }], messages: [] });
    }
    for (const tile of Object.keys(this.state.tiles).sort()) {
      choices.push({ orders: [{ type: "raze", tile }], messages: [] });
    }
    for (const cog of view.cogs) {
      if (cog.seat === this.seat) continue;
      for (const amount of [1, 5, 10, 20]) {
        choices.push({ orders: [{ type: "transfer", to: cog.alias, amount }], messages: [] });
      }
    }
    this.catalogCache = choices.map((choice) =>
      rejectionReason(this.state, this.seat, choice.orders) === null ? choice : null);
    return this.catalogCache;
  }

  current(): object {
    const view = this.view;
    return {
      kind: "decision", game: "territory", decision_id: this.decisionId,
      seat: this.seat, engine_seat: this.seat, turn: this.state.turn,
      semantic_view: view, inbox: [],
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: renderObservation(view) },
      ],
      speech_messages: [],
      action_schema: { type: "object", properties: {
        choice: { type: "integer", minimum: 0, maximum: this.catalog().length - 1 },
      }, required: ["choice"] },
      typed_question: null,
    };
  }

  encode(): object {
    const view = this.view;
    const values: number[] = [];
    for (const name of ["open", "rooms", "inside_out"]) values.push(Number(variant === name));
    for (let seat = 0; seat < 9; seat++) values.push(Number(this.seat === seat));
    values.push(view.turn / view.turns);
    values.push(view.you.paint / 100, view.you.walls / 169,
      view.you.incomeLastTurn / 100, view.you.banked / 1000,
      Number(view.you.state !== "eliminated"));
    for (const cog of view.cogs) {
      values.push(cog.walls / 169, cog.incomeLastTurn / 100,
        cog.banked / 1000, cog.razesMade / 169, Number(cog.alive));
    }
    const alias = new Map(view.cogs.map((cog) => [cog.alias, cog.seat + 1]));
    for (const tile of view.tiles) {
      values.push(["wall", "cracked", "rubble"].indexOf(tile.state) / 2,
        tile.yield / 3, (alias.get(tile.owner ?? "") ?? 0) / 9,
        Number(tile.wet), (alias.get(tile.hearthOf ?? "") ?? 0) / 9);
    }
    if (values.length !== 908) throw new Error(`numeric view changed: ${values.length}`);
    return { decision_id: this.decisionId, values,
      actions: this.catalog().map((choice, index) => choice === null ? null : { choice: index }) };
  }

  reset(request: { seed: string; players: number }): object {
    if (request.players !== 9) throw new Error("Territory requires nine seats");
    let hash = 2166136261;
    for (const char of request.seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    this.seed = hash >>> 0;
    this.state = newGame(this.seed, variant, config!.turns);
    this.pending = [...this.state.cogOrder];
    this.submissions = {};
    this.decisionId = 0;
    this.catalogCache = null;
    return this.current();
  }

  teacher(): object {
    return { response: JSON.stringify({ choice: (this.seed + this.seat) % 2 === 0 ? 1 : 2 }) };
  }

  step(request: { decision_id: number; response: string }): object {
    if (request.decision_id !== this.decisionId) throw new Error("stale decision id");
    const action = JSON.parse(request.response) as { choice: number };
    if (Object.keys(action).length !== 1 || !Number.isInteger(action.choice)) {
      throw new Error("action must choose one catalog entry");
    }
    const decision = this.catalog()[action.choice];
    if (!decision) throw new Error("action is masked");
    this.submissions[this.seat] = decision;
    this.pending.shift();
    this.decisionId++;
    this.catalogCache = null;
    if (this.pending.length === 0) {
      this.state = stepTurn(this.state, this.submissions);
      this.submissions = {};
      this.pending = this.state.cogOrder.filter((seat) => this.state.cogs[seat]!.life !== "eliminated");
    }
    const observation = isFinished(this.state)
      ? { kind: "terminal", scores: Object.fromEntries(scoreGame(this.state).map((score, seat) => [seat, score])) }
      : this.current();
    return { kind: "accepted", action, observation };
  }
}

const bridge = new Bridge();
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { kind: string; seed: string; players: number; decision_id: number; response: string };
  const response = request.kind === "reset" ? bridge.reset(request)
    : request.kind === "encode" ? bridge.encode()
    : request.kind === "teacher" ? bridge.teacher()
    : request.kind === "step" ? bridge.step(request)
    : (() => { throw new Error(`unknown command: ${request.kind}`); })();
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
