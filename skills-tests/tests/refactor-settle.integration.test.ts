/**
 * One settle for every capture, in a real browser, from the fixtures in tests/fixtures/refactor-parity/settle/.
 *
 * Why: compare-route screenshotted right after `load`, without the settle and quiet wait every parity check uses, and
 * no capture scrolled the page. On the trial sites that made a banner mounted after hydration, a caption still typing
 * itself out, a lazy photo far below the fold and a card that fades in on scroll differ between production and the
 * target on every run, although the finished pages matched to the pixel. The production fixture renders all four
 * late; the target renders the finished page statically, the way a Bascik build does. compare-route must report 0%.
 *
 * geometry-diff.mjs captures the same way: before it waited, the caption was still typing when it read the boxes, so
 * its paragraph was missing on one side and extra on the other.
 *
 * Misuse lens: `scroll-behavior: smooth` on the page (the scroll-through must still end at the top at once), and an
 * infinite-scroll page that grows every time its end scrolls into view (the scroll-through must stop at its cap).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPage } from "../../skills/bascik-refactor/scripts/lib/capture.mjs";
import {
  loadPlaywright,
  loadSharp,
} from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  packageDir,
  serveFixtures,
  type FixtureServer,
} from "./refactor-parity-fixtures.ts";

const SCRIPTS = fileURLToPath(
  new URL("../../skills/bascik-refactor/scripts/", import.meta.url),
);
const PHONE = { width: 360, height: 812 };

let server: FixtureServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;
let out: string;

beforeAll(async () => {
  server = await serveFixtures();
  const { chromium } = await loadPlaywright({ cwd: packageDir });
  browser = await chromium.launch();
  out = mkdtempSync(join(tmpdir(), "bascik-settle-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const site = (side: "prod" | "target" | "endless") =>
  `${server.origin}/settle/${side}/`;

describe("settle scrolls the page through and back", () => {
  it("loads a lazy image 9,000 px down, reveals a card that fades in on scroll, and ends at the top of a smooth-scrolling page", async () => {
    const { context, page } = await openPage(browser, site("prod"), PHONE);
    try {
      // A string expression: the page's DOM types are not in this workspace's lib.
      const state = await page.evaluate(`({
        photo: document.getElementById("photo").complete &&
          document.getElementById("photo").naturalWidth > 0,
        revealed: getComputedStyle(document.querySelector("[data-reveal]")).opacity,
        scrollY: window.scrollY,
      })`);
      expect(state).toEqual({ photo: true, revealed: "1", scrollY: 0 });
    } finally {
      await context.close();
    }
  }, 30_000);

  it("misuse: an infinite-scroll page that grows on every scroll still settles, at the top, within its cap", async () => {
    const started = Date.now();
    const { context, page } = await openPage(browser, site("endless"), PHONE);
    try {
      const elapsed = Date.now() - started;
      const state = await page.evaluate(`({
        scrollY: window.scrollY,
        pages: document.querySelectorAll(".page").length,
      })`);
      expect(state.scrollY).toBe(0);
      expect(elapsed).toBeLessThan(20_000);
      // It grew while scrolled through (proof the pass scrolled), but a bounded number of times.
      expect(state.pages).toBeGreaterThan(1);
      expect(state.pages).toBeLessThan(200);
    } finally {
      await context.close();
    }
  }, 40_000);
});

describe("compare-route waits like the checks", () => {
  it("reports 0% between production that renders late and a target that renders the same page statically", async () => {
    const matrix = join(out, "breakpoints.json");
    writeFileSync(matrix, JSON.stringify({ cases: [PHONE] }));
    const dir = join(out, "compare");
    const run = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "compare-route.mjs"),
        "--prod",
        site("prod"),
        "--target",
        site("target"),
        "--route",
        "/",
        "--matrix",
        matrix,
        "--evidence",
        "#photo",
        "--out",
        dir,
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
    );
    const text = `${run.stdout}\n${run.stderr}`;
    expect(run.status, text).toBe(0);
    const reportFile = text.match(/\((.+report\.json)\)/)?.[1];
    expect(reportFile, text).toBeTruthy();
    const report = JSON.parse(readFileSync(reportFile!, "utf8"));
    const [c] = report.cases;
    expect(c.problems, text).toEqual([]);
    expect(c.pixels.count, text).toBe(0);
    // Production's full-page screenshot draws the lazy photo, not an empty box.
    const rect = c.evidence.prod.elements["#photo"].rect;
    const sharp = await loadSharp({ cwd: packageDir });
    const { data, info } = await sharp(c.screenshots.prod)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const x = rect.x + Math.floor(rect.w / 2);
    const y = rect.y + Math.floor(rect.h / 2);
    const i = (y * info.width + x) * info.channels;
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([0xc0, 0x39, 0x2b]);
  }, 150_000);
});

describe("geometry-diff waits like the checks", () => {
  it("reports no moved, missing or extra node between production that renders late and the static target", () => {
    const matrix = join(out, "geometry-breakpoints.json");
    writeFileSync(matrix, JSON.stringify({ cases: [PHONE] }));
    const run = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "geometry-diff.mjs"),
        "--prod",
        site("prod"),
        "--target",
        site("target"),
        "--route",
        "/",
        "--matrix",
        matrix,
        "--json",
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
    );
    const text = `${run.stdout}\n${run.stderr}`;
    expect(run.status, text).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.ok, text).toBe(true);
    const [c] = report.results;
    expect(c, text).toMatchObject({ moved: [], missing: [], extra: [] });
  }, 150_000);

  it("misuse: --settle-ms 0 still waits for the DOM to go quiet, so the typing caption is finished", () => {
    const matrix = join(out, "geometry-breakpoints-0.json");
    writeFileSync(matrix, JSON.stringify({ cases: [PHONE] }));
    const run = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "geometry-diff.mjs"),
        "--prod",
        site("prod"),
        "--target",
        site("target"),
        "--matrix",
        matrix,
        "--settle-ms",
        "0",
        "--json",
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
    );
    const text = `${run.stdout}\n${run.stderr}`;
    expect(run.status, text).toBe(0);
    expect(JSON.parse(run.stdout).ok, text).toBe(true);
  }, 150_000);
});
