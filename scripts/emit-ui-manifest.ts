// Emit the SHA-256 manifest of `packages/ui/src/**` — this lineage's
// `client/chrome_common.js`. Territory reuses that package BYTE-FOR-BYTE and
// appends its own game block instead of editing it; `src/client/chrome-manifest.json`
// is the checked-in proof, and `src/client/chrome-manifest.test.ts` fails the build
// the moment a chrome file drifts.
//
//   pnpm ui-manifest > src/client/chrome-manifest.json
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = join(ROOT, "packages", "ui", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files: Record<string, string> = {};
for (const file of walk(CHROME)) {
  const key = relative(ROOT, file).split("\\").join("/");
  files[key] = createHash("sha256").update(readFileSync(file)).digest("hex");
}

console.log(
  JSON.stringify(
    {
      note:
        "SHA-256 of every file under packages/ui/src — the shared chrome Territory reuses " +
        "unmodified. Regenerate with `pnpm ui-manifest`; a diff here means the chrome was " +
        "edited instead of appended to, which is the cogame-gridlock failure.",
      base: "Metta-AI/coworld-cogherence",
      files,
    },
    null,
    2,
  ),
);
