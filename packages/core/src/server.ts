// One-call composition of the whole platform for a SINGLE game: one instance
// (lobby + per-instance wiring + websocket) from a GameDescriptor, plus the HTTP
// surface (/health, /version, live /state.json + /cog/:seat/state.json) and an
// optional static client mount. /state.json reflects the running game because the
// hub exposes the live runner's snapshot. For many concurrent games behind one
// server, see createHub (hub.ts); both build instances via createInstance, so the
// single- and multi-game paths never drift.

import { createServer as createNodeServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { createHttpApp } from "./http";
import type { VersionInfo } from "./http";
import { createInstance } from "./instance";
import type { GameDescriptor } from "./instance";
import type { Lobby } from "./lobby";
import type { AttachedWebSocket } from "./websocket";

export interface GameServerOptions {
  /** Human-readable app name, echoed in /version. Defaults to the descriptor id. */
  appName?: string;
  deployVersion?: Partial<VersionInfo>;
  /** Directory of the built client to serve statically (after the API routes),
   *  so the app and its websocket live on one origin. */
  staticDir?: string;
}

export interface GameServer {
  readonly lobby: Lobby;
  readonly httpServer: HttpServer;
  readonly ws: AttachedWebSocket;
  listen(port: number, cb?: () => void): HttpServer;
  close(): void;
}

export function createGameServer(descriptor: GameDescriptor, opts: GameServerOptions = {}): GameServer {
  const appName = opts.appName ?? descriptor.id;
  const { lobby, ws, verifySeatToken } = createInstance(descriptor, descriptor.module.game.id);

  const app = createHttpApp({
    appName,
    deployVersion: opts.deployVersion ?? { app: appName },
    getPublicState: () => ws.snapshot(null),
    getSeatState: (seat) => ws.snapshot(seat),
    verifySeatToken,
  });

  // Serve the built client after the API routes, so /health, /version, and
  // /state.json win and everything else (index.html, assets) is served static.
  if (opts.staticDir) app.use(express.static(opts.staticDir));

  const httpServer = createNodeServer(app);
  // The ws is `noServer`, so this single-game server owns the http upgrade event
  // and forwards every ws upgrade (any path) to its one instance.
  httpServer.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head));

  return {
    lobby,
    httpServer,
    ws,
    listen(port, cb) {
      return httpServer.listen(port, cb);
    },
    close() {
      ws.close();
      httpServer.close();
    },
  };
}
