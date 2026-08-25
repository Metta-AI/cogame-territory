import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Resolve each shared workspace package to its source entry, so Vite builds the
// @cogweb/* packages straight from packages/<pkg>/src without a publish/build
// step. The pnpm workspace symlinks suffice for the GAME's own @cogweb imports, but a
// cross-package import INSIDE cogweb source (e.g. @cogweb/ui's useFeedStore importing
// @cogweb/protocol) resolves from that package's location and finds no node_modules in
// a fresh deploy worktree — so alias every @cogweb/* explicitly. The `/(.*)` form MUST
// precede the bare alias (Vite matches string finds by prefix).
//
// THE SAME TYPESCRIPT SIM COMPILES INTO THE VIEWER BUNDLE. There is no wasm here:
// `scripts/build-static-replay-viewer.sh` is a vite build of the engine the host
// runs, which satisfies the "the viewer re-derives every frame from the recorded
// events in the browser" pin by compiling the engine to JS instead.
const pkg = (name: string): string => resolve(__dirname, `packages/${name}/src`);
const cogwebAlias = (name: string): { find: string | RegExp; replacement: string }[] => [
  { find: new RegExp(`^@cogweb/${name}/(.*)$`), replacement: `${pkg(name)}/$1` },
  { find: `@cogweb/${name}`, replacement: `${pkg(name)}/index.ts` },
];

// cogweb source also pulls in third-party deps (`import "zod"` / `"react"`) that can't
// find cogherence's node_modules by walking up from a sibling package dir. Pin them to
// cogherence's own install so the web build resolves them even in a fresh deploy
// worktree, where the sibling cogweb packages have no node_modules of their own.
const sharedDep = (name: string): { find: RegExp; replacement: string }[] => [
  { find: new RegExp(`^${name}/(.*)$`), replacement: resolve(__dirname, `node_modules/${name}/$1`) },
  { find: new RegExp(`^${name}$`), replacement: resolve(__dirname, `node_modules/${name}`) },
];

// Vite config for the spectator console.
export default defineConfig(() => ({
  // RELATIVE asset paths: the Observatory serves the static replay bundle under a
  // deep per-coworld prefix, so an absolute "/assets/…" would 404 there. Relative
  // "./assets/…" resolves under any prefix, and both index.html and the fixture
  // page pin a <base> so nested routes resolve too.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      ...cogwebAlias("protocol"),
      ...cogwebAlias("core"),
      ...cogwebAlias("coworld"),
      ...cogwebAlias("llm"),
      ...cogwebAlias("ui"),
      ...sharedDep("zod"),
      ...sharedDep("react"),
      ...sharedDep("react-dom"),
      ...sharedDep("express"),
      ...sharedDep("ws"),
      ...sharedDep("@aws-sdk/client-bedrock-runtime"),
    ],
  },
  // Three shells: the broadcast console (index.html), the per-seat console
  // (index-agent.html — the coworld host serves it on /client/player, and a 404
  // there fails certification before any player pod starts), and the renderer
  // fixture (tools/ci/renderer_fixture.html, opened by tools/ci/renderer_fixture.mjs
  // at 360/720/1280px).
  build: {
    outDir: "dist",
    // Inline every imported asset as a data URI: path-served art 404s under the
    // Observatory proxy / static replay bundle prefixes, but a data URI renders
    // everywhere (LEAGUE.md §4 — the coguire/agricogla pattern).
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        agent: resolve(__dirname, "index-agent.html"),
        fixture: resolve(__dirname, "tools/ci/renderer_fixture.html"),
      },
    },
  },
}));
