import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseJsonAction } from "@cogweb/llm";
import { territoryGame, type TerritorySeamState } from "./game.js";
import { renderPlayerMessages, SUBMISSION_JSON_SCHEMA } from "./prompt.js";
import { scriptedDecide } from "./scripted.js";
import type { TerritoryObservation } from "./redact.js";
import { SubmissionSchema, type Submission } from "../shared/engine/orders.js";
import { rejectionReason } from "../shared/engine/resolve.js";

/** Uses the ordinary production renderer, parser, legality gate and engine. */
export class TrainingSession {
  private state: TerritorySeamState;
  private decisionId = 0;
  private reason: string | null = null;
  private parseReason: string | null = null;
  private localAttempts = 0;
  private hostAttempts = 0;
  constructor(
    seed: string,
    players: number,
    private readonly doctrine: string,
  ) {
    if (players !== 9) throw new Error("Territory requires nine players");
    this.state = territoryGame.newGame({
      seed,
      playerCount: players,
      seatNames: Array.from({ length: players }, (_, seat) => `seat ${seat}`),
    });
  }
  observation() {
    if (territoryGame.isFinished(this.state))
      return { kind: "terminal" as const, scores: territoryGame.score(this.state) };
    const seat = territoryGame.pendingActors(this.state)[0]!;
    const view = territoryGame.redact(this.state, seat) as TerritoryObservation;
    return {
      kind: "decision" as const,
      game: "territory",
      decision_id: this.decisionId,
      seat,
      engine_seat: seat,
      turn: territoryGame.turnOf(this.state),
      inference_mode: "text_action" as const,
      semantic_view: view,
      inbox: [],
      messages: renderPlayerMessages(view, this.doctrine, this.reason).map((message) =>
        message.role === "user" && this.parseReason
          ? { ...message, content: message.content + `\n\n${this.parseReason}` }
          : message,
      ),
      speech_messages: [],
      action_schema: SUBMISSION_JSON_SCHEMA,
      typed_question: null,
    };
  }
  teacher() {
    const observation = this.observation();
    if (observation.kind !== "decision") throw new Error("No decision remains");
    return { response: JSON.stringify(scriptedDecide("homesteader", observation.semantic_view)) };
  }
  step(decisionId: number, response: string) {
    const current = this.observation();
    if (current.kind !== "decision" || decisionId !== this.decisionId)
      return { kind: "rejected" as const, reason: "stale decision", observation: current };
    this.localAttempts++;
    const json = parseJsonAction(response);
    if (json.kind === "rejected") {
      return this.rejectParse(json.reason);
    }
    const parsed = SubmissionSchema.safeParse(json.value);
    if (!parsed.success) {
      return this.rejectParse(parsed.error.message);
    }
    this.parseReason = null;
    this.localAttempts = 0;
    this.reason = rejectionReason(this.state.engine, current.seat, parsed.data.orders);
    if (this.reason !== null) {
      this.hostAttempts++;
      if (this.hostAttempts >= 2)
        return this.apply(territoryGame.baselineDecision(this.state, current.seat), this.reason);
      return { kind: "rejected" as const, reason: this.reason, observation: this.observation() };
    }
    return this.apply(parsed.data, null);
  }
  private rejectParse(reason: string) {
    this.parseReason = reason;
    if (this.localAttempts < 2)
      return { kind: "rejected" as const, reason, observation: this.observation() };
    const current = this.observation();
    if (current.kind !== "decision") throw new Error("Fallback requires a live turn");
    return this.apply(
      { ...scriptedDecide("homesteader", current.semantic_view), fallback: true },
      reason,
    );
  }
  private apply(action: Submission, consumedReason: string | null) {
    const seat = territoryGame.pendingActors(this.state)[0]!;
    this.state = territoryGame.applyDecision(this.state, seat, action).state;
    this.decisionId++;
    this.reason = null;
    this.parseReason = null;
    this.localAttempts = 0;
    this.hostAttempts = 0;
    return consumedReason === null
      ? { kind: "accepted" as const, action, observation: this.observation() }
      : {
          kind: "consumed_rejection" as const,
          reason: consumedReason,
          action,
          observation: this.observation(),
        };
  }
}

const Command = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reset"),
    seed: z.string(),
    players: z.number().int(),
    doctrine: z.string().default(""),
  }),
  z.object({ kind: z.literal("teacher") }),
  z.object({ kind: z.literal("step"), decision_id: z.number().int(), response: z.string() }),
]);
export async function runTrainingBridge(): Promise<void> {
  let session: TrainingSession | undefined;
  for await (const line of createInterface({ input: process.stdin })) {
    const command = Command.parse(JSON.parse(line));
    if (command.kind === "reset")
      session = new TrainingSession(command.seed, command.players, command.doctrine);
    if (!session) throw new Error("reset required");
    const response =
      command.kind === "reset"
        ? session.observation()
        : command.kind === "teacher"
          ? session.teacher()
          : session.step(command.decision_id, command.response);
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
if (realpathSync(argv[1]!) === fileURLToPath(import.meta.url)) await runTrainingBridge();
