import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve each shared @cogweb/* package to its sibling-source entry, so the game
// seam and its tests compile against the live shared source with no publish step.
const pkg = (name: string) => fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));
// `@cogweb/ui/styles.css` has no package `exports`; map the sub-path to the real
// file (it must precede the bare `@cogweb/ui` alias so the prefix match loses).
const uiStyles = fileURLToPath(new URL("packages/ui/src/styles.css", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // The base config collected only `src/**`, so its vendored `packages/*/tests`
    // never ran. Territory EXTENDS the glob, because the forked runner's batch
    // test lives there and a test that is not collected is not a test.
    include: ["src/**/*.test.{ts,tsx}", "packages/**/tests/**/*.test.ts"],
    environmentMatchGlobs: [["src/client/**", "jsdom"]],
  },
  resolve: {
    alias: {
      "@cogweb/protocol": pkg("protocol"),
      "@cogweb/core": pkg("core"),
      "@cogweb/coworld": pkg("coworld"),
      "@cogweb/llm": pkg("llm"),
      "@cogweb/ui/styles.css": uiStyles,
      "@cogweb/ui": pkg("ui"),
    },
  },
});
