// The multi-game hub: one server hosting many concurrent game instances. Where
// createGameServer binds one process to one module and one perpetual room, the
// hub holds two registries — a static map of game MODULES (descriptors) and a
// live map of running INSTANCES — and routes HTTP + websocket traffic to the
// right instance by URL path (/<moduleId>/<instanceId>/...). Each instance is a
// createInstance() result (lobby + per-instance wiring + websocket), so all the
// per-game machinery (lobby, runner, redaction, sticky seats) is reused as-is and
// the single- and multi-game servers share one spin-up path.
//
// State is in-memory: a restart drops in-progress games. The most-recently-finished
// games are RETAINED (so they stay listed and observable — jump in as a spectator to
// see the final board + scorecard + scrubber); older finished games get reaped, and a
// cap bounds how many instances live at once.

import { createServer as createNodeServer } from "node:http";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { PlayerKind, RuleOption } from "@cogweb/protocol";
import { resolveVersion } from "./http";
import type { VersionInfo } from "./http";
import { createInstance } from "./instance";
import type { GameDescriptor, RunningGameInstance } from "./instance";

export interface HubOptions {
  descriptors: GameDescriptor[];
  appName?: string;
  deployVersion?: Partial<VersionInfo>;
  /** Directory of the portal SPA served at `/` (the live-games list + new-game
   *  picker). Served after the API + per-instance routes so it only catches the
   *  root and its own assets. */
  portalDir?: string;
  /** Max concurrent instances. Creating past it reaps the oldest finished one;
   *  if none can be reaped, create() throws. Default 50. */
  maxInstances?: number;
  /** How many finished games to keep listed + observable. The reaper retains the
   *  N most-recently-finished instances and destroys older ones. Default 10. */
  finishedRetain?: number;
  /** How long a never-started lobby game with no connected clients lingers before
   *  it is reaped — an abandoned configure draft (the portal creates an instance per
   *  configure visit so its share link resolves; one left without starting never
   *  reaches the finished-game reaper). Default 15 min. */
  unstartedTtlMs?: number;
  /** Reaper tick interval. Default 30s. */
  reapIntervalMs?: number;
}

/** One seat in a GameSummary roster — enough for a lobby card's player chips
 *  (human/bot/open, the display name, a bot's model). The seat's `joinToken` is
 *  deliberately omitted: it is a per-seat secret that only reaches the table's own
 *  websocket clients (a per-seat invite link), never this public games listing. */
export interface SeatSummary {
  seat: number;
  name: string;
  kind: PlayerKind;
  /** The model an autopiloted seat runs (null = the game's default); null for a
   *  human or open seat. */
  model: string | null;
}

/** One row of GET /api/games. The roster + live turn/scores let the portal render
 *  rich lobby cards (who's seated, progress, leader) without an N+1 per-instance
 *  fetch; everything here is cheap to derive from the lobby + run status. */
export interface GameSummary {
  moduleId: string;
  instanceId: string;
  label: string;
  phase: string;
  /** Seated humans. */
  players: number;
  seats: number;
  /** Per-seat roster (names, kinds, bot models) for the lobby card's player chips. */
  roster: SeatSummary[];
  /** The live turn (0 before the game starts). */
  turn: number;
  /** Live per-seat scores keyed by seat string, or null pre-game / for a scoreless game. */
  scores: Record<string, number> | null;
  /** Connected spectators (seatless watchers). */
  spectators: number;
  createdAt: number;
  /** When the game reached "finished", or null if it is still forming/running.
   *  Lets the portal sort the completed-games list newest-first. */
  finishedAt: number | null;
}

/** One row of GET /api/modules: a registered game and its roster bounds, so the
 *  portal's new-game catalog can show seat ranges and hide Add/Remove for a
 *  fixed-roster game (minPlayers === maxPlayers). */
export interface ModuleSummary {
  id: string;
  minPlayers: number;
  maxPlayers: number;
  /** The game's declared rule knobs (labels + choices), so the portal's configure
   *  screen can render selects for them. Empty for a game with no knobs. */
  ruleOptions: RuleOption[];
}

interface HubInstance extends RunningGameInstance {
  moduleId: string;
  instanceId: string;
  label: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface Hub {
  readonly httpServer: HttpServer;
  /** Spin up a new instance of a registered module. Throws if the module is
   *  unknown or the cap is hit and nothing is reapable. */
  create(moduleId: string, opts?: { label?: string }): GameSummary;
  list(): GameSummary[];
  listen(port: number, cb?: () => void): HttpServer;
  close(): void;
}

const MODULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function createHub(opts: HubOptions): Hub {
  const appName = opts.appName ?? "cogweb";
  const maxInstances = opts.maxInstances ?? 50;
  const finishedRetain = opts.finishedRetain ?? 10;
  const unstartedTtlMs = opts.unstartedTtlMs ?? 15 * 60_000;
  const reapIntervalMs = opts.reapIntervalMs ?? 30_000;

  const registry = new Map<string, GameDescriptor>();
  for (const d of opts.descriptors) registry.set(d.id, d);

  // Keyed by `${moduleId}/${instanceId}` — the same string the URL path carries.
  const instances = new Map<string, HubInstance>();
  const keyOf = (moduleId: string, instanceId: string): string => `${moduleId}/${instanceId}`;

  const mintId = (moduleId: string): string => {
    for (;;) {
      const id = randomBytes(4).readUInt32BE(0).toString(36).slice(0, 5).padStart(5, "0");
      if (!instances.has(keyOf(moduleId, id))) return id;
    }
  };

  const summarize = (inst: HubInstance): GameSummary => {
    const seats = inst.lobby.state().seats;
    const status = inst.ws.status();
    return {
      moduleId: inst.moduleId,
      instanceId: inst.instanceId,
      label: inst.label,
      phase: inst.lobby.phase(),
      players: seats.filter((s) => s.kind === "human").length,
      seats: seats.length,
      roster: seats.map((s) => ({ seat: s.seat, name: s.name, kind: s.kind, model: s.bot?.model ?? null })),
      turn: status.turn,
      scores: status.scores,
      spectators: inst.ws.spectators(),
      createdAt: inst.createdAt,
      finishedAt: inst.finishedAt,
    };
  };

  const destroy = (inst: HubInstance): void => {
    inst.ws.close();
    instances.delete(keyOf(inst.moduleId, inst.instanceId));
  };

  /** Retain the `finishedRetain` most-recently-finished games; reap the rest. Stamps
   *  `finishedAt` the first tick a game is seen finished (so the order is stable) and
   *  clears it if a game somehow leaves the finished phase. Returns true if it freed
   *  at least one instance. */
  const reapFinished = (now: number): boolean => {
    const finished: HubInstance[] = [];
    for (const inst of instances.values()) {
      if (inst.lobby.phase() === "finished") {
        inst.finishedAt ??= now;
        finished.push(inst);
      } else {
        inst.finishedAt = null;
      }
    }
    // Newest first; everything past the retention window is reaped.
    finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    let freed = false;
    for (const inst of finished.slice(finishedRetain)) {
      destroy(inst);
      freed = true;
    }
    return freed;
  };

  /** Reap never-started lobby games that no client is connected to, past their TTL —
   *  abandoned configure drafts. The `clientCount() === 0` guard means a game anyone
   *  is still configuring (or waiting in) is never reaped, however old. */
  const reapAbandonedDrafts = (now: number): void => {
    for (const inst of [...instances.values()]) {
      if (inst.lobby.phase() === "lobby" && inst.ws.clientCount() === 0 && now - inst.createdAt > unstartedTtlMs) {
        destroy(inst);
      }
    }
  };

  const create = (moduleId: string, createOpts?: { label?: string }): GameSummary => {
    const descriptor = registry.get(moduleId);
    if (!descriptor) throw new HubError(`unknown game module: ${moduleId}`);

    if (instances.size >= maxInstances) {
      // Try to make room by reaping a finished game whose TTL is up; if the oldest
      // finished game is still within TTL, force-reap it rather than reject.
      if (!reapFinished(Date.now())) {
        const finished = [...instances.values()]
          .filter((i) => i.lobby.phase() === "finished")
          .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[0];
        if (finished) destroy(finished);
        else throw new HubError(`instance cap reached (${maxInstances}) and no finished game to reap`);
      }
    }

    const instanceId = mintId(moduleId);
    const running = createInstance(descriptor, instanceId);
    const inst: HubInstance = {
      ...running,
      moduleId,
      instanceId,
      label: createOpts?.label?.trim() || instanceId,
      createdAt: Date.now(),
      finishedAt: null,
    };
    instances.set(keyOf(moduleId, instanceId), inst);
    return summarize(inst);
  };

  // --- HTTP -----------------------------------------------------------------
  const app: Express = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.type("text/plain").send("ok");
  });
  app.get("/version", (_req: Request, res: Response) => {
    res.json(resolveVersion({ appName, deployVersion: opts.deployVersion ?? { app: appName } }));
  });

  app.get("/api/games", (_req: Request, res: Response) => {
    res.json([...instances.values()].map(summarize));
  });
  app.get("/api/modules", (_req: Request, res: Response) => {
    res.json(
      [...registry.values()].map(
        (d): ModuleSummary => ({
          id: d.id,
          minPlayers: d.module.game.minPlayers,
          maxPlayers: d.module.game.maxPlayers,
          ruleOptions: d.module.game.ruleOptions ?? [],
        }),
      ),
    );
  });
  app.post("/api/games", (req: Request, res: Response) => {
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId : "";
    if (!MODULE_ID_RE.test(moduleId) || !registry.has(moduleId)) {
      res.status(400).json({ error: `unknown or invalid moduleId: ${moduleId}` });
      return;
    }
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    try {
      res.status(201).json(create(moduleId, { label }));
    } catch (err) {
      // Instance-cap exhaustion is a capacity condition, not a server fault: return
      // a clean 503 JSON rather than letting it become an Express 500 HTML page that
      // leaks the stack trace + server filesystem paths. Any other error is a real
      // bug — let it surface.
      if (!(err instanceof HubError)) throw err;
      res.status(503).json({ error: err.message });
    }
  });

  // Per-instance pull routes. The live feed itself rides the websocket.
  const seg = (v: unknown): string => (typeof v === "string" ? v : "");
  const lookup = (req: Request, res: Response): HubInstance | null => {
    const inst = instances.get(keyOf(seg(req.params.moduleId), seg(req.params.instanceId)));
    if (!inst) {
      res.status(404).json({ error: "no such game" });
      return null;
    }
    return inst;
  };

  app.get("/:moduleId/:instanceId/state.json", (req: Request, res: Response) => {
    const inst = lookup(req, res);
    if (inst) res.json(inst.ws.snapshot(null));
  });
  app.get("/:moduleId/:instanceId/cog/:seat/state.json", (req: Request, res: Response) => {
    const inst = lookup(req, res);
    if (!inst) return;
    const seat = Number(req.params.seat);
    if (!Number.isInteger(seat)) {
      res.status(400).json({ error: "seat must be an integer" });
      return;
    }
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    if (!inst.verifySeatToken(seat, token)) {
      res.status(403).json({ error: "invalid or missing seat token" });
      return;
    }
    res.json(inst.ws.snapshot(seat));
  });

  // Serve each instance's built client under its path prefix. The game's vite
  // build uses base "./" (relative asset URLs), so we canonicalize the bare
  // instance URL to a trailing slash — only then do "./assets/x" resolve under
  // /<moduleId>/<instanceId>/. Everything below the prefix is served from the
  // game's clientDir, with an index.html fallback for the SPA.
  const safeAsset = (clientDir: string, rel: string): string | null => {
    const root = resolve(clientDir);
    const target = resolve(root, rel);
    // No path traversal: the target must be the root itself or strictly inside it.
    // A bare startsWith(root) would also accept a sibling dir sharing the prefix
    // (e.g. `<root>/../dist-server` from a `dist` root), so anchor on root + sep.
    return target === root || target.startsWith(root + sep) ? target : null;
  };
  app.get("/:moduleId/:instanceId", (req: Request, res: Response, next: NextFunction) => {
    // Express routing is non-strict, so this also matches the trailing-slash form
    // `/<mod>/<id>/` — which must be SERVED (by the catch-all below), not redirected,
    // or it redirects to itself forever. Only the bare, no-slash form redirects.
    if (req.path.endsWith("/")) return next();
    if (!lookup(req, res)) return;
    res.redirect(308, `/${seg(req.params.moduleId)}/${seg(req.params.instanceId)}/`);
  });
  app.get("/:moduleId/:instanceId/*", (req: Request, res: Response) => {
    const inst = lookup(req, res);
    if (!inst) return;
    const clientDir = registry.get(inst.moduleId)?.clientDir;
    if (!clientDir) {
      res.status(404).json({ error: "no client bundle for this game" });
      return;
    }
    const rel = seg((req.params as Record<string, unknown>)["0"]);
    const asset = rel ? safeAsset(clientDir, rel) : null;
    res.sendFile(asset && existsSync(asset) ? asset : join(clientDir, "index.html"));
  });

  // The portal SPA at `/` (and its own assets). Registered last so the API and
  // per-instance routes above win; this only catches the root + portal assets.
  if (opts.portalDir) app.use(express.static(opts.portalDir));

  const httpServer = createNodeServer(app);

  // The hub owns the single upgrade event and routes each ws upgrade to the
  // instance named in its path: /<moduleId>/<instanceId>[/ws].
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const parts = pathname.split("/").filter(Boolean);
    const inst = parts.length >= 2 ? instances.get(keyOf(parts[0]!, parts[1]!)) : undefined;
    if (!inst) {
      socket.destroy();
      return;
    }
    inst.ws.handleUpgrade(req, socket, head);
  });

  const reaper = setInterval(() => {
    const now = Date.now();
    reapFinished(now);
    reapAbandonedDrafts(now);
  }, reapIntervalMs);
  // Don't keep the process alive just for the reaper.
  reaper.unref?.();

  return {
    httpServer,
    create,
    list: () => [...instances.values()].map(summarize),
    listen(port, cb) {
      return httpServer.listen(port, cb);
    },
    close() {
      clearInterval(reaper);
      for (const inst of instances.values()) inst.ws.close();
      instances.clear();
      httpServer.close();
    },
  };
}

/** An invalid hub operation (unknown module, cap hit). */
export class HubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubError";
  }
}
