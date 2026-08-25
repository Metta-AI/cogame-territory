import { describe, it, expect } from "vitest";
import { key, neighbors, hexesInRadius, distance } from "./hex";

describe("hex", () => {
  it("keys a hex", () => expect(key({ q: 1, r: -2 })).toBe("1,-2"));
  it("has 6 neighbors", () => expect(neighbors({ q: 0, r: 0 })).toHaveLength(6));
  it("radius 0 = 1 tile, radius 1 = 7, radius 6 = 127", () => {
    expect(hexesInRadius(0)).toHaveLength(1);
    expect(hexesInRadius(1)).toHaveLength(7);
    expect(hexesInRadius(6)).toHaveLength(127);
  });
});

describe("distance", () => {
  it("zero to self", () => expect(distance({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0));
  it("one to a neighbor", () => expect(distance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1));
  it("radius to an edge", () => expect(distance({ q: 0, r: 0 }, { q: 6, r: 0 })).toBe(6));
  it("is symmetric", () => expect(distance({ q: 2, r: -1 }, { q: -1, r: 1 })).toBe(distance({ q: -1, r: 1 }, { q: 2, r: -1 })));
});
