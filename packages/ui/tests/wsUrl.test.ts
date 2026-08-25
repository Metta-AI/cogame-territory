import { describe, it, expect } from "vitest";
import { instanceBasePath, spectatorWsUrl, isReplayView, viewerFeedSource } from "../src/wsUrl";

describe("instanceBasePath", () => {
  it("is empty at the root (standalone single-game server)", () => {
    expect(instanceBasePath("/")).toBe("");
    expect(instanceBasePath("")).toBe("");
  });
  it("is the instance prefix under the hub", () => {
    expect(instanceBasePath("/cognames/7gq2k")).toBe("/cognames/7gq2k");
  });
  it("strips a trailing slash so the prefix is clean", () => {
    expect(instanceBasePath("/cognames/7gq2k/")).toBe("/cognames/7gq2k");
  });
});

describe("spectatorWsUrl", () => {
  it("points at /ws at the root", () => {
    expect(spectatorWsUrl({ protocol: "http:", host: "localhost:8795", pathname: "/" })).toBe(
      "ws://localhost:8795/ws",
    );
  });
  it("points at the instance prefix under the hub", () => {
    expect(
      spectatorWsUrl({ protocol: "https:", host: "cogweb.dbloom.in", pathname: "/cognames/7gq2k" }),
    ).toBe("wss://cogweb.dbloom.in/cognames/7gq2k");
  });
  it("handles a trailing slash on the instance path", () => {
    expect(
      spectatorWsUrl({ protocol: "https:", host: "cogweb.dbloom.in", pathname: "/cogsul/3hk9m/" }),
    ).toBe("wss://cogweb.dbloom.in/cogsul/3hk9m");
  });
  it("uses ws:// for http and wss:// for https", () => {
    expect(spectatorWsUrl({ protocol: "http:", host: "h", pathname: "/a/b" })).toBe("ws://h/a/b");
    expect(spectatorWsUrl({ protocol: "https:", host: "h", pathname: "/a/b" })).toBe("wss://h/a/b");
  });

  // The hosted Observatory serves a coworld viewer under a deep proxy prefix
  // (`<prefix>/client/{replay,global,player}`) and proxies the spectator socket at the
  // sibling `<prefix>/{replay,global}` — the route `runCoworldReplay` serves frames on.
  // Connecting to the `/client/...` page path itself 500s and hangs on "waiting for the table".
  it("derives the hosted replay WS from the proxied viewer path", () => {
    expect(
      spectatorWsUrl({
        protocol: "https:",
        host: "api.observatory.softmax-research.net",
        pathname: "/v2/coworlds/replays/cow_x/sessions/sid/proxy/client/replay",
      }),
    ).toBe("wss://api.observatory.softmax-research.net/v2/coworlds/replays/cow_x/sessions/sid/proxy/replay");
  });
  it("derives the hosted live (global) WS from the proxied viewer path", () => {
    expect(
      spectatorWsUrl({
        protocol: "https:",
        host: "api.observatory.softmax-research.net",
        pathname: "/v2/coworlds/jobs/job_x/proxy/client/global",
      }),
    ).toBe("wss://api.observatory.softmax-research.net/v2/coworlds/jobs/job_x/proxy/global");
  });
  it("maps the player shell to the global spectator feed", () => {
    expect(spectatorWsUrl({ protocol: "https:", host: "h", pathname: "/p/client/player" })).toBe("wss://h/p/global");
  });
  it("uses ws:// (not wss) on http proxied origins", () => {
    expect(spectatorWsUrl({ protocol: "http:", host: "127.0.0.1:54321", pathname: "/client/replay" })).toBe(
      "ws://127.0.0.1:54321/replay",
    );
  });
});

describe("isReplayView", () => {
  const loc = (pathname: string) => ({ protocol: "https:", host: "h", pathname });
  it("is true on the hosted proxied replay viewer path", () => {
    expect(isReplayView(loc("/v2/coworlds/replays/cow_x/sessions/sid/proxy/client/replay"))).toBe(true);
  });
  it("is true on a standalone /replay server", () => {
    expect(isReplayView(loc("/replay"))).toBe(true);
    expect(isReplayView(loc("/replay/"))).toBe(true);
  });
  it("is true for a static viewer with a replay artifact query", () => {
    expect(isReplayView({ ...loc("/index.html"), search: "?replay=https%3A%2F%2Fartifacts.example%2Freplay" })).toBe(
      true,
    );
  });
  it("is false on the live (global) viewer and the player shell", () => {
    expect(isReplayView(loc("/p/client/global"))).toBe(false);
    expect(isReplayView(loc("/p/client/player"))).toBe(false);
  });
  it("is false on the hub instance root and a standalone live root", () => {
    expect(isReplayView(loc("/agricogla/7gq2k"))).toBe(false);
    expect(isReplayView(loc("/"))).toBe(false);
  });
});

describe("viewerFeedSource", () => {
  it("uses the replay artifact in a static viewer", () => {
    expect(
      viewerFeedSource({
        protocol: "https:",
        host: "viewer.example",
        pathname: "/sha256/index.html",
        search: "?replay=https%3A%2F%2Fartifacts.example%2Freplay",
      }),
    ).toEqual({ replayUrl: "https://artifacts.example/replay" });
  });

  it("uses the existing spectator WebSocket when no replay query is present", () => {
    expect(
      viewerFeedSource({
        protocol: "https:",
        host: "api.example",
        pathname: "/v2/coworlds/replays/id/proxy/client/replay",
      }),
    ).toEqual({ socketUrl: "wss://api.example/v2/coworlds/replays/id/proxy/replay" });
  });
});
