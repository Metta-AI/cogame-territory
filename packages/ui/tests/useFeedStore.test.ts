// applyFrame reduces the snapshot stream into the scrub timeline. `snapshotKey` sets
// the granularity: a snapshot whose key equals the tail's key REPLACES the tail; a new
// key APPENDS. Three modes — the default (one per turn), a finer turn+phase key (keep
// several snapshots within a turn), and a null key (never collapse, every frame is its
// own beat). This is the exact reducer both replay builds depend on, so it is pinned here.

import { describe, it, expect } from "vitest";

import { applyFrame, emptyFeedStore } from "../src/useFeedStore";
import type { ServerMessage, Snapshot } from "@cogweb/protocol";

const snap = (turn: number, phase = "", generation = 1): ServerMessage => ({
  type: "snapshot",
  snapshot: { turn, generation, state: { phase } },
});

// coguire keeps mid-turn beats by phase; a replay keeps every frame by returning null.
const byTurnPhase = (s: Snapshot): string => `${s.turn}-${(s.state as { phase: string }).phase}`;
const never = (): null => null;

const turns = (store: { snapshots: Snapshot[] }): number[] => store.snapshots.map((s) => s.turn);

describe("applyFrame snapshot timeline", () => {
  it("default: collapses to one entry per turn (a mid-turn snapshot replaces the row)", () => {
    let store = emptyFeedStore();
    store = applyFrame(store, snap(0));
    store = applyFrame(store, snap(0)); // same turn → replaces, not appends
    store = applyFrame(store, snap(1));
    expect(turns(store)).toEqual([0, 1]);
    expect(store.snapshots).toHaveLength(2);
  });

  it("turn+phase key: keeps several snapshots within one turn, still collapses a repeat phase", () => {
    let store = emptyFeedStore();
    store = applyFrame(store, snap(3, "survivor"), byTurnPhase);
    store = applyFrame(store, snap(3, "disposal"), byTurnPhase); // same turn, new phase → append
    store = applyFrame(store, snap(3, "disposal"), byTurnPhase); // repaint of same phase → replace
    store = applyFrame(store, snap(4, "roll"), byTurnPhase);
    expect(turns(store)).toEqual([3, 3, 4]);
    const phases = store.snapshots.map((s) => (s.state as { phase: string }).phase);
    expect(phases).toEqual(["survivor", "disposal", "roll"]);
  });

  it("null key: never collapses — every snapshot is its own beat-frame, even same turn+phase", () => {
    let store = emptyFeedStore();
    store = applyFrame(store, snap(1, "roll"), never);
    store = applyFrame(store, snap(1, "roll"), never); // identical key would collapse elsewhere
    store = applyFrame(store, snap(1, "trade"), never);
    store = applyFrame(store, snap(2, "roll"), never);
    expect(turns(store)).toEqual([1, 1, 1, 2]);
    expect(store.snapshots).toHaveLength(4);
  });

  it("a newer generation resets the timeline before appending", () => {
    let store = emptyFeedStore();
    store = applyFrame(store, snap(0, "", 1));
    store = applyFrame(store, snap(1, "", 1));
    expect(turns(store)).toEqual([0, 1]);
    store = applyFrame(store, snap(0, "", 2)); // new generation → fresh timeline
    expect(turns(store)).toEqual([0]);
    expect(store.generation).toBe(2);
  });

  it("an older-generation frame is ignored", () => {
    let store = emptyFeedStore();
    store = applyFrame(store, snap(5, "", 3));
    const before = store.snapshots;
    store = applyFrame(store, snap(0, "", 2)); // stale generation → dropped
    expect(store.snapshots).toBe(before);
  });
});
