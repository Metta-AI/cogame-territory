# Coworld image for Territory. `compose.yaml` builds this with `context: .` (the
# repo root), so `COPY dist-server` / `COPY dist` pick up the pre-built, fully
# self-contained bundles: `pnpm build:coworld` inlines the @cogweb/* workspace
# source AND third-party deps, and `pnpm build:web` emits dist/. No node_modules
# is needed at runtime.
#
# There is no CMD on purpose: the coworld dispatcher always launches the container
# with the manifest's per-runnable `run`, so an image default would be dead code.
# The two entrypoint SHIMS below exist so the standard smoke / cert / policy specs
# all name the same binaries.
FROM node:20-slim
WORKDIR /app

COPY dist-server ./dist-server
COPY dist ./dist

RUN printf '#!/bin/sh\nexec node /app/dist-server/coworld/game-cli.js "$@"\n' > /bin/territory \
 && printf '#!/bin/sh\nexec node /app/dist-server/game/player.js "$@"\n' > /bin/territory-player \
 && chmod +x /bin/territory /bin/territory-player

ENV NODE_ENV=production
