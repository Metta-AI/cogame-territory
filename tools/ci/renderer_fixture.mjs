#!/usr/bin/env node
// THE RENDERER FIXTURE RUNNER (design note test 14).
//
// Serves a built bundle over a local HTTP server (never file://: fetch and module
// resolution both behave differently there, so a file:// pass would say nothing
// about the hosted bundle), opens `tools/ci/renderer_fixture.html`, and calls the
// page's own `__territoryFixtureCheck()` at 360 / 720 / 1280 px. Any finding at
// any width fails the run.
//
// This is the substitute for `viewer_smoke.mjs --strict-text-bounds`: this
// lineage's viewer draws text in SVG/DOM, not canvas, so viewer_smoke's
// `canvas_text` counters read 0 here and prove nothing. This does the work that
// flag would have done, and it is the ONLY thing in CI that ever exercises the
// talk chrome — `docker_smoke` runs keyless, so every replay CI produces carries
// zero LLM text.
//
//   node tools/ci/renderer_fixture.mjs --bundle <dir> [--out .] [--widths 360,720,1280]
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function die(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { outDir: process.cwd(), widths: [360, 720, 1280] };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) die(2, `${argv[i]} needs a value`);
      i += 1;
      return v;
    };
    switch (argv[i]) {
      case "--bundle":
        out.bundle = resolve(next());
        break;
      case "--out":
        out.outDir = resolve(next());
        break;
      case "--widths":
        out.widths = next()
          .split(",")
          .map((w) => Number(w.trim()))
          .filter((w) => Number.isFinite(w) && w > 0);
        break;
      case "--page":
        out.page = next();
        break;
      case "-h":
      case "--help":
        die(0, "usage: renderer_fixture.mjs --bundle <dir> [--out dir] [--widths 360,720,1280]");
        break;
      default:
        die(2, `unknown argument ${argv[i]}`);
    }
  }
  if (!out.bundle) die(2, "--bundle is required");
  out.page = out.page ?? "tools/ci/renderer_fixture.html";
  return out;
}

const args = parseArgs(process.argv.slice(2));

async function loadChromium() {
  const spec = process.env.PLAYWRIGHT_MODULE ?? "playwright";
  try {
    const mod = await import(spec);
    return mod.chromium ?? mod.default?.chromium;
  } catch (error) {
    die(2, `cannot import playwright (${spec}): ${error && error.message}`);
  }
}

function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = join(dir, path === "/" ? "index.html" : path);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pagePath = join(args.bundle, args.page);
  if (!existsSync(pagePath)) {
    die(1, `::error::${args.page} is missing from ${args.bundle} — is it a vite input in vite.config.ts?`);
  }
  const chromium = await loadChromium();
  const { server, port } = await serve(args.bundle);
  const url = `http://127.0.0.1:${port}/${args.page}`;

  const browser = await chromium.launch({ headless: true });
  const results = [];
  let failed = false;
  try {
    for (const width of args.widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e && e.message)));
      await page.goto(url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForFunction("typeof window.__territoryFixtureCheck === 'function'", null, { timeout: 60_000 });
      await sleep(500);
      const report = await page.evaluate("window.__territoryFixtureCheck()");
      await page.screenshot({ path: join(args.outDir, `renderer-fixture-${width}.png`), fullPage: true });
      const entry = { width, ...report, page_errors: errors };
      results.push(entry);
      if (!report.ok || errors.length > 0) failed = true;
      console.log(
        `${width}px: ${report.ok && errors.length === 0 ? "ok" : "FAIL"} ` +
          `(${report.rows} rows checked, ${report.findings.length} findings, ${errors.length} page errors)`,
      );
      for (const f of report.findings.slice(0, 12)) {
        console.error(`  ${width}px ${f.selector}[${f.index}] ${f.problem}: ${f.detail}`);
      }
      for (const e of errors.slice(0, 5)) console.error(`  ${width}px page error: ${e}`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(args.outDir, "renderer-fixture.json"), `${JSON.stringify({ ok: !failed, results }, null, 2)}\n`);
  if (failed) die(1, "::error::renderer fixture found illegible chrome — see renderer-fixture.json");
  console.log(JSON.stringify({ ok: true, widths: args.widths }));
}

await main();
