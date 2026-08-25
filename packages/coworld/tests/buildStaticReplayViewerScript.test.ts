import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cogwebRoot = resolve(import.meta.dirname, "../../..");
const buildScript = join(cogwebRoot, "scripts/build-static-replay-viewer.sh");
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

function fixture(): { gameDir: string; outputDir: string; env: NodeJS.ProcessEnv; logPath: string } {
  const scratch = mkdtempSync(join(tmpdir(), "cogweb-static-viewer-"));
  scratchDirs.push(scratch);
  const gameDir = join(scratch, "game");
  const outputDir = join(scratch, "custom", "build", "static-replay-viewer");
  const binDir = join(scratch, "bin");
  const logPath = join(scratch, "pnpm-args");
  mkdirSync(gameDir);
  mkdirSync(binDir);
  const pnpm = join(binDir, "pnpm");
  writeFileSync(pnpm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${logPath}"\n`);
  chmodSync(pnpm, 0o755);
  return {
    gameDir,
    outputDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    logPath,
  };
}

describe("build-static-replay-viewer.sh", () => {
  it("builds beside a non-default Coworld manifest output", () => {
    const { gameDir, outputDir, env, logPath } = fixture();

    const result = spawnSync(buildScript, [gameDir, outputDir], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(existsSync(outputDir)).toBe(true);
    expect(readFileSync(logPath, "utf8").split("\n").filter(Boolean)).toEqual([
      "--dir",
      gameDir,
      "exec",
      "vite",
      "build",
      "--outDir",
      outputDir,
    ]);
  });

  it("rejects an output that is not a replay bundle directory", () => {
    const { gameDir, outputDir, env } = fixture();
    const unsafeOutput = dirname(dirname(outputDir));

    const result = spawnSync(buildScript, [gameDir, unsafeOutput], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe static replay viewer paths");
  });
});
