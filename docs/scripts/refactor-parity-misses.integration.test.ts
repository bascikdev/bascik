/**
 * The defects the first version of the bascik-refactor parity checks passed, in a real browser, from the fixture pairs
 * in scripts/fixtures/refactor-parity/misses/. Each pair is a production page and a target with exactly one defect
 * that a reviewer built after the checks reported "no findings" on it; the check named for that issue type must now
 * flag it. The identical pairs at the end must stay clean: a busy marketing site served twice (an autoplay carousel
 * and a rotating ticker, both masked; a cookie banner that slides in over page text; smooth scrolling; a timeline
 * below the fold) and a timeline whose dots sit in a track without text.
 *
 * Why: agents treated "no findings" as PASS, so every defect a check cannot see ships. These are the common forms of
 * the seven issue types: a delegated click handler, a hover-only tooltip and menu, an icon swapped or recolored inside
 * an open dropdown, a pasted section on pages that share a layout component, a hover color set through the link or a
 * card, a repeated "Learn more", spacing nested three wrappers deep, a container shifted at one breakpoint, an
 * overlay drawn with ::after or inside one svg.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  docsDir,
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
};

const load = async (name: string): Promise<CheckModule> =>
  (await import(join(SCRIPTS, `${name}.mjs`))) as CheckModule;

const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 800 };
const show = (r: Result) =>
  r.findings.map((f) => `${f.kind}: ${f.message}`).join("\n") || "(none)";

let server: FixtureServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;
let out: string;

beforeAll(async () => {
  server = await serveFixtures();
  const { chromium } = await loadPlaywright({ cwd: docsDir });
  browser = await chromium.launch();
  out = mkdtempSync(join(tmpdir(), "bascik-parity-misses-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const site = (variant: string, side: "prod" | "target") =>
  `${server.origin}/misses/${variant}/${side}`;

async function run(
  name: string,
  variant: string,
  extra: Record<string, unknown> = {},
  target: "prod" | "target" = "target",
): Promise<Result> {
  const mod = await load(name);
  return mod.runCheck(browser, {
    prod: site(variant, "prod"),
    target: site(variant, target),
    route: "/",
    cases: [WIDE],
    out: join(out, name, variant, target),
    // No fixture here opens anything on a timer, so the default settle time after load would only slow the suite down.
    settleMs: 0,
    ...extra,
  });
}

/** Each missed defect: the variant, the check that owns it, the cases, and the kinds of finding that name it. */
const MISSES: Array<{
  variant: string;
  check: string;
  kinds: string[];
  why: string;
  extra?: Record<string, unknown>;
  match?: RegExp;
}> = [
  {
    variant: "1a-delegated",
    check: "interaction-crawl",
    kinds: ["missing-element", "missing-effect"],
    why: "a card that scrolls through a delegated document click listener does nothing on the target",
    match: /See the specs/,
  },
  {
    variant: "1d-hover",
    check: "interaction-crawl",
    kinds: ["missing-element", "missing-effect"],
    why: "a tooltip production shows on hover never shows on the target",
    match: /Warranty/,
  },
  {
    variant: "2a-icon-swapped",
    check: "state-capture",
    kinds: ["icon-shape", "pixels"],
    why: "the open dropdown's chevron is a plus on the target, both inline svg paths",
  },
  {
    variant: "2b-icon-color",
    check: "state-capture",
    kinds: ["icon-color", "pixels"],
    why: "the open dropdown's icons are grey on the target",
  },
  {
    variant: "2c-panel-offset",
    check: "state-capture",
    kinds: ["position"],
    why: "the open menu sits 40 px to the right of where production puts it",
    match: /40/,
  },
  {
    variant: "2d-glyph",
    check: "state-capture",
    kinds: ["icons"],
    why: "an arrow glyph drawn with ::before content is missing on the target",
  },
  {
    variant: "2e-hover-menu",
    check: "state-capture",
    kinds: ["style"],
    why: "a menu that opens on CSS :hover has square corners on the target",
    match: /border-radius/,
  },
  {
    variant: "4a-hover-span",
    check: "text-style-diff",
    kinds: ["style"],
    why: "a:hover sets the color of a link whose text sits in a span",
    match: /the guide.*hover.*color/,
  },
  {
    variant: "4b-duplicate-text",
    check: "text-style-diff",
    kinds: ["style"],
    why: "the second of two 'Learn more' links has the wrong color",
    match: /Learn more #2.*color/,
  },
  {
    variant: "4c-ancestor-hover",
    check: "text-style-diff",
    kinds: ["style"],
    why: "the card's :hover sets the link color",
    match: /Shop frothers.*hover.*color/,
  },
  {
    variant: "5a-nested",
    check: "spacing-diff",
    kinds: ["gap"],
    why: "a 9 px error between a card's heading and text, three wrappers below the section",
    match: /Microfoam in seconds/,
  },
  {
    variant: "5b-div-layout",
    check: "spacing-diff",
    kinds: ["gap"],
    why: "a hero built from plain divs under body with a 20 px heading margin error",
    match: /Froth in seconds/,
  },
  {
    variant: "6a-container-shift",
    check: "alignment-diff",
    kinds: ["page-left", "page-right"],
    why: "the wrapper loses margin: 0 auto at 1280 px, so all its text sits at the page edge",
    extra: { cases: [WIDE, PHONE] },
    match: /1280/,
  },
  {
    variant: "6b-cta-link",
    check: "alignment-diff",
    kinds: ["text-align"],
    why: "a link styled as a button is left-aligned at 375 px",
    extra: { cases: [WIDE, PHONE] },
    match: /Buy now.*375/,
  },
  {
    variant: "6c-duplicate-heading",
    check: "alignment-diff",
    kinds: ["text-align"],
    why: "the second of two 'Specs' headings is centered at 375 px",
    extra: { cases: [WIDE, PHONE] },
    match: /Specs #2/,
  },
  {
    variant: "6d-list-item",
    check: "alignment-diff",
    kinds: ["left"],
    why: "a list item is indented 24 px at 375 px",
    extra: { cases: [WIDE, PHONE] },
    match: /Steam wand.*375/,
  },
  {
    variant: "7b-textless-track",
    check: "overlap-diff",
    kinds: ["offset"],
    why: "the third timeline icon is 2 px off its dot, in a track whose pairs share one key",
  },
  {
    variant: "7c-pseudo-overlay",
    check: "overlap-diff",
    kinds: ["offset"],
    why: "the dot's inner circle, drawn with ::after, is 2 px off",
    match: /::after/,
  },
  {
    variant: "7d-single-svg",
    check: "overlap-diff",
    kinds: ["offset"],
    why: "the check mark group inside one inline svg is 2 px off its circle",
  },
];

describe("each defect the first checks missed is flagged by its check", () => {
  for (const m of MISSES)
    it(`${m.check} flags ${m.variant}: ${m.why}`, async () => {
      const r = await run(m.check, m.variant, m.extra);
      expect(r.ok, show(r)).toBe(false);
      const hits = r.findings.filter((f) => m.kinds.includes(f.kind));
      expect(hits.length, show(r)).toBeGreaterThan(0);
      if (m.match)
        expect(
          hits.some((f) => m.match!.test(f.message)),
          show(r),
        ).toBe(true);
    }, 120_000);
});

describe("3. repeated-sections: the forms the first version missed", () => {
  const options = (variant: string) => ({
    routes: ["/", "/about"],
    targetSrc: join(server.root, "misses", variant, "src"),
  });

  it("a repeated block marked up as a div, pasted on both pages, is duplicated markup", async () => {
    const r = await run(
      "repeated-sections",
      "3a-div-block",
      options("3a-div-block"),
    );
    expect(
      r.findings.some((f) => f.kind === "duplicated-markup"),
      show(r),
    ).toBe(true);
  });

  it("a section pasted on two pages that share one layout component is not credited to that component", async () => {
    const r = await run(
      "repeated-sections",
      "3b-shared-layout",
      options("3b-shared-layout"),
    );
    const dup = r.findings.filter((f) => f.kind === "duplicated-markup");
    expect(dup.length, show(r)).toBe(1);
    expect(dup[0].message).toContain("Why our frother");
    expect(dup[0].message).not.toMatch(/uses site-header/);
  });

  it("the third card styled wrong on one route is a diverging instance", async () => {
    const r = await run(
      "repeated-sections",
      "3c-third-card",
      options("3c-third-card"),
    );
    const div = r.findings.filter((f) => f.kind === "diverging-instance");
    expect(div.length, show(r)).toBeGreaterThan(0);
    expect(
      div.every((f) => f.route === "/about"),
      show(r),
    ).toBe(true);
  });

  it("a wrong copy on the first route is blamed on that route, with production's value as the reference", async () => {
    const r = await run(
      "repeated-sections",
      "3d-first-route",
      options("3d-first-route"),
    );
    const div = r.findings.filter((f) => f.kind === "diverging-instance");
    expect(div.length, show(r)).toBeGreaterThan(0);
    for (const f of div) {
      expect(f.route, show(r)).toBe("/");
      expect(f.prod).toBe("rgb(36, 87, 214)");
      expect(f.target).toBe("rgb(214, 69, 93)");
    }
  });
});

describe("identical pairs stay clean", () => {
  const masks = ['[data-testid="carousel"]', '[data-testid="ticker"]'];
  const dynamic = { routes: ["/", "/about"], masks };

  it("overlap-diff: a text-less timeline track pairs each dot with its own icon, so identical pages have no pixel findings", async () => {
    const r = await run(
      "overlap-diff",
      "7b-textless-track",
      { cases: [WIDE, PHONE] },
      "prod",
    );
    expect(r.findings, show(r)).toEqual([]);
  }, 120_000);

  for (const check of [
    "interaction-crawl",
    "state-capture",
    "text-style-diff",
    "spacing-diff",
    "alignment-diff",
    "overlap-diff",
  ])
    it(`${check}: an identical busy site with its carousel and ticker masked`, async () => {
      const r = await run(check, "dynamic", dynamic);
      expect(r.findings, show(r)).toEqual([]);
    }, 240_000);

  it("overlap-diff: smooth scrolling never puts a below-the-fold pair mid-scroll (three runs)", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await run("overlap-diff", "dynamic", dynamic);
      expect(r.findings, show(r)).toEqual([]);
    }
  }, 240_000);

  it("production-defects: a fixed cookie banner over page text is not a production defect", async () => {
    const r = await run("production-defects", "dynamic", {
      ...dynamic,
      cases: [WIDE, PHONE],
    });
    expect(r.findings, show(r)).toEqual([]);
    expect(
      (r.defects as Finding[]).filter((d) => d.kind === "text-overlap"),
    ).toEqual([]);
  }, 120_000);

  it("presence-by-route: a rotating aria-live ticker, unmasked, keeps one name on both sides", async () => {
    const r = await run("presence-by-route", "dynamic", {
      routes: ["/", "/about"],
    });
    expect(r.findings, show(r)).toEqual([]);
  }, 240_000);
});
