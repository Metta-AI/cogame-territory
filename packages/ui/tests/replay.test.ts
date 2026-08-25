import { gzipSync, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadReplayFrames } from "../src/replay";

const replay = {
  protocol: "cogweb.replay.v1",
  frames: [{ type: "snapshot", snapshot: { turn: 0, generation: 1, state: { phase: "running" } } }],
};

function replayResponse(bytes: Uint8Array): void {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
}

afterEach(() => vi.unstubAllGlobals());

describe("loadReplayFrames", () => {
  it.each([
    ["raw JSON", new TextEncoder().encode(JSON.stringify(replay))],
    ["gzip", gzipSync(JSON.stringify(replay))],
    ["zlib", deflateSync(JSON.stringify(replay))],
  ])("loads and validates %s artifacts", async (_name, bytes) => {
    replayResponse(bytes);
    await expect(loadReplayFrames("https://artifacts.example/replay")).resolves.toEqual(replay.frames);
  });

  it("rejects an invalid replay envelope", async () => {
    replayResponse(new TextEncoder().encode(JSON.stringify({ protocol: "cogweb.replay.v1", frames: [] })));
    await expect(loadReplayFrames("https://artifacts.example/replay")).rejects.toThrow("Array must contain at least 1");
  });

  it("reports HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(loadReplayFrames("https://artifacts.example/missing")).rejects.toThrow(
      "replay request failed with HTTP 404",
    );
  });
});
