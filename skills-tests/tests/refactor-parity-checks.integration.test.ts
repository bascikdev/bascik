/**
 * The bascik-refactor parity checks in a real browser, against the fixture pairs in tests/fixtures/refactor-parity/.
 *
 * Why: in an agent-driven refactor the automated loop passed pages that a human then caught side by side with
 * production. Each check below owns one issue type, and each has a target with exactly that defect (the check must
 * flag it) and a clean target that matches production while its markup differs like a Bascik build (the check must
 * not flag it):
 *
 *   1. interaction-crawl   a hero button that should scroll to a section does nothing
 *   2. state-capture       a nav dropdown, opened, with the wrong style and missing icons
 *   3. repeated-sections   a section on two routes pasted twice instead of one component, one copy styled wrong
 *   4. text-style-diff     links with the wrong color, weight or hover color
 *   5. spacing-diff        one vertical gap off by 24 px, which must not spill into the next section
 *   6. alignment-diff      text alignment and line count wrong at one width only
 *   7. overlap-diff        a timeline icon 2 px off the circle it sits on
 *  11. testid-carryover    production test hooks dropped, moved or renamed
 *  12. testid-coverage     interactive elements, landmarks and component roots without a data-testid
 *  13. presence-by-route   a cookie banner on only some routes: missing on one, an extra layer on another, and a
 *                          dismissal that does not persist
 *  14. production-defects  production's own squished image and misaligned icon row, copied by the target
 *  10. run-checks          one command runs them all per route and exits nonzero on any finding
 *  15. production cache    production measured once, read back on the next run (a request counter proves it), and
 *                          --cases runs a subset that the report marks partial
 *  16. production only     before any target page exists: interaction-crawl, presence-by-route and state-capture run
 *                          on production alone (the crawl also writes draft interactions.json steps), and
 *                          capture-baselines records the baselines through the cache the first run-checks reads
 *   9. review-page         the side-by-side page a human signs off on
 *
 * Every check module exports CHECK (its name) and runCheck(browser, options), which resolves to
 * { check, ok, findings }, where each finding is { check, kind, message, ... } and ok is findings.length === 0.
 * Misuse lens: smooth scrolling, an opening animation, a ticking counter (masked), hidden elements that exist on one
 * side only, hashed class names and removed wrapper elements on the clean side, a banner that slides in after load,
 * and a consent stored in a cookie on one side and in localStorage on the other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  packageDir,
  serveFixtures,
  type FixtureServer,
} from "./refactor-parity-fixtures.ts";

const SCRIPTS = fileURLToPath(
  new URL("../../skills/bascik-refactor/scripts/", import.meta.url),
);

type Finding = {
  check: string;
  kind: string;
  message: string;
  [key: string]: unknown;
};
type Result = {
  check: string;
  ok: boolean;
  findings: Finding[];
  [key: string]: unknown;
};
type CheckModule = {
  CHECK: string;
  runCheck: (
    browser: unknown,
    options: Record<string, unknown>,
  ) => Promise<Result>;
  [key: string]: unknown;
};

/** Imported per test, so a missing module fails only the tests of its check. */
const load = async (name: string): Promise<CheckModule> =>
  (await import(join(SCRIPTS, `${name}.mjs`))) as CheckModule;

const CASES = [
  { width: 400, height: 800 },
  { width: 1024, height: 800 },
];
const DESKTOP = [{ width: 1024, height: 800 }];

/** Findings as one readable string for assertion messages. */
const show = (r: Result) =>
  r.findings.map((f) => `${f.kind}: ${f.message}`).join("\n") || "(none)";

let server: FixtureServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;
let out: string;

beforeAll(async () => {
  server = await serveFixtures();
  const { chromium } = await loadPlaywright({ cwd: packageDir });
  browser = await chromium.launch();
  out = mkdtempSync(join(tmpdir(), "bascik-parity-out-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

/** runCheck with the shared options for one check and target side. */
async function run(
  name: string,
  side: "defect" | "clean",
  extra: Record<string, unknown> = {},
): Promise<Result> {
  const mod = await load(name);
  expect(mod.CHECK).toBe(name);
  const result = await mod.runCheck(browser, {
    prod: server.site(name, "prod"),
    target: server.site(name, side),
    route: "/",
    cases: DESKTOP,
    out: join(out, name, side),
    // The fixtures have no timers, so the default settle time after load would only slow the suite down.
    settleMs: 0,
    ...extra,
  });
  expect(result.check).toBe(name);
  expect(result.ok).toBe(result.findings.length === 0);
  for (const f of result.findings) {
    expect(f.check).toBe(name);
    expect(typeof f.kind).toBe("string");
    expect(typeof f.message).toBe("string");
  }
  return result;
}

describe("1. interaction-crawl", () => {
  it("discovers selector matches and listener-only elements in production", async () => {
    const mod = await load("interaction-crawl");
    const context = await browser.newContext({
      viewport: { width: 1024, height: 800 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${server.site("interaction-crawl", "prod")}/`);
      const items = (await (mod.discover as Function)(page)) as Array<{
        anchor: { text?: string; name?: string };
        reason: string;
      }>;
      const byText = (t: string) =>
        items.find((i) => i.anchor.text === t || i.anchor.name === t);
      for (const t of ["Products", "Pricing", "See features"])
        expect(byText(t), t).toBeDefined();
      // A plain <span> with a click listener: no role, no tabindex. Only CDP's DOMDebugger.getEventListeners finds it.
      expect(byText("Show details")?.reason).toBe("listener");
    } finally {
      await context.close();
    }
  }, 60_000);

  it("flags the hero button that no longer scrolls, and nothing else", async () => {
    const r = await run("interaction-crawl", "defect");
    const hit = r.findings.find(
      (f) =>
        f.kind === "missing-effect" &&
        String(f.anchor).includes("See features"),
    );
    expect(hit, show(r)).toBeDefined();
    expect(hit!.message).toMatch(/scroll/i);
    expect(
      r.findings.filter((f) => !String(f.anchor).includes("See features")),
      show(r),
    ).toEqual([]);
  }, 120_000);

  it("passes the clean target: same effects through other class names", async () => {
    const r = await run("interaction-crawl", "clean");
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("2. state-capture", () => {
  it("flags the open dropdown's style and its missing icons", async () => {
    const r = await run("state-capture", "defect");
    expect(
      r.findings.some(
        (f) => f.kind === "style" && /box-shadow|border-radius/.test(f.message),
      ),
      show(r),
    ).toBe(true);
    const icons = r.findings.find((f) => f.kind === "icons");
    expect(icons, show(r)).toBeDefined();
    // Production: an inline svg, an img and a ::before background image. Target: only the ::before.
    expect(icons!.message).toMatch(/\b3\b/);
    expect(icons!.message).toMatch(/\b1\b/);
  }, 120_000);

  it("passes the clean target after the opening animation settles, and writes both open-state crops", async () => {
    const r = await run("state-capture", "clean");
    expect(r.findings, show(r)).toEqual([]);
    const states = r.states as Array<{
      anchor: string;
      prod: { crop: string };
      target: { crop: string };
    }>;
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.some((s) => String(s.anchor).includes("Products"))).toBe(
      true,
    );
    for (const s of states) {
      expect(existsSync(s.prod.crop), s.prod.crop).toBe(true);
      expect(existsSync(s.target.crop), s.target.crop).toBe(true);
    }
  }, 120_000);
});

describe("3. repeated-sections", () => {
  const options = (side: "defect" | "clean") => ({
    route: undefined,
    routes: ["/", "/about"],
    targetSrc: server.src("repeated-sections", side),
  });

  it("flags a section pasted on two routes instead of one component, and the copy styled differently", async () => {
    const r = await run("repeated-sections", "defect", options("defect"));
    const dup = r.findings.find((f) => f.kind === "duplicated-markup");
    expect(dup, show(r)).toBeDefined();
    expect(dup!.message).toContain("/about");
    expect(dup!.message).toMatch(/src\/pages\/(index|about)\.html/);
    const diverging = r.findings.find((f) => f.kind === "diverging-instance");
    expect(diverging, show(r)).toBeDefined();
    expect(diverging!.message).toContain("/about");
    expect(diverging!.message).toMatch(/padding/);
  }, 120_000);

  it("passes one feature-grid component used on both routes with identical styles", async () => {
    const r = await run("repeated-sections", "clean", options("clean"));
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("4. text-style-diff", () => {
  const masks = { masks: ['[data-testid="ticker"]'] };

  it("flags link color and weight at rest and the hover color forced with CSS.forcePseudoState", async () => {
    const r = await run("text-style-diff", "defect", masks);
    const has = (key: string, state: string, property: string) =>
      r.findings.some(
        (f) =>
          f.kind === "style" &&
          String(f.key).includes(key) &&
          f.state === state &&
          f.property === property,
      );
    expect(has("Read the guide", "rest", "color"), show(r)).toBe(true);
    expect(has("Contact us", "rest", "font-weight"), show(r)).toBe(true);
    expect(has("Pricing details", "hover", "color"), show(r)).toBe(true);
    expect(
      r.findings.filter((f) => String(f.key).includes("Plans for every team")),
      show(r),
    ).toEqual([]);
  }, 120_000);

  it("passes the clean target with the ticking counter masked", async () => {
    const r = await run("text-style-diff", "clean", masks);
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("5. spacing-diff", () => {
  it("flags the one gap that is 24 px off at every width, within its own section only", async () => {
    const r = await run("spacing-diff", "defect", { cases: CASES });
    const gaps = r.findings.filter((f) => f.kind === "gap");
    expect(gaps.length, show(r)).toBeGreaterThanOrEqual(CASES.length);
    for (const g of gaps) {
      // Spacing is measured between blocks of content at any depth, so the gap above the list is named by its first
      // item.
      expect(String(g.key), show(r)).toMatch(/^LI:Import your tasks/);
      expect(String(g.previous), show(r)).toMatch(/^P:Three steps/);
      expect(Math.abs(Number(g.delta))).toBe(24);
    }
    // The second section moved down 24 px as a whole; its own spacing is right, so cumulative drift is not a finding.
    for (const f of r.findings)
      expect(String(f.section), show(r)).toContain("How it works");
    expect(new Set(r.findings.map((f) => f.width))).toEqual(
      new Set([400, 1024]),
    );
  }, 120_000);

  it("a tolerance above the error hides it, so the default stays at 2 px", async () => {
    const r = await run("spacing-diff", "defect", {
      cases: DESKTOP,
      tolerance: 30,
    });
    expect(
      r.findings.filter((f) => f.kind === "gap"),
      show(r),
    ).toEqual([]);
  }, 120_000);

  it("passes the clean target, where a hidden production-only element does not count", async () => {
    const r = await run("spacing-diff", "clean", { cases: CASES });
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("6. alignment-diff", () => {
  it("flags text-align and line count only at the width where they differ, naming it", async () => {
    const r = await run("alignment-diff", "defect", { cases: CASES });
    expect(r.findings.length, show(r)).toBeGreaterThan(0);
    for (const f of r.findings) {
      expect(f.width, show(r)).toBe(400);
      expect(f.message).toMatch(/\b400\b/);
    }
    expect(
      r.findings.some(
        (f) => f.kind === "text-align" && String(f.key).startsWith("H1:"),
      ),
      show(r),
    ).toBe(true);
    expect(
      r.findings.some(
        (f) => f.kind === "lines" && String(f.key).startsWith("P:"),
      ),
      show(r),
    ).toBe(true);
  }, 120_000);

  it("passes the clean target at every width", async () => {
    const r = await run("alignment-diff", "clean", { cases: CASES });
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("7. overlap-diff", () => {
  it("flags the timeline icon 2 px off its circle by offset and by pixels", async () => {
    const r = await run("overlap-diff", "defect");
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds.has("offset"), show(r)).toBe(true);
    expect(kinds.has("pixels"), show(r)).toBe(true);
    const offset = r.findings.find((f) => f.kind === "offset")!;
    expect(offset.message).toMatch(/Design review/);
    expect(
      r.findings.every((f) => !/Research|Launch/.test(f.message)),
      show(r),
    ).toBe(true);
  }, 120_000);

  it("passes the clean timeline, pixel for pixel", async () => {
    const r = await run("overlap-diff", "clean", { cases: CASES });
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("11. testid-carryover", () => {
  const options = (side: "defect" | "clean") => ({
    legacySrc: server.legacy("testid-carryover"),
    targetSrc: server.src("testid-carryover", side),
  });

  it("flags a dropped, a moved and a renamed hook, and a legacy source hook the first render never shows", async () => {
    const r = await run("testid-carryover", "defect", options("defect"));
    const about = (text: string) =>
      r.findings.filter((f) => f.message.includes(text));
    expect(
      about("hero-cta").some((f) => f.kind === "missing"),
      show(r),
    ).toBe(true);
    expect(
      about("nav-pricing").some((f) => f.kind === "moved"),
      show(r),
    ).toBe(true);
    const renamed = about("signup-form");
    expect(renamed.length, show(r)).toBeGreaterThan(0);
    expect(renamed[0].message).toContain("data-cy");
    const source = about("footer-newsletter");
    expect(source.length, show(r)).toBeGreaterThan(0);
    expect(source[0].message).toMatch(/Footer\.jsx:\d+/);
    expect(about("signup-email"), show(r)).toEqual([]);
    expect(about("signup-submit"), show(r)).toEqual([]);
  }, 120_000);

  it("passes the clean target, where wrappers were removed but every hook sits on the same element", async () => {
    const r = await run("testid-carryover", "clean", options("clean"));
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("12. testid-coverage", () => {
  const options = (side: "defect" | "clean") => ({
    prod: undefined,
    targetSrc: server.src("testid-coverage", side),
  });

  it("flags each gap with the source file to edit", async () => {
    const r = await run("testid-coverage", "defect", options("defect"));
    const page = "src/pages/index.html";
    const card = "src/components/promo-card/promo-card.html";
    const has = (kind: string, file: string, text: RegExp) =>
      r.findings.some(
        (f) => f.kind === kind && f.file === file && text.test(f.message),
      );
    expect(has("missing", page, /Subscribe/), show(r)).toBe(true);
    expect(has("missing", page, /footer/i), show(r)).toBe(true);
    expect(
      has("component-root", card, /data-testid="promo-card"/),
      show(r),
    ).toBe(true);
    expect(has("part-name", card, /learn-more/), show(r)).toBe(true);
    // Two promo-card instances share their ids by design; that is not a gap.
    expect(
      r.findings.filter((f) => /duplicate/i.test(f.message)),
      show(r),
    ).toEqual([]);
  }, 120_000);

  it("passes the clean target, where repeated instances share their ids", async () => {
    const r = await run("testid-coverage", "clean", options("clean"));
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);
});

describe("13. presence-by-route", () => {
  const routes = { route: undefined, routes: ["/", "/about", "/pricing"] };

  it("flags the banner missing on one route, the extra layer on another and the dismissal that does not persist", async () => {
    const r = await run("presence-by-route", "defect", routes);
    const has = (kind: string, route: string, key: RegExp) =>
      r.findings.some(
        (f) => f.kind === kind && f.route === route && key.test(String(f.key)),
      );
    // The banner slides in 150 ms after load: a check that does not wait for a stable render sees none of these.
    expect(has("missing", "/pricing", /Cookie preferences/), show(r)).toBe(
      true,
    );
    expect(has("extra", "/about", /Chat with us/), show(r)).toBe(true);
    const trigger = r.findings.find(
      (f) => f.kind === "trigger" && f.route === "/",
    );
    expect(trigger, show(r)).toBeDefined();
    expect(String(trigger!.key)).toContain("Cookie preferences");
    expect(trigger!.message).toMatch(/dismiss/i);
    // The sticky header is on every route on both sides.
    for (const f of r.findings)
      expect(String(f.key), show(r)).toMatch(/Cookie preferences|Chat with us/);
  }, 180_000);

  it("passes the clean target, where the banner is another element and the consent lives in a cookie", async () => {
    const r = await run("presence-by-route", "clean", routes);
    expect(r.findings, show(r)).toEqual([]);
  }, 180_000);
});

describe("14. production-defects", () => {
  it("finds production's squished image and misaligned icon at 400 px only, and fails a target that copies them", async () => {
    const r = await run("production-defects", "defect", { cases: CASES });
    const copied = (defect: string) =>
      r.findings.find((f) => f.kind === "copied-defect" && f.defect === defect);
    for (const defect of ["squished", "icon-misaligned"]) {
      const f = copied(defect);
      expect(f, `${defect}\n${show(r)}`).toBeDefined();
      expect(f!.width).toBe(400);
      expect(f!.route).toBe("/");
      expect(typeof f!.selector).toBe("string");
    }
    for (const f of r.findings) expect(f.width, show(r)).toBe(400);
    // The short heading's icon is 2 px off at every width, within tolerance.
    expect(
      r.findings.filter((f) => String(f.key ?? f.message).includes("Reports")),
      show(r),
    ).toEqual([]);
  }, 120_000);

  it("passes a target that fixes them, and still lists production's defects as ledger rows for the review page", async () => {
    const r = await run("production-defects", "clean", { cases: CASES });
    expect(r.findings, show(r)).toEqual([]);
    const defects = r.defects as Array<{
      kind: string;
      route: string;
      width: number;
      selector: string;
    }>;
    expect(defects.map((d) => d.kind).sort()).toEqual(
      ["icon-misaligned", "squished"].sort(),
    );
    for (const d of defects) {
      expect(d.route).toBe("/");
      expect(d.width).toBe(400);
      expect(d.selector.length).toBeGreaterThan(0);
    }
    const ledger = r.ledger as string[];
    expect(ledger).toHaveLength(2);
    for (const row of ledger)
      expect(row).toContain("production defect: fix in target");
  }, 120_000);
});

describe("10. run-checks: one command per route and matrix case", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "bascik-parity-run-"));
    writeFileSync(
      join(work, "breakpoints.json"),
      JSON.stringify({ cases: CASES }, null, 2),
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const runChecks = (side: "defect" | "clean") =>
    spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "run-checks.mjs"),
        "--prod",
        server.site("site", "prod"),
        "--target",
        server.site("site", side),
        "--route",
        "/",
        "--route",
        "/about",
        "--matrix",
        join(work, "breakpoints.json"),
        "--target-src",
        server.src("site", side),
        "--legacy-src",
        server.legacy("site"),
        "--out",
        join(work, side),
        "--settle-ms",
        "0",
        // Shared by both runs: the clean run reads production from what the defect run measured.
        "--prod-cache",
        join(work, "prod-cache"),
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 300_000 },
    );

  it("exits 1 on the defect site, naming the check, the route and the element", () => {
    const result = runChecks("defect");
    const text = `${result.stdout}\n${result.stderr}`;
    expect(result.status, text).toBe(1);
    expect(text).toContain("interaction-crawl");
    expect(text).toContain("See features");
    const report = JSON.parse(
      readFileSync(join(work, "defect", "index", "report.json"), "utf8"),
    );
    expect(report.route).toBe("/");
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        (f: Finding) =>
          f.check === "interaction-crawl" && f.kind === "missing-effect",
      ),
    ).toBe(true);
  }, 300_000);

  it("exits 0 on the clean site: header, footer and feature grid are components, every hook carried over", () => {
    const result = runChecks("clean");
    const text = `${result.stdout}\n${result.stderr}`;
    expect(result.status, text).toBe(0);
    for (const slug of ["index", "about"]) {
      const report = JSON.parse(
        readFileSync(join(work, "clean", slug, "report.json"), "utf8"),
      );
      expect(report.ok, JSON.stringify(report.findings, null, 2)).toBe(true);
      expect(Object.keys(report.checks).sort()).toEqual(
        [
          "alignment-diff",
          "interaction-crawl",
          "overlap-diff",
          "presence-by-route",
          "production-defects",
          "repeated-sections",
          "spacing-diff",
          "state-capture",
          "testid-carryover",
          "testid-coverage",
          "text-style-diff",
        ].sort(),
      );
    }
  }, 300_000);
});

describe("15. the production cache and --cases", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "bascik-parity-cache-"));
    writeFileSync(
      join(work, "breakpoints.json"),
      JSON.stringify({ cases: CASES }, null, 2),
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const runChecks = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        join(SCRIPTS, "run-checks.mjs"),
        "--prod",
        server.site("site", "prod"),
        "--target",
        server.site("site", "clean"),
        "--route",
        "/",
        "--matrix",
        join(work, "breakpoints.json"),
        "--only",
        "spacing-diff,text-style-diff",
        "--out",
        join(work, "out"),
        "--settle-ms",
        "0",
        "--prod-cache",
        join(work, "prod-cache"),
        ...extra,
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 300_000 },
    );
  /** The production requests one run makes, and its result. */
  const counted = async (extra: string[]) => {
    const before = await server.requests("/site/prod/");
    const targetBefore = await server.requests("/site/clean/");
    const result = runChecks(extra);
    return {
      result,
      text: `${result.stdout}\n${result.stderr}`,
      prod: (await server.requests("/site/prod/")) - before,
      target: (await server.requests("/site/clean/")) - targetBefore,
    };
  };

  it("measures production once, then reads it from the cache until --refresh-prod or a changed mask", async () => {
    const first = await counted(["--cases", "400"]);
    expect(first.result.status, first.text).toBe(0);
    expect(first.prod).toBeGreaterThan(0);
    expect(first.text).toContain(
      "production: 0 measurements from cache, 2 captured",
    );
    expect(first.text).toContain(
      "PARTIAL (1 of 2 cases; 2 of 11 checks, without ",
    );
    const report = JSON.parse(
      readFileSync(join(work, "out", "index", "report.json"), "utf8"),
    );
    expect(report.gate).toMatchObject({
      cases: ["400x800"],
      total: 2,
      checks: ["text-style-diff", "spacing-diff"],
      partial: true,
    });
    expect(report.gate.skipped).toContain("interaction-crawl");
    expect(report.production).toMatchObject({ fromCache: 0, captured: 2 });

    const second = await counted(["--cases", "400"]);
    expect(second.result.status, second.text).toBe(0);
    expect(second.prod, "the second run must not load production").toBe(0);
    expect(second.target).toBeGreaterThan(0);
    expect(second.text).toMatch(
      /production: 2 measurements from cache \(oldest \d{4}-\d{2}-\d{2}T[^)]+\), 0 captured; pass --refresh-prod after production changes/,
    );

    const refreshed = await counted(["--cases", "400", "--refresh-prod"]);
    expect(refreshed.result.status, refreshed.text).toBe(0);
    expect(refreshed.prod).toBeGreaterThan(0);

    const masked = await counted(["--cases", "400", "--mask", ".nothing"]);
    expect(masked.result.status, masked.text).toBe(0);
    expect(masked.prod, "a new mask is a cache miss").toBeGreaterThan(0);

    // Misuse: --no-prod-cache next to --prod-cache is a contradiction, refused before production is loaded.
    const both = await counted(["--cases", "400", "--no-prod-cache"]);
    expect(both.result.status).toBe(1);
    expect(both.result.stderr).toMatch(/--prod-cache.*--no-prod-cache/);
    expect(both.prod).toBe(0);
  }, 300_000);

  it("every case of another matrix file is still partial; misuse: an unknown case id fails before any browser starts", async () => {
    const full = await counted([]);
    expect(full.result.status, full.text).toBe(0);
    // Only docs/migration/breakpoints.json, run in full, is the gate.
    expect(full.text).toMatch(
      /PARTIAL \(2 of 2 cases; 2 of 11 checks, without [^)]*\): iteration result, not a gate/,
    );
    // 400 px came from the cache above; 1024 px is new.
    expect(full.text).toMatch(/production: 2 measurements from cache/);
    const report = JSON.parse(
      readFileSync(join(work, "out", "index", "report.json"), "utf8"),
    );
    expect(report.gate).toMatchObject({
      cases: ["400x800", "1024x800"],
      total: 2,
    });
    // Another matrix file than docs/migration/breakpoints.json is never the gate.
    expect(report.gate.partial).toBe(true);

    const wrong = await counted(["--cases", "375x812"]);
    expect(wrong.result.status).toBe(1);
    expect(wrong.result.stderr).toContain("400x800, 1024x800");
    expect(wrong.prod).toBe(0);
  }, 300_000);

  it("state-capture and overlap-diff read production's open states and crops back from the cache with the same result", async () => {
    const { openProdCache } = (await import(
      join(SCRIPTS, "lib", "prod-cache.mjs")
    )) as {
      openProdCache: (
        browser: unknown,
        options: Record<string, unknown>,
      ) => Promise<{ stats: { fromCache: number; captured: number } }>;
    };
    for (const name of ["state-capture", "overlap-diff"]) {
      const dirFor = join(work, "api-cache");
      const runCached = async () => {
        const prodCache = await openProdCache(browser, {
          dir: dirFor,
          quiet: true,
        });
        const before = await server.requests(`/${name}/prod/`);
        const r = await run(name, "defect", { prodCache });
        return {
          r,
          stats: prodCache.stats,
          prod: (await server.requests(`/${name}/prod/`)) - before,
        };
      };
      const first = await runCached();
      expect(first.prod, name).toBeGreaterThan(0);
      const second = await runCached();
      expect(second.prod, `${name}: production loaded again`).toBe(0);
      expect(second.stats.fromCache, name).toBeGreaterThan(0);
      const strip = (r: Result) =>
        r.findings.map((f) => `${f.kind} ${f.message}`).sort();
      expect(strip(second.r), name).toEqual(strip(first.r));
      expect(first.r.findings.length, show(first.r)).toBeGreaterThan(0);
      for (const s of (second.r.states ?? []) as Array<{
        prod: { crop?: string };
      }>)
        if (s.prod.crop)
          expect(existsSync(s.prod.crop), s.prod.crop).toBe(true);
    }
  }, 300_000);
});

describe("16. production only: the inventory stage and its baselines", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "bascik-parity-prod-only-"));
    writeFileSync(
      join(work, "breakpoints.json"),
      JSON.stringify({ cases: DESKTOP }, null, 2),
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const node = (script: string, args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [join(SCRIPTS, `${script}.mjs`), ...args],
      { cwd: packageDir, encoding: "utf8", timeout: 300_000 },
    );
    return { result, text: `${result.stdout}\n${result.stderr}` };
  };
  /** Requests a side of one fixture answered while `fn` ran. */
  const during = async <T>(prefix: string, fn: () => T | Promise<T>) => {
    const before = await server.requests(prefix);
    const value = await fn();
    return { value, n: (await server.requests(prefix)) - before };
  };

  it("interaction-crawl without --target crawls production alone, exits 0 and writes a draft compare-route refuses", async () => {
    const draft = join(work, "interactions.draft.json");
    const prod = server.site("interaction-crawl", "prod");
    const { value, n } = await during("/interaction-crawl/prod/", () =>
      node("interaction-crawl", [
        "--prod",
        prod,
        "--route",
        "/",
        "--matrix",
        join(work, "breakpoints.json"),
        "--settle-ms",
        "0",
        "--out",
        join(work, "checks"),
        "--no-prod-cache",
        "--discover",
        "--discover-out",
        draft,
      ]),
    );
    expect(value.result.status, value.text).toBe(0);
    expect(n).toBeGreaterThan(0);
    expect(value.text).toMatch(
      /ok {4}interaction-crawl {2}production only \(no --target\)/,
    );
    expect(value.text).toMatch(/draft interaction step\(s\) written to/);
    const report = JSON.parse(
      readFileSync(join(work, "checks", "interaction-crawl.json"), "utf8"),
    );
    expect(report).toMatchObject({ ok: true, productionOnly: true });
    expect(report.findings).toEqual([]);
    expect(report.crawled[0].target).toBeNull();
    expect(report.crawled[0].prod.length).toBeGreaterThan(0);

    const file = JSON.parse(readFileSync(draft, "utf8"));
    expect(file.draft).toBe(true);
    const byName = new Map(
      file.interactions.map((s: { name: string }) => [s.name, s]),
    );
    expect(byName.get('click button "Products"')).toMatchObject({
      role: "button",
      roleName: "Products",
      action: "click",
      expect: { ariaExpanded: true },
      draft: true,
    });
    expect(
      (byName.get('click button "See features"') as { observed: string })
        .observed,
    ).toMatch(/scrolls \d+ px/);

    const { loadInteractions } = (await import(
      join(SCRIPTS, "compare-route.mjs")
    )) as { loadInteractions: (file: string) => unknown };
    expect(() => loadInteractions(draft)).toThrow(/is a draft/);
  }, 300_000);

  it("misuse: --target equal to --prod is refused before production is loaded", async () => {
    const prod = server.site("interaction-crawl", "prod");
    for (const script of [
      "interaction-crawl",
      "state-capture",
      "presence-by-route",
    ]) {
      const { value, n } = await during("/interaction-crawl/prod/", () =>
        node(script, ["--prod", prod, "--target", `${prod}/`, "--route", "/"]),
      );
      expect(value.result.status, script).toBe(1);
      expect(value.result.stderr).toMatch(/is production.*leave --target out/s);
      expect(n, script).toBe(0);
    }
  });

  it("presence-by-route and state-capture without a target inventory production alone", async () => {
    const presence = await load("presence-by-route");
    const routes = ["/", "/about", "/pricing"];
    const p = await presence.runCheck(browser, {
      prod: server.site("presence-by-route", "prod"),
      routes,
      cases: DESKTOP,
      settleMs: 0,
    });
    expect(p).toMatchObject({ ok: true, productionOnly: true, findings: [] });
    const inventory = p.inventory as Array<{ prod: unknown[]; target: null }>;
    expect(inventory[0].target).toBeNull();
    expect(inventory[0].prod.length).toBeGreaterThan(0);

    const states = await load("state-capture");
    const { value: s, n } = await during("/state-capture/defect/", () =>
      states.runCheck(browser, {
        prod: server.site("state-capture", "prod"),
        route: "/",
        cases: DESKTOP,
        settleMs: 0,
        out: join(work, "states-only"),
      }),
    );
    expect(n, "no target was loaded").toBe(0);
    expect(s).toMatchObject({ ok: true, productionOnly: true, findings: [] });
    const list = s.states as Array<{
      prod: { crop?: string };
      target?: unknown;
    }>;
    expect(list.length).toBeGreaterThan(0);
    for (const state of list) {
      expect(state.target).toBeUndefined();
      expect(existsSync(state.prod.crop as string)).toBe(true);
    }
  }, 300_000);

  it("capture-baselines writes <route>@<caseId> baselines with open states, and the first run-checks reads them from the cache", async () => {
    const prod = server.site("state-capture", "prod");
    const out = join(work, "baselines");
    const cache = join(work, "prod-cache");
    const shared = [
      "--route",
      "/",
      "--matrix",
      join(work, "breakpoints.json"),
      "--settle-ms",
      "0",
      "--prod-cache",
      cache,
    ];
    // Misuse: a baseline is production alone.
    const refused = await during("/state-capture/", () =>
      node("capture-baselines", [
        "--prod",
        prod,
        "--target",
        server.site("state-capture", "clean"),
        ...shared,
      ]),
    );
    expect(refused.value.result.status).toBe(1);
    expect(refused.value.result.stderr).toMatch(/records production only/);
    expect(refused.n).toBe(0);

    const first = await during("/state-capture/prod/", () =>
      node("capture-baselines", [
        "--prod",
        prod,
        "--states",
        "--out",
        out,
        ...shared,
      ]),
    );
    expect(first.value.result.status, first.value.text).toBe(0);
    expect(first.n).toBeGreaterThan(0);
    expect(first.value.text).toContain("baseline  /@1024x800");
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(index).toMatchObject({ format: 1, prod });
    expect(index.baselines).toHaveLength(1);
    const b = index.baselines[0];
    expect(b).toMatchObject({
      id: "/@1024x800",
      route: "/",
      caseId: "1024x800",
      png: "index/1024x800.png",
      nodes: "index/1024x800.nodes.json",
      status: 200,
    });
    const png = readFileSync(join(out, b.png));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(
      Object.keys(JSON.parse(readFileSync(join(out, b.nodes), "utf8"))).length,
    ).toBe(b.nodeCount);
    expect(b.nodeCount).toBeGreaterThan(0);
    expect(b.states.length).toBeGreaterThan(0);
    for (const state of b.states) {
      expect(state.id).toBe(`/@1024x800#${state.label}`);
      expect(existsSync(join(out, state.crop))).toBe(true);
    }

    // The first run-checks with the same --prod, masks, skip-controls and settle time loads no production page.
    const checks = await during("/state-capture/prod/", () =>
      node("run-checks", [
        "--prod",
        prod,
        "--target",
        server.site("state-capture", "defect"),
        "--only",
        "state-capture",
        "--out",
        join(work, "run"),
        ...shared,
      ]),
    );
    expect(checks.n, checks.value.text).toBe(0);
    expect(checks.value.text).toMatch(/production: 1 measurements from cache/);
    // The defect target still fails: the cached open states are compared, not skipped.
    expect(checks.value.result.status, checks.value.text).toBe(1);

    // A second capture reads its pages back from the cache too.
    const again = await during("/state-capture/prod/", () =>
      node("capture-baselines", [
        "--prod",
        prod,
        "--states",
        "--out",
        out,
        ...shared,
      ]),
    );
    expect(again.value.result.status, again.value.text).toBe(0);
    expect(again.n).toBe(0);

    // Misuse: an index of another production origin is never mixed in.
    const other = await during("/interaction-crawl/prod/", () =>
      node("capture-baselines", [
        "--prod",
        server.site("interaction-crawl", "prod"),
        "--out",
        out,
        ...shared,
      ]),
    );
    expect(other.value.result.status).toBe(1);
    expect(other.value.result.stderr).toMatch(/holds baselines of/);
    expect(other.n).toBe(0);
  }, 300_000);
});

describe("9. review-page in the browser", () => {
  it("toggles the diff overlay and downloads a sign-off file for docs/migration/review/", async () => {
    const mod = (await import(join(SCRIPTS, "review-page.mjs"))) as {
      renderReviewPage: (data: Record<string, unknown>) => string;
    };
    const dir = join(out, "review");
    mkdirSync(dir, { recursive: true });
    // Two 1x1 PNGs (white and black) as the side-by-side pair.
    const png = (hex: string) =>
      Buffer.from(
        hex === "fff"
          ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg=="
          : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
    writeFileSync(join(dir, "prod-400x800.png"), png("fff"));
    writeFileSync(join(dir, "target-400x800.png"), png("000"));
    const html = mod.renderReviewPage({
      route: "/about",
      cases: [
        {
          width: 400,
          height: 800,
          prod: join(dir, "prod-400x800.png"),
          target: join(dir, "target-400x800.png"),
        },
      ],
      states: [],
      findings: [
        {
          check: "spacing-diff",
          kind: "gap",
          width: 400,
          message: "gap before UL differs by 24 px",
        },
      ],
      base: dir,
    });
    const file = join(dir, "about.html");
    writeFileSync(file, html);
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await context.newPage();
      await page.goto(`file://${file}`);
      const overlay = page.getByTestId("diff-overlay").first();
      const before = await overlay.isVisible();
      await page.getByTestId("diff-toggle").first().click();
      expect(await overlay.isVisible()).toBe(!before);
      await page.getByTestId("review-reviewer").fill("Sam Rivera");
      await page.getByTestId("review-verdict").selectOption("issues");
      await page
        .getByTestId("review-notes")
        .fill("Hero button spacing at 400 px");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByTestId("review-submit").click(),
      ]);
      expect(download.suggestedFilename()).toBe("about.json");
      const saved = join(dir, "downloaded.json");
      await download.saveAs(saved);
      const signOff = JSON.parse(readFileSync(saved, "utf8"));
      expect(signOff).toMatchObject({
        route: "/about",
        reviewer: "Sam Rivera",
        verdict: "issues",
        notes: "Hero button spacing at 400 px",
      });
      expect(signOff.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(Object.keys(signOff).sort()).toEqual(
        ["date", "notes", "reviewer", "route", "verdict"].sort(),
      );
    } finally {
      await context.close();
    }
  }, 60_000);
});
