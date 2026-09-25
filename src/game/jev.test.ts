import { afterEach, describe, expect, it, vi } from "vitest";

import { newGame, stepTurn } from "../shared/engine/game.js";
import { rejectionReason } from "../shared/engine/resolve.js";
import { SubmissionSchema, type Submission } from "../shared/engine/orders.js";
import { territoryModule } from "./game.js";
import { makeJevDecide } from "./jev.js";
import { observe } from "./redact.js";
import { homesteader } from "./scripted.js";

describe("ordinary Territory Jev player", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers complete legal orders from the private view and returns an ordinary reply", async () => {
    let state = newGame(17);
    for (let turn = 0; turn < 5; turn++) {
      const submissions: Record<number, Submission> = {};
      for (const seat of state.cogOrder) {
        if (state.cogs[seat]!.life !== "eliminated") submissions[seat] = homesteader(observe(state, seat));
      }
      state = stepTurn(state, submissions);
    }
    const view = observe(state, 0);
    let calls = 0;
    const decide = makeJevDecide("homesteader", {
      systemOne: async (request, slot) => {
        calls++;
        expect(slot).toBe(0);
        const sent = JSON.parse(request.state as string);
        expect(sent.view).toEqual(view);
        expect(sent.view.cogs).toEqual(view.cogs);
        const plan = request.questions.plan;
        const talk = request.questions.talk;
        expect(plan?.type).toBe("choice");
        expect(talk?.type).toBe("choice");
        if (plan?.type !== "choice" || talk?.type !== "choice") throw new Error("missing Jev choices");
        const plans = Object.entries(plan.criteria);
        expect(plans.length).toBeGreaterThan(3);
        for (const [, orders] of plans) {
          const decision = SubmissionSchema.parse({ orders: JSON.parse(orders as string), messages: [] });
          expect(rejectionReason(state, 0, decision.orders)).toBeNull();
        }
        const chosenPlan = plans.find(([, orders]) => (JSON.parse(orders as string) as unknown[]).length > 0)![0];
        const chosenTalk = Object.keys(talk.criteria).at(-1)!;
        return {
          model: "stub",
          answers: {
            plan: { type: "choice" as const, choice: chosenPlan, confidence: 1, probabilities: {} },
            talk: { type: "choice" as const, choice: chosenTalk, confidence: 1, probabilities: {} },
          },
          usage: {},
        };
      },
    });
    const decision = await decide({
      view,
      seat: 0,
      turn: state.turn,
      messages: [],
      reason: null,
      timeLeftMs: null,
      config: {},
      module: territoryModule,
    });
    expect(calls).toBe(1);
    expect(decision.orders.length).toBeGreaterThan(0);
    expect(decision.messages).toHaveLength(1);
    expect(rejectionReason(state, 0, decision.orders)).toBeNull();
  });

  it("marks a credential-free Jev turn as an explicit scripted fallback", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const state = newGame(5);
    const view = observe(state, 0);
    const decision = await makeJevDecide("homesteader")({
      view,
      seat: 0,
      turn: state.turn,
      messages: [],
      reason: null,
      timeLeftMs: null,
      config: {},
      module: territoryModule,
    });
    expect(decision.fallback).toBe(true);
    expect(rejectionReason(state, 0, decision.orders)).toBeNull();
  });

  it("keeps the player alive and reports fallback when inference fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = newGame(5);
    const view = observe(state, 0);
    const decision = await makeJevDecide("homesteader", {
      systemOne: async () => { throw new Error("provider down"); },
    })({
      view,
      seat: 0,
      turn: state.turn,
      messages: [],
      reason: null,
      timeLeftMs: null,
      config: {},
      module: territoryModule,
    });
    expect(decision.fallback).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("jev_inference_error"));
    errors.mockRestore();
  });
});
