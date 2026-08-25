// Coworld artifact IO. The platform injects three URIs as env vars and the game
// runnable reads its config and writes results + replay there:
//   COGAME_CONFIG_URI       (read)  the per-episode config — zod-validated on read
//   COGAME_RESULTS_URI      (write) the results artifact    — matches results_schema
//   COGAME_SAVE_REPLAY_URI  (write) the replay artifact     — the timeline to scrub
//
// file:// (and bare paths) are implemented; s3:// is a defined seam that throws
// until a host wires an S3 client. Fail loud — a missing URI, bad scheme, or
// non-2xx HTTP throws rather than silently degrading.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";

const USER_AGENT = "cogweb-coworld/0.1";

// ---------------------------------------------------------------------------
// URI scheme handling
// ---------------------------------------------------------------------------

function localPath(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/** Read raw bytes from a config/results/replay URI. */
async function readBytes(uri: string): Promise<Buffer> {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const res = await fetch(uri, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`read ${uri} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (uri.startsWith("s3://")) {
    // Seam: a host that runs on S3 wires an S3 client here. file:// / presigned
    // http(s):// cover local + hosted runs, so this stays unimplemented.
    throw new Error(`s3:// artifact IO not wired in this build: ${uri}`);
  }
  return readFile(localPath(uri));
}

/** Write a string to a config/results/replay URI. */
async function writeBytes(uri: string, data: string, contentType: string): Promise<void> {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const res = await fetch(uri, {
      method: "PUT",
      headers: { "Content-Type": contentType, "User-Agent": USER_AGENT },
      body: data,
    });
    if (!res.ok) throw new Error(`write ${uri} -> HTTP ${res.status}`);
    return;
  }
  if (uri.startsWith("s3://")) {
    throw new Error(`s3:// artifact IO not wired in this build: ${uri}`);
  }
  const path = localPath(uri);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

// ---------------------------------------------------------------------------
// Env-var resolution
// ---------------------------------------------------------------------------
//
// FROZEN EXTERNAL CONTRACT — do NOT rename to COGWEB_*. The Softmax coworld
// platform runner *injects* these env var names; we only read them, so the
// literals must match what the platform sets, exactly. They are intentionally
// the one place "COGAME_" survives the @cogweb rename — alongside the
// COGAME_HOST/COGAME_PORT bind vars and COGAME_*_METHOD each game's coworld
// game-cli reads, and the polis-cogame-deploy S3 bucket in deploy/.

export const CONFIG_URI_ENV = "COGAME_CONFIG_URI";
export const RESULTS_URI_ENV = "COGAME_RESULTS_URI";
// The platform runner injects the replay sink as COGAME_SAVE_REPLAY_URI
// (COGAME_LOAD_REPLAY_URI is the replay-mode source); match it exactly.
export const REPLAY_URI_ENV = "COGAME_SAVE_REPLAY_URI";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ---------------------------------------------------------------------------
// Config / results / replay
// ---------------------------------------------------------------------------

/** Read the episode config from `COGAME_CONFIG_URI` and validate it. */
export async function readConfig<Config>(schema: ZodType<Config>): Promise<Config> {
  const uri = requireEnv(CONFIG_URI_ENV);
  const bytes = await readBytes(uri);
  return schema.parse(JSON.parse(bytes.toString("utf-8")));
}

/** Validate and write the results artifact to `COGAME_RESULTS_URI`. */
export async function writeResults<Results>(schema: ZodType<Results>, results: Results): Promise<void> {
  const uri = requireEnv(RESULTS_URI_ENV);
  const validated = schema.parse(results);
  await writeBytes(uri, JSON.stringify(validated), "application/json");
}

/** Write the replay artifact (the scrubber timeline) to `COGAME_REPLAY_URI`. */
export async function writeReplay(replay: unknown): Promise<void> {
  const uri = requireEnv(REPLAY_URI_ENV);
  await writeBytes(uri, JSON.stringify(replay), "application/json");
}

/** Whether a replay sink is configured (the artifact is optional). */
export function hasReplayUri(): boolean {
  return Boolean(process.env[REPLAY_URI_ENV]);
}
