#!/usr/bin/env bash
# The `coworld build --project .` replay-viewer hook, and the same script ci.yml's
# wasm-viewer job runs. It MUST be committed mode 100755: `coworld build` refuses
# to package a source replay-viewer bundle unless the hook is os.X_OK.
#
#   tools/build_replay_viewer.sh <absolute output dir ending in /build/static-replay-viewer>
#
# There is no emscripten in this lineage: the static bundle is a VITE BUILD of the
# same TypeScript sim the host runs, which satisfies the "the viewer re-derives
# every frame from the recorded events in the browser" pin by compiling the engine
# to JS instead of wasm.
set -euo pipefail

game_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:?usage: tools/build_replay_viewer.sh <output dir>}"

# `coworld build` pre-creates the output's parent; CI does not (the ecos-2026-08-23
# fix), so make it here either way.
mkdir -p "$(dirname "${out}")"

# A fresh CI checkout has no node_modules; `coworld build` may run in one too.
if [ ! -d "${game_dir}/node_modules" ]; then
  echo "[build_replay_viewer] installing dependencies (no node_modules present)"
  (cd "${game_dir}" && pnpm install --frozen-lockfile)
fi

exec "${game_dir}/scripts/build-static-replay-viewer.sh" "${game_dir}" "${out}"
