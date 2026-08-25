// The portal router: a STATELESS front for many independent per-game hub
// processes. Where createHub hosts every game's instances in ONE process (so a
// redeploy of any game restarts them all), the router owns no game state at all —
// each game runs as its own hub service and is the source of truth for its own
// matches. The router only holds a static registry of backends (moduleId →
// address), routes /<moduleId>/<instanceId>/... (HTTP + websocket) to the right
// one by the FIRST path segment, and aggregates /api/games + /api/modules across
// the live ones.
//
// Because it stores no instances, the router is freely restartable: on boot it
// re-reads its backend list and re-discovers what's running by querying the
// processes. A liveness monitor polls each backend's /health (+ /version); a
// backend that's down (crashed, or mid-redeploy) is hidden from the catalog and
// the games list and its routes 503 — so dead games never show — and recovers on
// its own when /health comes back. Per-instance GC (finished matches) stays with
// each game's hub reaper; the router just mirrors what a backend reports.

import { createServer as createNodeServer, request as httpRequest } from "node:http";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import express from "express";
import type { Express, Request, Response } from "express";
import { resolveVersion } from "./http";
import type { VersionInfo } from "./http";

/** One game backend the router fronts: a per-game hub process. */
export interface RouterBackend {
  /** The game's module id; also the first URL path segment routed to it. */
  moduleId: string;
  /** Base URL of the game's hub process, e.g. "http://127.0.0.1:8801". */
  target: string;
}

export interface RouterOptions {
  /** Static backend registry (moduleId → address). For a fixed set of games this
   *  is config; the router never mutates it — a down backend is hidden, not
   *  removed, so it recovers automatically when it comes back. */
  backends: RouterBackend[];
  appName?: string;
  deployVersion?: Partial<VersionInfo>;
  /** Directory of the portal SPA served at `/` (the unified lobby). */
  portalDir?: string;
  /** How often to poll each backend's /health. Default 4s. */
  healthIntervalMs?: number;
  /** Per-poll timeout. Default 1.5s. */
  healthTimeoutMs?: number;
}

/** A backend's current liveness, as the monitor sees it. */
export interface BackendLiveness {
  moduleId: string;
  target: string;
  up: boolean;
  /** The backend's /version deployId (lets the router notice a redeploy). */
  version: string | null;
  /** Epoch ms of the last successful /health, or null if never seen. */
  lastOkAt: number | null;
}

export interface Router {
  readonly httpServer: HttpServer;
  listen(port: number, cb?: () => void): HttpServer;
  close(): void;
  /** Snapshot of every backend's liveness (for tooling/tests). */
  liveness(): BackendLiveness[];
}

interface BackendState extends BackendLiveness {
  host: string;
  port: number;
}

const MODULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function createRouter(opts: RouterOptions): Router {
  const appName = opts.appName ?? "cogweb";
  const healthIntervalMs = opts.healthIntervalMs ?? 4000;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 1500;

  // The static registry. Keyed by moduleId; a duplicate moduleId keeps the last.
  const backends = new Map<string, BackendState>();
  for (const b of opts.backends) {
    const u = new URL(b.target);
    backends.set(b.moduleId, {
      moduleId: b.moduleId,
      target: b.target.replace(/\/+$/, ""),
      host: u.hostname,
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      up: false,
      version: null,
      lastOkAt: null,
    });
  }

  /** The backend for a moduleId only if it is currently UP, else null. */
  const liveTarget = (moduleId: string): BackendState | null => {
    const b = backends.get(moduleId);
    return b && b.up ? b : null;
  };

  // --- liveness monitor ------------------------------------------------------
  // Poll /health (+ /version) per backend; a failed poll hides the backend (its
  // games drop out of the catalog/list and its routes 503) until it recovers.
  const fetchText = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(healthTimeoutMs) });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  const pollOne = async (b: BackendState): Promise<void> => {
    const health = await fetchText(`${b.target}/health`);
    const up = health?.trim() === "ok";
    b.up = up;
    if (up) {
      b.lastOkAt = Date.now();
      const ver = await fetchText(`${b.target}/version`);
      if (ver) {
        try {
          b.version = (JSON.parse(ver) as { deployId?: string }).deployId ?? null;
        } catch {
          b.version = null;
        }
      }
    }
  };

  const poll = (): void => {
    for (const b of backends.values()) void pollOne(b);
  };
  poll();
  const monitor = setInterval(poll, healthIntervalMs);
  monitor.unref?.();

  // --- aggregation -----------------------------------------------------------
  // Fan a GET out to every UP backend and merge the JSON arrays; a backend that
  // fails mid-request is dropped (never surfaced), so the list/catalog only ever
  // shows games on a live process.
  const fanOut = async (path: string): Promise<unknown[]> => {
    const live = [...backends.values()].filter((b) => b.up);
    const results = await Promise.all(
      live.map(async (b): Promise<unknown[]> => {
        try {
          const res = await fetch(`${b.target}${path}`, { signal: AbortSignal.timeout(healthTimeoutMs) });
          if (!res.ok) return [];
          const data = (await res.json()) as unknown;
          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  };

  // --- HTTP proxy (no body: GET instance routes) -----------------------------
  const proxyHttp = (b: BackendState, req: Request, res: Response): void => {
    const preq = httpRequest(
      { host: b.host, port: b.port, method: req.method, path: req.originalUrl, headers: { ...req.headers, host: `${b.host}:${b.port}` } },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
      },
    );
    preq.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "backend unavailable" });
    });
    req.pipe(preq);
  };

  // --- HTTP surface ----------------------------------------------------------
  const app: Express = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.type("text/plain").send("ok");
  });
  app.get("/version", (_req: Request, res: Response) => {
    res.json(resolveVersion({ appName, deployVersion: opts.deployVersion ?? { app: appName } }));
  });
  /** Router-only: which backends the router sees as up/down (ops visibility). */
  app.get("/api/backends", (_req: Request, res: Response) => {
    res.json([...backends.values()].map((b): BackendLiveness => ({ moduleId: b.moduleId, target: b.target, up: b.up, version: b.version, lastOkAt: b.lastOkAt })));
  });

  app.get("/api/games", (_req: Request, res: Response) => {
    void fanOut("/api/games").then((games) => res.json(games));
  });
  app.get("/api/modules", (_req: Request, res: Response) => {
    void fanOut("/api/modules").then((modules) => res.json(modules));
  });

  app.post("/api/games", (req: Request, res: Response) => {
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId : "";
    if (!MODULE_ID_RE.test(moduleId) || !backends.has(moduleId)) {
      res.status(400).json({ error: `unknown or invalid moduleId: ${moduleId}` });
      return;
    }
    const b = liveTarget(moduleId);
    if (!b) {
      res.status(503).json({ error: `game '${moduleId}' is not available right now` });
      return;
    }
    const body = JSON.stringify(req.body ?? {});
    const preq = httpRequest(
      { host: b.host, port: b.port, method: "POST", path: "/api/games", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
      },
    );
    preq.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "backend unavailable" });
    });
    preq.end(body);
  });

  // Per-instance traffic: any path whose first segment is a known module and that
  // has at least two segments (/<moduleId>/<instanceId>/...) proxies to that
  // backend — by moduleId alone, so the router never tracks instanceIds. A known
  // module that is down 503s; an unknown first segment falls through to the portal.
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    const parts = req.path.split("/").filter(Boolean);
    const moduleId = parts[0];
    if (parts.length < 2 || !moduleId || !backends.has(moduleId)) return next();
    const b = liveTarget(moduleId);
    if (!b) {
      res.status(503).json({ error: `game '${moduleId}' is not available right now` });
      return;
    }
    proxyHttp(b, req, res);
  });

  // The portal SPA at `/`. Registered last so the API + per-instance routes win.
  if (opts.portalDir) app.use(express.static(opts.portalDir));

  const httpServer = createNodeServer(app);

  // Proxy the websocket upgrade by the same first-path-segment rule. We replay the
  // client's raw upgrade request to the backend verbatim (same path + headers, incl.
  // Sec-WebSocket-Key) and pipe the two sockets; the backend hub routes the upgrade
  // to the instance and its 101 flows straight back.
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const parts = pathname.split("/").filter(Boolean);
    const b = parts.length >= 2 && parts[0] ? liveTarget(parts[0]) : null;
    if (!b) {
      socket.destroy();
      return;
    }
    const backendSock = netConnect(b.port, b.host, () => {
      let raw = `GET ${req.url} HTTP/1.1\r\n`;
      const h = req.rawHeaders;
      for (let i = 0; i < h.length; i += 2) raw += `${h[i]}: ${h[i + 1]}\r\n`;
      raw += "\r\n";
      backendSock.write(raw);
      if (head && head.length) backendSock.write(head);
      socket.pipe(backendSock);
      backendSock.pipe(socket);
    });
    backendSock.on("error", () => socket.destroy());
    socket.on("error", () => backendSock.destroy());
  });

  return {
    httpServer,
    listen(port, cb) {
      return httpServer.listen(port, cb);
    },
    close() {
      clearInterval(monitor);
      httpServer.close();
    },
    liveness() {
      return [...backends.values()].map((b) => ({ moduleId: b.moduleId, target: b.target, up: b.up, version: b.version, lastOkAt: b.lastOkAt }));
    },
  };
}
