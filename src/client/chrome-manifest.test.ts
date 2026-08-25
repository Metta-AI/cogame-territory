// CHROME PROVENANCE. `packages/ui/src/**` is this lineage's
// `client/chrome_common.js`: Territory reuses it BYTE-FOR-BYTE and APPENDS its own
// game block (ScoreBug / WarLedger / BoardPanel) into the stage instead of editing
// it. A page written from scratch that reuses the chrome's ids is a rewrite, not a
// reuse (cogame-gridlock, 2026-08-23) — this test is what makes the reuse checkable.
//
// `src/client/chrome-manifest.json` is the checked-in SHA-256 manifest, regenerated
// with `pnpm ui-manifest`. A diff here means a chrome file was edited: either
// revert it, or move the change into the game block.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// `process.cwd()` rather than import.meta.url: this file lives under src/client,
// which vitest runs in jsdom, where import.meta.url is not a file:// URL.
const ROOT = process.cwd();
const CHROME = join(ROOT, "packages", "ui", "src");
const manifest = JSON.parse(readFileSync(join(ROOT, "src", "client", "chrome-manifest.json"), "utf8")) as {
  base: string;
  files: Record<string, string>;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("packages/ui/src is unchanged from the base commit", () => {
  it("hashes every chrome file to the checked-in manifest", () => {
    const actual: Record<string, string> = {};
    for (const file of walk(CHROME)) {
      actual[relative(ROOT, file).split("\\").join("/")] = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
    }
    expect(actual).toEqual(manifest.files);
    expect(manifest.base).toBe("Metta-AI/coworld-cogherence");
  });

  it("covers the files the game block actually mounts", () => {
    for (const f of [
      "packages/ui/src/GameTopBar.tsx",
      "packages/ui/src/GameScrubberBar.tsx",
      "packages/ui/src/Scrubber.tsx",
      "packages/ui/src/EventFeed.tsx",
      "packages/ui/src/FinalScorePanel.tsx",
      "packages/ui/src/replay.ts",
      "packages/ui/src/styles.css",
    ]) {
      expect(Object.keys(manifest.files)).toContain(f);
    }
  });
});
