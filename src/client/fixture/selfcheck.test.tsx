// The fixture's OWN string self-check, exercised in jsdom.
//
// `tools/ci/renderer_fixture.mjs` runs `window.__territoryFixtureCheck()` in a real
// browser at 360/720/1280 px, where the geometry findings are meaningful. jsdom has
// no layout (every box is 0×0), so only the STRING findings are assertable here —
// which is exactly the class this test cares about: that the fixture notices a
// quietly shortened remark or a scenario that stopped talking, instead of reporting
// `ok: true` over an empty Channels panel.
import { describe, expect, it } from "vitest";

describe("the renderer fixture asserts its own strings", () => {
  it("reports no string findings over the real scenario it mounts", async () => {
    document.body.innerHTML = '<div id="fixture-root"></div>';
    await import("./main");
    await new Promise((r) => setTimeout(r, 0));
    const check = window.__territoryFixtureCheck;
    expect(check).toBeTypeOf("function");
    const out = check!();
    const strings = out.findings.filter((f) => f.selector === "#fixture-root");
    expect(strings).toEqual([]);
    expect(out.rows).toBeGreaterThan(0);
  });
});
