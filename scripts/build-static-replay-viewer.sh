#!/usr/bin/env bash
set -euo pipefail

game_dir="$1"
output_dir="$2"
bundle_suffix="/build/static-replay-viewer"
if [[ "${game_dir}" != /* || "${output_dir}" != /* || "${output_dir}" == "${bundle_suffix}" || "${output_dir}" != *"${bundle_suffix}" ]]; then
  echo "unsafe static replay viewer paths: game=${game_dir} output=${output_dir}" >&2
  exit 1
fi

rm -rf "${output_dir}"
mkdir -p "${output_dir}"
pnpm --dir "${game_dir}" exec vite build --outDir "${output_dir}"
