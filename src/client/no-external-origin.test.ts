// THE STATIC VIEWER CONTACTS NOTHING BUT S3 (item 3).
//
// The hosted replay page is a static bundle served from one prefix, and the only
// request it is allowed to make is the `?replay=` artifact fetch. The inherited
// stylesheet carried a Google-Fonts `@import` — a second origin, fetched on every
// hosted view, and the thing that decided which font the renderer fixture measured
// (a different font in an egress-blocked environment). The families are self-hosted
// now; this test is what keeps any absolute-origin reference from coming back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `process.cwd()`, not import.meta.url: vitest runs src/client in jsdom.
const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

/** Every file whose bytes are emitted into (or inlined by) the viewer bundle. */
const SHIPPED = [
  ["src", "client", "styles.css"],
  ["packages", "ui", "src", "styles.css"],
  ["index.html"],
  ["index-agent.html"],
  ["tools", "ci", "renderer_fixture.html"],
];

describe("the shipped viewer references no external origin", () => {
  it("has no absolute http(s) URL in any shell or stylesheet", () => {
    for (const parts of SHIPPED) {
      const text = read(...parts);
      const found = text.match(/https?:\/\/[^\s"')]+/g) ?? [];
      expect(found, parts.join("/")).toEqual([]);
    }
  });

  it("declares both families locally, from files committed in this repo", () => {
    const css = read("src", "client", "styles.css");
    for (const family of ["Space Grotesk", "JetBrains Mono"]) {
      expect(css).toContain(`font-family: "${family}"`);
    }
    for (const file of ["space-grotesk-latin-var.woff2", "jetbrains-mono-latin-var.woff2"]) {
      expect(css).toContain(`url("./fonts/${file}")`);
      // Really present, and really a woff2 (the magic number is "wOF2").
      const bytes = readFileSync(join(ROOT, "src", "client", "fonts", file));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(bytes.byteLength).toBeGreaterThan(1024);
    }
  });
});
