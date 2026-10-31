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
 * A service worker (tests/fixtures/refactor-parity/polite-sw/) sends its own analytics hit and POST beacon, which
 * context.route never sees, once it controls a reloaded page; every check CLI and run-checks are spawned against the
 * fixture so a main that went back to a bare chromium.launch() fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  contextOptions,
  DEFAULT_BLOCK,
  installPolitePolicy,
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
    const browser = politeBrowser(raw, { prod, minIntervalMs: 1500 });
    const started = Date.now();
    for (let i = 0; i < 3; i++) await probes(browser, prod);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    // A load slower than the interval needs no wait, so a busy machine may pace fewer than two.
    expect(browser.politeStats.paced).toBeGreaterThanOrEqual(1);
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

  /** Loads the service worker fixture on `origin`, reloads it the way the crawl does, and returns the probe text. */
  async function serviceWorkerProbe(
    opened: { context: any; page?: any },
    origin: string,
  ) {
    const { context } = opened;
    const page = opened.page ?? (await context.newPage());
    try {
      await page.goto(`${origin}/polite-sw/`, { waitUntil: "load" });
      await page.waitForFunction("document.body.dataset.sw");
      const sw = await page.evaluate("document.body.dataset.sw");
      await page.reload({ waitUntil: "load" });
      if (sw !== "ready") return sw;
      await page.waitForFunction("document.body.dataset.probe");
      return await page.evaluate("document.body.dataset.probe");
    } finally {
      await context.close();
    }
  }

  /** The analytics hits and beacons the service worker fixture sent since the last call. */
  function workerCounter() {
    const last = { analytics: 0, beacon: 0 };
    return async () => {
      const now = {
        analytics: await server.requests("/_vercel/insights/sw"),
        beacon: await server.requests("/polite-sw/beacon"),
      };
      const out = {
        analytics: now.analytics - last.analytics,
        beacon: now.beacon - last.beacon,
      };
      Object.assign(last, now);
      return out;
    };
  }

  it("the fixture's worker controls a reloaded page and fetches on its own (the control)", async () => {
    // 127.0.0.1 is a secure context, so the worker registers. The context has the route policy with an empty block
    // list and no block of service workers, which is how politeBrowser opened contexts before. Chromium routes the
    // worker's own fetches, so its POST is refused, but the page's ./probe never reaches the route: the worker answers
    // it, and a worker can answer any later load from its cache without production or the policy seeing it.
    const context = await raw.newContext(contextOptions(CASE));
    await installPolitePolicy(context, {
      prod: server.origin,
      matches: () => undefined,
      minIntervalMs: 0,
      next: 0,
      stats: { blocked: 0, refused: 0, paced: 0 },
    });
    const delta = workerCounter();
    await delta();
    expect(await serviceWorkerProbe({ context }, server.origin)).toBe(
      "ok,blocked",
    );
    expect(await delta()).toEqual({ analytics: 1, beacon: 0 });
  });

  it("politeBrowser blocks service workers on both sides, so a worker sends no analytics or beacon", async () => {
    const browser = politeBrowser(raw, { prod: server.origin });
    const delta = workerCounter();
    await delta();
    const context = async (options?: object) => ({
      context: await browser.newContext(options),
    });
    for (const open of [
      () => context(contextOptions(CASE)),
      // A caller that asks for service workers still gets them blocked.
      () => context({ ...contextOptions(CASE), serviceWorkers: "allow" }),
      async () => {
        const page = await browser.newPage();
        return { context: page.context(), page };
      },
    ])
      expect(await serviceWorkerProbe(await open(), server.origin)).toBe(
        "unavailable",
      );
    expect(await delta()).toEqual({ analytics: 0, beacon: 0 });
  }, 60_000);

  describe("every script that loads both sides runs through the polite browser", () => {
    // Production on 127.0.0.1 and the target on localhost are the same fixture page on two sites: the target's form
    // post goes to its own origin and is allowed, production's is refused, and the analytics hit is blocked on both.
    const prod = () => `http://127.0.0.1:${port}/polite`;
    const target = () => `http://localhost:${port}/polite`;
    const matrix = () => {
      const file = join(tmp, "breakpoints.json");
      writeFileSync(file, JSON.stringify({ cases: [CASE] }));
      return file;
    };
    const scripts: [string, () => string[]][] = [
      [
        "spacing-diff",
        () => [
          "--out",
          join(tmp, "spacing"),
          "--no-prod-cache",
          "--settle-ms",
          "0",
        ],
      ],
      [
        "run-checks",
        () => [
          "--only",
          "spacing-diff",
          "--out",
          join(tmp, "run-checks"),
          "--no-prod-cache",
          "--settle-ms",
          "0",
          "--target-src",
          tmp,
          "--no-legacy-repo",
        ],
      ],
      [
        "compare-route",
        () => ["--out", join(tmp, "compare"), "--settle-ms", "0"],
      ],
      ["geometry-diff", () => []],
    ];
    it.each(scripts)(
      "%s blocks the analytics and refuses production's POST",
      async (script, extra) => {
        const delta = counter();
        await delta();
        const run = spawnSync(
          process.execPath,
          [
            join(SCRIPTS, `${script}.mjs`),
            "--prod",
            prod(),
            "--target",
            target(),
            "--route",
            "/",
            "--matrix",
            matrix(),
            ...extra(),
          ],
          { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
        );
        const text = `${run.stdout}\n${run.stderr}`;
        expect(run.stderr, text).not.toMatch(new RegExp(`${script}:`));
        expect(await delta(), text).toMatchObject({
          analytics: 0,
          post: 1,
          get: 2,
        });
      },
      150_000,
    );
  });
});
