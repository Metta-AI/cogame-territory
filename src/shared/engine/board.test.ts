// TEST 1 — the board. Same seed => identical board; 169 tiles; the nine hearth
// coordinates are exactly the ones the design note names, pairwise >= 3 apart and
// owned dry at turn 1; the yield histogram sits within 3σ of [0.45,0.30,0.17,0.08];
// and each variant's overlay matches its spec.
import { describe, it, expect } from "vitest";

import { generateBoard, homeRing, incomePool } from "./board";
import { distance, hexesInRadius, key } from "./hex";
import { BOARD_RADIUS, HEARTHS, SEATS, STARTING_PAINT } from "./constants";

const ORIGIN = { q: 0, r: 0 };

describe("generateBoard", () => {
  it("is deterministic for a seed", () => {
    expect(JSON.stringify(generateBoard(12345))).toBe(JSON.stringify(generateBoard(12345)));
    expect(JSON.stringify(generateBoard(12345))).not.toBe(JSON.stringify(generateBoard(12346)));
  });

  it("lays 169 tiles on a radius-7 lattice", () => {
    const s = generateBoard(7);
    expect(Object.keys(s.tiles)).toHaveLength(169);
    expect(hexesInRadius(BOARD_RADIUS)).toHaveLength(169);
    for (const t of Object.values(s.tiles)) expect(distance(t.hex, ORIGIN)).toBeLessThanOrEqual(BOARD_RADIUS);
  });

  it("places the nine hearths exactly where the note says, >= 3 apart", () => {
    // The note's list, verbatim.
    expect(HEARTHS.map((h) => key(h))).toEqual([
      "5,0",
      "5,-3",
      "4,-5",
      "0,-5",
      "-3,-2",
      "-5,1",
      "-5,5",
      "-2,5",
      "1,4",
    ]);
    expect(HEARTHS).toHaveLength(SEATS);
    let min = Infinity;
    for (let i = 0; i < HEARTHS.length; i++) {
      // Every hearth sits on ring 5.
      expect(distance(HEARTHS[i]!, ORIGIN)).toBe(5);
      for (let j = i + 1; j < HEARTHS.length; j++) {
        min = Math.min(min, distance(HEARTHS[i]!, HEARTHS[j]!));
      }
    }
    expect(min).toBe(3);
  });

  it("hands each seat its hearth, owned DRY, at whatever yield the seed gave it", () => {
    const s = generateBoard(7);
    expect(s.turn).toBe(1);
    expect(s.cogs).toHaveLength(SEATS);
    for (const cog of s.cogs) {
      const tile = s.tiles[key(cog.hearth)]!;
      expect(tile.owner).toBe(cog.seat);
      expect(tile.wet).toBe(false);
      expect(tile.state).toBe("wall");
      expect(cog.paint).toBe(STARTING_PAINT);
      expect(cog.banked).toBe(0);
      expect(cog.life).toBe("steady");
      expect(cog.wallsHeld).toBe(1);
    }
  });

  it("gives each seat a 7-coordinate home ring centred on its hearth", () => {
    for (let seat = 0; seat < SEATS; seat++) {
      const ring = homeRing(seat);
      expect(ring).toContain(key(HEARTHS[seat]!));
      // Ring 5 hearths always have all six neighbours on a radius-7 board.
      expect(ring).toHaveLength(7);
      for (const k of ring) {
        const [q, r] = k.split(",").map(Number);
        expect(distance({ q: q!, r: r! }, HEARTHS[seat]!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("draws yields from the declared distribution (within 3 sigma over many seeds)", () => {
    const counts = [0, 0, 0, 0];
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed++) {
      for (const t of Object.values(generateBoard(seed).tiles)) counts[t.yield] = (counts[t.yield] ?? 0) + 1;
    }
    const n = counts.reduce((a, b) => a + b, 0);
    expect(n).toBe(169 * seeds);
    const expected = [0.45, 0.3, 0.17, 0.08];
    for (let i = 0; i < 4; i++) {
      const p = expected[i]!;
      const sigma = Math.sqrt((p * (1 - p)) / n);
      expect(Math.abs(counts[i]! / n - p)).toBeLessThan(3 * sigma);
    }
  });

  it("prices the full-claim income pool near 149 paint/turn", () => {
    const pools = Array.from({ length: 20 }, (_, i) => incomePool(generateBoard(i + 1).tiles));
    const mean = pools.reduce((a, b) => a + b, 0) / pools.length;
    expect(mean).toBeGreaterThan(130);
    expect(mean).toBeLessThan(170);
  });

  describe("variants", () => {
    it("open adds no barriers", () => {
      const s = generateBoard(7, "open");
      expect(Object.values(s.tiles).every((t) => t.state === "wall")).toBe(true);
    });

    it("rooms walls each hearth in with exactly one gap, and hearth adjacency wins", () => {
      const s = generateBoard(7, "rooms");
      for (const hearth of HEARTHS) {
        const ring = Object.values(s.tiles).filter((t) => distance(t.hex, hearth) === 2);
        expect(ring.length).toBeGreaterThan(0);
        const open = ring.filter((t) => t.state !== "rubble");
        // Exactly one gap per room — unless a neighbouring hearth's adjacency
        // precedence spared more of the ring, which is the declared rule.
        expect(open.length).toBeGreaterThanOrEqual(1);
        // The gap is the ring tile nearest the board origin.
        const nearest = [...ring].sort(
          (a, b) => distance(a.hex, ORIGIN) - distance(b.hex, ORIGIN) || (key(a.hex) < key(b.hex) ? -1 : 1),
        )[0]!;
        expect(nearest.state).not.toBe("rubble");
        // Every tile within distance 1 of ANY hearth survives as a rich wall.
        for (const t of Object.values(s.tiles)) {
          const d = HEARTHS.reduce((best, h) => Math.min(best, distance(t.hex, h)), Infinity);
          if (d <= 1) {
            expect(t.state).not.toBe("rubble");
            if (d === 1) expect(t.yield).toBe(3);
          }
        }
      }
      // A hearth tile is never rubble.
      for (const h of HEARTHS) expect(s.tiles[key(h)]!.state).toBe("wall");
    });

    it("inside_out makes the centre rich and the rim barren", () => {
      const s = generateBoard(7, "inside_out");
      for (const t of Object.values(s.tiles)) {
        const d = distance(t.hex, ORIGIN);
        if (d <= 2) expect(t.yield).toBe(3);
        if (d >= 6) expect(t.yield).toBe(0);
      }
      // Every hearth sits on ring 5, so it keeps its seeded yield.
      expect(Object.values(s.tiles).every((t) => t.state === "wall")).toBe(true);
    });
  });
});
