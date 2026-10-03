import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { GameModule } from "@cogweb/core";
import { runCoworldPlayer } from "../src/player-runtime.js";
import { PROTOCOL } from "../src/protocol.js";
afterEach(() => vi.unstubAllEnvs());
const observation = (id: number) => ({
  type: "observation",
  id,
  seat: 0,
  turn: id,
  view: {},
  messages: [],
  reason: null,
  timeLeftMs: null,
});
it("seals private started evidence after a finite join when the player ignores cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fork-player-seal-"));
  const path = join(dir, "artifact.zip");
  vi.stubEnv("COWORLD_PLAYER_ARTIFACT_UPLOAD_URL", pathToFileURL(path).href);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let final!: () => void;
  let mutate!: () => void;
  let release!: (value: { move: string }) => void;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, slot: 0, config: {} }));
    socket.send(JSON.stringify(observation(1)));
    final = () => socket.send(JSON.stringify({ type: "final", scores: [0] }));
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
  try {
    await runCoworldPlayer({
      module: {} as GameModule<unknown, { move: string }>,
      connect: `ws://127.0.0.1:${address.port}`,
      decide: (ctx) => {
        const attempt = {
          generationId: "started",
          prompt: "exact private view",
          response: "",
          error: null,
          generation: {
            model: "fixture",
            messages: [{ role: "user" as const, content: "exact private view" }],
            response: "",
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
            platformCallId: null,
            request: { model: "fixture" },
          },
        };
        ctx.recordAttempt(attempt);
        mutate = () => ctx.recordAttempt({ ...attempt, response: "late" });
        final();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const bytes = await readFile(path);
    const zip = await JSZip.loadAsync(bytes);
    const records = (await zip.file("trace.jsonl")!.async("string"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].response).toMatchObject({
      type: "failure",
      attempts: [
        {
          generationId: "started",
          generation: { platformCallId: null, request: { model: "fixture" } },
        },
      ],
    });
    expect(mutate).toThrow("Player evidence is sealed");
    release({ move: "late" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects duplicate and stale cancel IDs without aborting the new observation", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let aborts = 0;
  let secondSignal!: AbortSignal;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, slot: 0, config: {} }));
    socket.send(JSON.stringify(observation(1)));
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "reply" && frame.id === 2)
        socket.send(JSON.stringify({ type: "final", scores: [0] }));
    });
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
  try {
    await runCoworldPlayer({
      module: {} as GameModule<unknown, { move: string }>,
      connect: `ws://127.0.0.1:${address.port}`,
      decide: (ctx) => {
        if (ctx.turn === 1) {
          ctx.signal.addEventListener("abort", () => aborts++, { once: true });
          const socket = [...server.clients][0]!;
          socket.send(JSON.stringify({ type: "cancel", id: 1 }));
          socket.send(JSON.stringify({ type: "cancel", id: 1 }));
          socket.send(JSON.stringify(observation(2)));
          socket.send(JSON.stringify({ type: "cancel", id: 1 }));
          return new Promise((_resolve, reject) =>
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }),
          );
        }
        secondSignal = ctx.signal;
        return new Promise((resolve) =>
          setTimeout(() => {
            expect(ctx.signal.aborted).toBe(false);
            resolve({ move: "fresh" });
          }, 10),
        );
      },
    });
    expect(aborts).toBe(1);
    expect(secondSignal.reason?.message).toBe("Episode finished");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
