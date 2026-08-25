// The HTTP surface every cogame deploy speaks: /health and /version (the deploy
// contract — scripts/deploy-prod.sh greps /version for its deployId to prove a
// rollout end-to-end), plus the public and per-seat redacted state JSON for
// probes and tooling. The live feed itself rides the websocket (see
// websocket.ts); these routes are pull-only.
//
// The per-deploy identity is written next to the app as .deploy-version.json by
// the deploy script; /version echoes it. In dev (no file) it falls back to env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express, Request, Response } from "express";
import type { Snapshot } from "@cogweb/protocol";

/** The /version payload. `deployId` is load-bearing: the deploy script verifies
 *  the rollout by polling /version for the exact id it stamped. */
export interface VersionInfo {
  app: string;
  deployId: string;
  commit: string;
  deployedAt: string;
}

export interface HttpAppOptions {
  /** Human-readable app name, echoed in /version. */
  appName: string;
  /** The version this process was built/deployed as; overridden by
   *  .deploy-version.json on disk when present. */
  deployVersion: Partial<VersionInfo>;
  /** The public, redacted snapshot served at /state.json. */
  getPublicState: () => Snapshot;
  /** The per-seat redacted snapshot served at /cog/:seat/state.json. */
  getSeatState: (seat: number) => Snapshot;
  /** Gate per-seat state: returns true iff `token` may view `seat`. */
  verifySeatToken: (seat: number, token: string | undefined) => boolean;
}

/** Read the per-deploy stamp from cwd, layering env/option fallbacks under it.
 *  The deploy script writes .deploy-version.json with at least { app, commit,
 *  deployId, deployedAt } — we echo whatever it set. */
export function resolveVersion(opts: { appName: string; deployVersion: Partial<VersionInfo> }): VersionInfo {
  const fromEnv: Partial<VersionInfo> = {
    app: process.env.DEPLOY_APP,
    deployId: process.env.DEPLOY_ID,
    commit: process.env.DEPLOY_COMMIT,
    deployedAt: process.env.DEPLOY_AT,
  };
  const file = join(process.cwd(), ".deploy-version.json");
  const fromFile: Partial<VersionInfo> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Partial<VersionInfo>)
    : {};
  return {
    app: fromFile.app ?? opts.deployVersion.app ?? fromEnv.app ?? opts.appName,
    deployId: fromFile.deployId ?? opts.deployVersion.deployId ?? fromEnv.deployId ?? "dev",
    commit: fromFile.commit ?? opts.deployVersion.commit ?? fromEnv.commit ?? "unknown",
    deployedAt: fromFile.deployedAt ?? opts.deployVersion.deployedAt ?? fromEnv.deployedAt ?? "unknown",
  };
}

export function createHttpApp(opts: HttpAppOptions): Express {
  const app = express();

  // Plain "ok", no trailing newline: the deploy script greps for `^ok$`.
  app.get("/health", (_req: Request, res: Response) => {
    res.type("text/plain").send("ok");
  });

  // The deploy contract: per-deploy identity, re-read per request so a rollout
  // that swaps the file is reflected without a restart.
  app.get("/version", (_req: Request, res: Response) => {
    res.json(resolveVersion(opts));
  });

  app.get("/state.json", (_req: Request, res: Response) => {
    res.json(opts.getPublicState());
  });

  app.get("/cog/:seat/state.json", (req: Request, res: Response) => {
    const seat = Number(req.params.seat);
    if (!Number.isInteger(seat)) {
      res.status(400).json({ error: "seat must be an integer" });
      return;
    }
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    if (!opts.verifySeatToken(seat, token)) {
      res.status(403).json({ error: "invalid or missing seat token" });
      return;
    }
    res.json(opts.getSeatState(seat));
  });

  return app;
}
