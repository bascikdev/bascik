/**
 * The second round of defects the bascik-refactor parity checks passed, in a real browser, from the fixture pairs in
 * tests/fixtures/refactor-parity/misses2/. Each pair is a production page and a target with exactly one defect a
 * reviewer built after run-checks.mjs reported "no findings" on it; the check named for that issue type must now flag
 * it. The production-defects pairs serve production twice (the target copied the defect). The identical pairs at the
 * end must stay clean: a busy marketing site served twice (an autoplay video hero under a tint, sections that fade in
 * on scroll, a newsletter modal that opens 3 s after load, a relative date that ticked over between the two loads).
 *
 * Why: agents treated "no findings" as PASS, so every defect a check cannot see ships, and a check that fails on
 * identical pages teaches agents to mask or skip it. These are the common forms of the issue types a human caught side
 * by side with production: an icon nested in its dot, space between sections, a dead carousel or stepper, a chevron
 * that no longer rotates, a lost focus ring, breakpoint-only misalignment of stat numbers and images, lazy images
 * squished in production, a banner docked on the wrong edge, a test hook on two elements.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
};

const load = async (name: string): Promise<CheckModule> =>
  (await import(join(SCRIPTS, `${name}.mjs`))) as CheckModule;

const WIDE = { width: 1280, height: 800 };
const TABLET = { width: 768, height: 1024 };
const PHONE = { width: 375, height: 800 };
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
  out = mkdtempSync(join(tmpdir(), "bascik-parity-misses2-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const site = (variant: string, side: "prod" | "target") =>
  `${server.origin}/misses2/${variant}/${side}`;
const dir = (variant: string, sub: string) =>
  join(server.root, "misses2", variant, sub);

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
    targetSrc: dir(variant, "src"),
    legacySrc: dir(variant, "legacy"),
    // The single-defect fixtures have no timers; the busy site keeps the default settle time (a modal opens at 3 s).
    ...(variant === "dynamic" ? {} : { settleMs: 0 }),
    ...extra,
  });
}

const THREE_ROUTES = { routes: ["/", "/about", "/pricing"] };
const TWO_ROUTES = { routes: ["/", "/about"] };

/** Each missed defect: the variant, the check that owns it, the kinds of finding that name it, and the options. */
const MISSES: Array<{
  variant: string;
  check: string;
  kinds: string[];
  why: string;
  extra?: Record<string, unknown>;
  match?: RegExp;
  /** production-defects: the target serves production's own page, which copied the defect. */
  copied?: boolean;
}> = [
  {
    variant: "ov2-check-nested-in-dot-2px-off",
    check: "overlap-diff",
    kinds: ["offset"],
    why: "a check mark absolutely positioned inside its dot (a child, not a sibling) is 2 px off",
    match: /SVG/,
  },
  {
    variant: "ov1-pulled-up-card-20px-off",
    check: "overlap-diff",
    kinds: ["offset"],
    why: "a card pulled up over the hero with a negative margin overlaps it by 60 px instead of 80 px",
  },
  {
    variant: "sp1-section-padding-bottom-halved",
    check: "spacing-diff",
    kinds: ["section-gap", "section-height"],
    why: "a section's bottom padding is halved, so the next section starts 48 px higher",
  },
  {
    variant: "sp2-wrapper-stops-margin-collapse",
    check: "spacing-diff",
    kinds: ["section-gap"],
    why: "component roots with display:grid stop adjacent section margins from collapsing: 64 px becomes 128 px",
  },
  {
    variant: "sp3-button-taller",
    check: "spacing-diff",
    kinds: ["height"],
    why: "a button 16 px taller pushes everything below it down",
    match: /Add to cart/,
  },
  {
    variant: "rs1-small-band-pasted",
    check: "repeated-sections",
    kinds: ["duplicated-markup"],
    why: "a small band (section > h2, p, a) pasted into three page sources",
    extra: THREE_ROUTES,
    match: /Ready to froth/,
  },
  {
    variant: "rs2-pasted-inside-layout-wrapper",
    check: "repeated-sections",
    kinds: ["duplicated-markup"],
    why: "a section pasted into each page's slot of a shared layout component is not credited to the layout",
    extra: TWO_ROUTES,
    match: /Why our frother/,
  },
  {
    variant: "rs3-entity-heading-pasted",
    check: "repeated-sections",
    kinds: ["duplicated-markup"],
    why: "a pasted section whose heading has &amp; in the source is still found in the page sources",
    extra: TWO_ROUTES,
    match: /Froth, steam & pour/,
  },
  {
    variant: "ic1-carousel-arrows-dead",
    check: "interaction-crawl",
    kinds: ["missing-effect", "missing-element"],
    why: "carousel arrows that translate a track do nothing on the target",
    match: /Next/,
  },
  {
    variant: "ic2-quantity-stepper-dead",
    check: "interaction-crawl",
    kinds: ["missing-effect", "missing-element"],
    why: "a +/- stepper that changes an input's value does nothing on the target",
  },
  {
    variant: "ic3-anchor-under-sticky-header",
    check: "interaction-crawl",
    kinds: ["different-effect", "missing-effect"],
    why: "an in-page link lands its heading under the sticky header on the target",
    match: /Specs/,
  },
  {
    variant: "ic4-dialog-close-dead",
    check: "interaction-crawl",
    kinds: ["missing-effect", "missing-element"],
    why: "the Close button inside an opened dialog does nothing on the target",
    match: /Close/,
  },
  {
    variant: "sc1-accordion-chevron-no-rotate",
    check: "state-capture",
    kinds: ["trigger-style", "trigger-icons", "pixels"],
    why: "an accordion's chevron no longer rotates when open",
  },
  {
    variant: "sc2-dropdown-item-hover-lost",
    check: "state-capture",
    kinds: ["item-style"],
    why: "the hover style of an item inside an open dropdown is gone",
    match: /hover/,
  },
  {
    variant: "sc3-mega-menu-scrim-missing",
    check: "state-capture",
    kinds: ["viewport"],
    why: "the scrim that dims the page while the mega-menu is open is missing",
  },
  {
    variant: "ts1-nav-focus-ring-missing",
    check: "text-style-diff",
    kinds: ["style"],
    why: "the nav links lost their focus-visible ring",
    match: /focus-visible.*outline/,
  },
  {
    variant: "ts2-underline-offset-lost",
    check: "text-style-diff",
    kinds: ["style"],
    why: "a link lost its text-underline-offset",
    match: /text-underline-offset/,
  },
  {
    variant: "ts3-quote-italic-lost",
    check: "text-style-diff",
    kinds: ["style"],
    why: "a testimonial lost its italics",
    match: /font-style/,
  },
  {
    variant: "ts5-gradient-headline-flat",
    check: "text-style-diff",
    kinds: ["style"],
    why: "a gradient headline (background-clip: text) is solid on the target",
    match: /text-fill-color|background-image/,
  },
  {
    variant: "al1-stat-number-left-at-768",
    check: "alignment-diff",
    kinds: ["text-align", "left", "right"],
    why: "centered stat numbers in divs are left-aligned at 768 px",
    extra: { cases: [WIDE, TABLET, PHONE] },
    match: /768/,
  },
  {
    variant: "al2-hero-image-left-at-768",
    check: "alignment-diff",
    kinds: ["left", "page-left", "page-right"],
    why: "a centered hero image sits flush left at 768 px",
    extra: { cases: [WIDE, TABLET, PHONE] },
    match: /IMG.*768/,
  },
  {
    variant: "al3-trust-strip-left-at-1280",
    check: "alignment-diff",
    kinds: ["left", "page-left", "page-right"],
    why: "a centered row of spans is packed left at 1280 px",
    extra: { cases: [WIDE, TABLET, PHONE] },
    match: /SPAN.*1280/,
  },
  {
    variant: "pd1-lazy-image-squished-copied",
    check: "production-defects",
    kinds: ["copied-defect"],
    why: "a squished loading=lazy image 6000 px down is copied",
    copied: true,
    match: /squish|stretch/,
  },
  {
    variant: "pd2-icon-rows-misaligned-copied",
    check: "production-defects",
    kinds: ["copied-defect"],
    why: "icon rows whose labels are paragraphs, misaligned 10 px, are copied",
    copied: true,
    match: /icon/,
  },
  {
    variant: "pd3-stretched-svg-logo-copied",
    check: "production-defects",
    kinds: ["copied-defect"],
    why: "an inline svg logo stretched with preserveAspectRatio=none is copied",
    copied: true,
    match: /squish|stretch/,
  },
  {
    variant: "pr1-inflow-promo-bar-every-route",
    check: "presence-by-route",
    kinds: ["extra"],
    why: "an in-flow promo bar shows on routes where production has none",
    extra: THREE_ROUTES,
    match: /\/about/,
  },
  {
    variant: "pr2-back-to-top-after-scroll-missing",
    check: "presence-by-route",
    kinds: ["missing"],
    why: "a fixed Back to top button that shows after scrolling is missing",
    extra: THREE_ROUTES,
    match: /Back to top/i,
  },
  {
    variant: "pr3-cookie-banner-docked-top",
    check: "presence-by-route",
    kinds: ["placement"],
    why: "the cookie banner is docked at the top instead of the bottom",
    extra: THREE_ROUTES,
  },
  {
    variant: "pr5-consent-in-session-storage",
    check: "presence-by-route",
    kinds: ["trigger"],
    why: "consent kept in sessionStorage brings the banner back in a new tab",
    extra: THREE_ROUTES,
    match: /new tab/,
  },
  {
    variant: "tc1-hook-duplicated-on-wrapper",
    check: "testid-carryover",
    kinds: ["duplicated"],
    why: "a hook copied onto a second element breaks strict getByTestId locators",
    match: /newsletter-email/,
  },
  {
    variant: "tc3-unrendered-hook-on-wrong-element",
    check: "testid-carryover",
    kinds: ["moved", "wrong-element"],
    why: "a legacy hook that renders only after a click sits on the wrong element",
    match: /video-modal-close/,
  },
  {
    variant: "tv1-switch-without-testid",
    check: "testid-coverage",
    kinds: ["missing"],
    why: "a role=switch toggle has no data-testid",
    match: /switch/i,
  },
  {
    variant: "tv2-template-buttons-without-testid",
    check: "testid-coverage",
    kinds: ["missing"],
    why: "buttons in a page <template> have no data-testid",
    match: /Copy link|Close/,
  },
  {
    variant: "tv3-grouped-component-root-without-testid",
    check: "testid-coverage",
    kinds: ["component-root", "missing"],
    why: "a component in a feature folder (marketing/promo-card.html) is audited",
    match: /promo-card/,
  },
  {
    variant: "tv4-hrefless-link-button-without-testid",
    check: "testid-coverage",
    kinds: ["missing"],
    why: "an <a> without href that has a click handler has no data-testid",
    match: /Show all reviews/,
  },
];

describe("each defect the second round found is flagged by its check", () => {
  for (const m of MISSES)
    it(`${m.check} flags ${m.variant}: ${m.why}`, async () => {
      const r = await run(
        m.check,
        m.variant,
        m.extra,
        m.copied ? "prod" : "target",
      );
      expect(r.ok, show(r)).toBe(false);
      const hits = r.findings.filter((f) => m.kinds.includes(f.kind));
      expect(hits.length, show(r)).toBeGreaterThan(0);
      if (m.match)
        expect(
          hits.some((f) => m.match!.test(f.message)),
          show(r),
        ).toBe(true);
    }, 240_000);
});

describe("identical pairs stay clean", () => {
  const busy = {
    routes: ["/", "/about"],
    masks: ['[data-testid="review-carousel"]', '[data-testid="hero-video"]'],
    cases: [WIDE, PHONE],
  };

  it("overlap-diff: an autoplay video hero under a tint, with only the video masked", async () => {
    const r = await run("overlap-diff", "dynamic", busy);
    expect(r.findings, show(r)).toEqual([]);
  }, 240_000);

  it("state-capture: in-page links that make sections fade in are not disclosures, and the video and timed modal stay out of the crops", async () => {
    const r = await run("state-capture", "dynamic", busy);
    expect(r.findings, show(r)).toEqual([]);
    const states = (r.states ?? []) as Array<{ key?: string }>;
    expect(
      states.some((s) => /Back to top|See how it works/.test(String(s.key))),
    ).toBe(false);
  }, 480_000);

  it("presence-by-route: a modal that opens 3 s after load is on both sides, unmasked", async () => {
    const r = await run("presence-by-route", "dynamic", {
      ...busy,
      masks: busy.masks,
    });
    expect(r.findings, show(r)).toEqual([]);
  }, 480_000);

  it("interaction-crawl: the timed modal and the sticky header's transition make no findings", async () => {
    const r = await run("interaction-crawl", "dynamic", busy);
    expect(r.findings, show(r)).toEqual([]);
  }, 480_000);

  it("text-style-diff and alignment-diff: a relative date that ticked over is matched by its datetime", async () => {
    for (const check of ["text-style-diff", "alignment-diff", "spacing-diff"]) {
      const r = await run(check, "dynamic", busy);
      expect(r.findings, `${check}\n${show(r)}`).toEqual([]);
    }
  }, 480_000);

  it("production-defects: lazy images scrolled into view, a video hero and late banners are no defects", async () => {
    const r = await run("production-defects", "dynamic", busy);
    expect(r.findings, show(r)).toEqual([]);
    expect(r.defects, show(r)).toEqual([]);
  }, 480_000);

  for (const [variant, check, extra] of [
    ["ov2-check-nested-in-dot-2px-off", "overlap-diff", {}],
    ["ov1-pulled-up-card-20px-off", "overlap-diff", {}],
    ["sp2-wrapper-stops-margin-collapse", "spacing-diff", {}],
    ["sp3-button-taller", "spacing-diff", {}],
    ["ic1-carousel-arrows-dead", "interaction-crawl", {}],
    ["ic2-quantity-stepper-dead", "interaction-crawl", {}],
    ["ic3-anchor-under-sticky-header", "interaction-crawl", {}],
    ["ic4-dialog-close-dead", "interaction-crawl", {}],
    ["sc1-accordion-chevron-no-rotate", "state-capture", {}],
    ["sc2-dropdown-item-hover-lost", "state-capture", {}],
    ["sc3-mega-menu-scrim-missing", "state-capture", {}],
    ["ts1-nav-focus-ring-missing", "text-style-diff", {}],
    ["ts5-gradient-headline-flat", "text-style-diff", {}],
    [
      "al2-hero-image-left-at-768",
      "alignment-diff",
      { cases: [WIDE, TABLET, PHONE] },
    ],
    [
      "al3-trust-strip-left-at-1280",
      "alignment-diff",
      { cases: [WIDE, TABLET, PHONE] },
    ],
    ["pr2-back-to-top-after-scroll-missing", "presence-by-route", THREE_ROUTES],
    ["pr3-cookie-banner-docked-top", "presence-by-route", THREE_ROUTES],
    ["pr5-consent-in-session-storage", "presence-by-route", THREE_ROUTES],
  ] as const)
    it(`${check}: ${variant} served as production on both sides has no findings`, async () => {
      const r = await run(check, variant, { ...extra }, "prod");
      expect(r.findings, show(r)).toEqual([]);
    }, 240_000);
});
