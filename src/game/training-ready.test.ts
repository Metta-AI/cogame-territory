import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCoworldPlayer } from "@cogweb/coworld";
import { runCoworldGame } from "../coworld/server.js";
import { territoryModule } from "./game.js";
import { TrainingSession } from "./training-bridge.js";
import { makeLlmDecide } from "./player.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("completes the real nine-seat production loop with exact private attempts and redacted public replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "territory-training-"));
  vi.stubEnv("COGAME_RESULTS_URI", join(directory, "results.json"));
  vi.stubEnv("COGAME_SAVE_REPLAY_URI", join(directory, "replay.json"));
  vi.stubEnv("COGAME_SAVE_TRAJECTORY_URI", join(directory, "trajectory.jsonl"));
  const calls: Array<{ id: string; request: unknown; response: unknown }> = [];
  const seatCalls = new Map<string, number>();
  const inference = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const id = randomUUID();
      const slot = String(req.headers["x-coworld-player-slot"]);
      const seen = seatCalls.get(slot) ?? 0;
      seatCalls.set(slot, seen + 1);
      const text =
        slot === "0" && seen === 0
          ? '{"orders":"invalid"}'
          : slot === "1" && seen === 0
            ? '{"orders":[{"type":"claim","tile":"999,999"}]}'
            : '{"orders":[],"messages":[]}';
      const response = {
        model: "fixture/territory",
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      calls.push({ id, request: JSON.parse(body), response });
      res.writeHead(200, { "content-type": "application/json", "X-Softmax-Llm-Call-Id": id });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
  const address = inference.address();
  if (typeof address === "string" || address === null)
    throw new Error("Fixture requires an IP listener");
  vi.stubEnv("COWORLD_LLM_ENDPOINT", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("COWORLD_LLM_MODEL", "fixture/territory");
  const host = await runCoworldGame({
    host: "127.0.0.1",
    port: 0,
    config: {
      tokens: Array.from({ length: 9 }, (_, seat) => `fixture-${seat}`),
      players: Array.from({ length: 9 }, (_, seat) => ({ name: `private policy ${seat}` })),
      seed: 7,
      paceMs: 0,
      turns: 18,
    },
  });
  try {
    const decide = makeLlmDecide("private doctrine", "homesteader");
    const players = host.playerUrls.map((connect) =>
      runCoworldPlayer({ module: territoryModule, connect, decide }),
    );
    const [result] = await Promise.all([host.finished, Promise.all(players)]);
    expect(result.scores).toHaveLength(9);
    const trajectory = JSON.parse(await readFile(join(directory, "trajectory.jsonl"), "utf8"));
    expect(trajectory.episode).toMatchObject({
      status: "completed",
      game: "territory",
      seed_family: "7",
    });
    expect(trajectory.decisions).toHaveLength(162);
    expect(calls).toHaveLength(164);
    const byId = new Map(calls.map((call) => [call.id, call]));
    const bridge = new TrainingSession("7", 9, "private doctrine");
    for (const decision of trajectory.decisions) {
      expect(decision.visibility).toBe("private");
      expect(decision.action_status).toBe("accepted");
      expect(decision.attempts).toHaveLength(decision.decision_index < 2 ? 2 : 1);
      for (const attempt of decision.attempts) {
        expect(attempt.inference_mode).toBe("text_action");
        expect(attempt.request).toEqual(byId.get(attempt.platform_call_id)!.request);
        expect(attempt.raw_response).toBe(
          JSON.stringify(byId.get(attempt.platform_call_id)!.response),
        );
        expect(attempt.prompt).toEqual(attempt.request.messages);
        const observation = bridge.observation();
        if (observation.kind !== "decision") throw new Error("Bridge ended before hosted loop");
        expect(observation.semantic_view).toEqual(decision.observation);
        expect(observation.messages).toEqual(attempt.prompt);
        const applied = bridge.step(observation.decision_id, attempt.response);
        expect(applied.kind).toBe(attempt.accepted ? "accepted" : "rejected");
        if (applied.kind === "accepted") expect(applied.action).toEqual(decision.executed_action);
      }
      const attempt = decision.attempts.at(-1);
      expect(attempt.parsed_action).toEqual(decision.executed_action);
      expect(JSON.stringify(attempt.prompt)).not.toContain("private policy");
    }
    expect(bridge.observation().kind).toBe("terminal");
    expect((await stat(join(directory, "trajectory.jsonl"))).mode & 0o777).toBe(0o600);
    const replay = JSON.parse(await readFile(join(directory, "replay.json"), "utf8"));
    const prompts = replay.frames.filter((frame: { type: string }) => frame.type === "actPrompt");
    expect(prompts).toHaveLength(162);
    for (const frame of prompts)
      for (const attempt of frame.actPrompt.attempts)
        expect(attempt).toEqual({
          prompt: "",
          response: "",
          error: attempt.error === null ? null : "Private player decision failed",
        });
    expect(JSON.stringify(replay)).not.toContain("private doctrine");
    expect(JSON.stringify(replay)).not.toContain("raw_response");
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      inference.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60000);

it("consumes exhausted parser and engine retries with explicit engine fallbacks", () => {
  const parser = new TrainingSession("7", 9, "doctrine");
  expect(parser.step(0, "not JSON").kind).toBe("rejected");
  const consumed = parser.step(0, "not JSON");
  expect(consumed.kind).toBe("consumed_rejection");
  if (consumed.kind === "consumed_rejection") {
    expect(consumed.action.fallback).toBe(true);
    expect(consumed.observation.kind).toBe("decision");
    if (consumed.observation.kind === "decision") expect(consumed.observation.decision_id).toBe(1);
  }
  const engine = new TrainingSession("7", 9, "doctrine");
  const invalid = '{"orders":[{"type":"claim","tile":"999,999"}]}';
  expect(engine.step(0, invalid).kind).toBe("rejected");
  expect(engine.step(0, invalid).kind).toBe("consumed_rejection");
});
