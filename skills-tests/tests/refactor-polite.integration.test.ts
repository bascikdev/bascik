/**
 * Polite production in a real browser: the fixture page (tests/fixtures/refactor-parity/polite/) fires a Vercel Web
 * Analytics hit, a request to a third-party tracker host, a form POST and a plain GET as soon as it loads, like a site
 * with analytics tags and a contact form.
 *
 * Why: every bascik-refactor script loads production once per check, route and matrix case, and the crawl reloads it
 * per control, so one route run sent hundreds of synthetic page views to a portfolio owner's analytics. Chromium maps
 * prod.test, target.test and tracker.test to the fixture server, so every request that is not blocked reaches it, and
 * the server's request counter proves which ones never left the browser.
 * Misuse lens: a target that posts to its own server (allowed), no block list (the analytics hit goes out: the
 * control), and a production-only run with no target (every write refused), through capture-baselines.mjs's own CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  DEFAULT_BLOCK,
  openPage,
  politeBrowser,
} from "../../skills/bascik-refactor/scripts/lib/capture.mjs";
import {
  packageDir,
  serveFixtures,
  type FixtureServer,
} from "./refactor-parity-fixtures.ts";

const SCRIPTS = fileURLToPath(
  new URL("../../skills/bascik-refactor/scripts/", import.meta.url),
);
const CASE = { width: 800, height: 600 };

let server: FixtureServer;
let raw: any;
let port: string;
let tmp: string;

beforeAll(async () => {
  server = await serveFixtures();
  port = new URL(server.origin).port;
  tmp = mkdtempSync(join(tmpdir(), "bascik-polite-"));
  const { chromium } = await loadPlaywright({ cwd: packageDir });
  raw = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP prod.test 127.0.0.1, MAP target.test 127.0.0.1, MAP tracker.test 127.0.0.1",
    ],
  });
}, 60_000);

afterAll(async () => {
  await raw?.close();
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Opens the fixture page on `origin` through `browser` and returns what each probe saw. */
async function probes(browser: any, origin: string) {
  const { context, page } = await openPage(browser, `${origin}/polite/`, CASE);
  try {
    await page.waitForFunction("document.body.dataset.results");
    return JSON.parse(
      await page.evaluate('document.body.dataset.results ?? "{}"'),
    );
  } finally {
    await context.close();
  }
}

/** The server's request counts for the probe paths since the last call. */
function counter() {
  const paths: Record<string, string> = {
    analytics: "/_vercel/insights",
    tracker: "/polite/collect",
    post: "/polite/form",
    get: "/polite/data.json",
  };
  const last: Record<string, number> = {};
  return async () => {
    const out: Record<string, number> = {};
    for (const [name, path] of Object.entries(paths)) {
      const n = await server.requests(path);
      out[name] = n - (last[name] ?? 0);
      last[name] = n;
    }
    return out;
  };
}

describe("polite production", () => {
  it("blocks analytics and refuses writes on production, and lets the target post to itself", async () => {
    const prod = `http://prod.test:${port}`;
    const target = `http://target.test:${port}`;
    const browser = politeBrowser(raw, {
      prod,
      target,
      block: [...DEFAULT_BLOCK, "tracker.test"],
    });
    const delta = counter();
    await delta();
    expect(await probes(browser, prod)).toEqual({
      analytics: "blocked",
      tracker: "blocked",
      post: "blocked",
      get: "ok",
    });
    expect(await delta()).toEqual({
      analytics: 0,
      tracker: 0,
      post: 0,
      get: 1,
    });
    // The target's own form post is not production; the tags stay blocked there too, so both sides match.
    expect(await probes(browser, target)).toEqual({
      analytics: "blocked",
      tracker: "blocked",
      post: "ok",
      get: "ok",
    });
    expect(await delta()).toEqual({
      analytics: 0,
      tracker: 0,
      post: 1,
      get: 1,
    });
    expect(browser.politeStats).toEqual({ blocked: 4, refused: 1, paced: 0 });
  });

  it("lets the analytics and tracker requests out with no block list (the control), and still refuses the POST", async () => {
    const prod = `http://prod.test:${port}`;
    const browser = politeBrowser(raw, { prod, block: [] });
    const delta = counter();
    await delta();
    expect(await probes(browser, prod)).toEqual({
      analytics: "ok",
      tracker: "ok",
      post: "blocked",
      get: "ok",
    });
    expect(await delta()).toEqual({
      analytics: 1,
      tracker: 1,
      post: 0,
      get: 1,
    });
    expect(browser.politeStats).toEqual({ blocked: 0, refused: 1, paced: 0 });
  });

  it("spaces production page loads by --min-interval-ms", async () => {
    const prod = `http://prod.test:${port}`;
    const browser = politeBrowser(raw, { prod, minIntervalMs: 400 });
    const started = Date.now();
    for (let i = 0; i < 3; i++) await probes(browser, prod);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    expect(browser.politeStats.paced).toBe(2);
  }, 30_000);

  it("capture-baselines (a production-only CLI) blocks the analytics, the --block host and the POST", async () => {
    const matrix = join(tmp, "breakpoints.json");
    writeFileSync(matrix, JSON.stringify({ cases: [CASE] }));
    const delta = counter();
    await delta();
    const run = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "capture-baselines.mjs"),
        "--prod",
        `${server.origin}/polite`,
        "--route",
        "/",
        "--matrix",
        matrix,
        "--out",
        join(tmp, "baselines"),
        "--no-prod-cache",
        "--settle-ms",
        "0",
        "--block",
        "tracker.test",
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
    );
    expect(run.stderr).not.toMatch(/capture-baselines:/);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /polite: 2 tracking request\(s\) blocked, 1 request\(s\) other than GET or HEAD refused/,
    );
    expect(await delta()).toEqual({
      analytics: 0,
      tracker: 0,
      post: 0,
      get: 1,
    });
  }, 150_000);
});
