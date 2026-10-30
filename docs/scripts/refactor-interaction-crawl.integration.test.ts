/**
 * The interaction crawl's "lands under a sticky layer" check in a real browser, with the timing forced instead of left
 * to the machine. Pages are served from memory through page.route, so each side opens its newsletter modal exactly
 * when the test says: production after the measurement, the target while "Back to top" is still settling.
 *
 * Why: on CI an identical busy site served twice reported "Back to top lands under a fixed or sticky layer" on one
 * side only. The layer was the modal that opens 3 s after load: the slower side measured after it opened, so its
 * backdrop sat over the heading. A modal that opens by itself covers the whole page; it is not a sticky header the
 * scroll forgot to clear. A heading that really lands under the sticky header on the target only is still flagged.
 *
 * The same run found a second race: a section below the hero that fades in on load was read as "changes by itself" on
 * the side whose fade started after the crawl's first look, so "See how it works" scrolled to the next heading there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  activate,
  diffEffects,
  observeVolatile,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";
import { docsDir } from "./refactor-parity-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;

beforeAll(async () => {
  const { chromium } = await loadPlaywright({ cwd: docsDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/**
 * A page with a fixed header that shrinks on scroll (with a transition), a long body, a footer "Back to top" link and
 * a newsletter modal on a timer that fires `modalMs` after the Back to top click (never when null): the slower side's
 * 3 s timer, pinned to the moment the scroll back up is settling. `padding` is the scroll-padding-top that
 * keeps a scrolled-to heading clear of the header.
 */
function page({
  modalMs,
  padding,
}: {
  modalMs: number | null;
  padding: number;
}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>About · Milk frother</title>
<style>
html { scroll-behavior: smooth; scroll-padding-top: ${padding}px; }
body { margin: 0; padding-top: 80px; font: 16px/1.6 Arial, sans-serif; }
.site-header { position: fixed; top: 0; left: 0; right: 0; z-index: 20; padding: 24px 32px; background: #fff; transition: padding .3s ease; }
.site-header.is-compact { padding: 8px 32px; }
section { padding: 0 32px; min-height: 900px; }
</style></head>
<body>
<header class="site-header" data-testid="site-header"><a href="/" data-testid="site-header-logo">Milk frother</a></header>
<main>
  <section><p><a href="#specs" data-testid="jump-specs">Jump to specs</a></p><h1>About Milk frother</h1><p>Foam.</p></section>
  <section id="specs"><h2>Specs</h2><p>Whisk speed.</p></section>
</main>
<footer><a href="#top" data-testid="site-footer-top">Back to top</a></footer>
<dialog data-testid="newsletter-modal"><button type="button" data-testid="newsletter-modal-close">Close</button><h2>Frothy news, monthly</h2></dialog>
<script>
document.body.id = "top";
const header = document.querySelector(".site-header");
addEventListener("scroll", () => header.classList.toggle("is-compact", scrollY > 40), { passive: true });
const modalMs = ${JSON.stringify(modalMs)};
document.querySelector("[data-testid=site-footer-top]").addEventListener("click", () => {
  if (modalMs !== null) setTimeout(() => document.querySelector("dialog").showModal(), modalMs);
});
</script>
</body></html>`;
}

/** Activates `selector` on /about of a page served from memory and returns the recorded effect. */
async function effectOn(
  html: string,
  selector: string,
  volatile: Record<string, unknown> = {},
) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 800 },
  });
  try {
    const tab = await context.newPage();
    await tab.route(
      "http://crawl.test/**",
      (route: { fulfill: (o: object) => Promise<void> }) =>
        route.fulfill({ contentType: "text/html", body: html }),
    );
    return await activate(tab, "http://crawl.test/", "/about", selector, {
      masks: [],
      volatile,
      settleMs: 0,
    });
  } finally {
    await context.close();
  }
}

const anchor = {
  tag: "A",
  role: "link",
  name: "Back to top",
  text: "Back to top",
  href: "#top",
  testId: "site-footer-top",
};
const jump = {
  ...anchor,
  name: "Jump to specs",
  text: "Jump to specs",
  href: "#specs",
  testId: "jump-specs",
};
/** What observeVolatile learns the page does by itself: the modal opens and shows its texts (body is #top). */
const modalVolatile = {
  selectors: ["#top > dialog"],
  shown: [
    "BUTTON:Close",
    "H2:Frothy news, monthly",
    "DIALOG:CloseFrothy news, monthly",
  ],
};

describe("where an in-page link lands, with the timing forced", () => {
  it("a timed modal that opens on one side while Back to top settles is not a sticky layer over the heading", async () => {
    const selector = '[data-testid="site-footer-top"]';
    // Production measures before its modal opens; the target's modal opens while the scroll back up settles.
    const prod = await effectOn(
      page({ modalMs: null, padding: 0 }),
      selector,
      modalVolatile,
    );
    const target = await effectOn(
      page({ modalMs: 150, padding: 0 }),
      selector,
      modalVolatile,
    );
    expect(prod?.scrollTarget).toMatch(/About Milk frother/);
    expect(target?.scrollTarget).toMatch(/About Milk frother/);
    // The modal really opened between the two measurements on the target (not before both, not after both).
    const bare = await effectOn(page({ modalMs: 150, padding: 0 }), selector, {
      shown: modalVolatile.shown,
    });
    expect(bare?.changed).toContain("open: false -> true");
    // Looked through even when the crawl did not learn the modal opens by itself: the heading is not under it.
    expect(bare?.landing?.covered).toBe(false);
    const findings = diffEffects(
      [{ anchor, effect: prod }],
      [{ anchor, effect: target }],
    );
    expect(findings.map((f: { message: string }) => f.message)).toEqual([]);
  }, 60_000);

  it("a heading that lands under the sticky header on the target only is still flagged", async () => {
    const selector = '[data-testid="jump-specs"]';
    // Same landing measurement, no modal: production clears the header with scroll-padding, the target does not.
    const prod = await effectOn(page({ modalMs: null, padding: 96 }), selector);
    const target = await effectOn(
      page({ modalMs: null, padding: 0 }),
      selector,
    );
    expect(prod?.landing?.covered).toBe(false);
    expect(target?.landing?.covered).toBe(true);
    const findings = diffEffects(
      [{ anchor: jump, effect: prod }],
      [{ anchor: jump, effect: target }],
    );
    expect(
      findings.map((f: { message: string }) => f.message).join("\n"),
    ).toMatch(/Specs.*fixed or sticky layer covers it/);
  }, 60_000);
});

/** A hero, then a section in view at load that fades in 300 ms after load (an IntersectionObserver that fired late). */
const FADE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Milk frother</title>
<style>
html { scroll-behavior: smooth; }
body { margin: 0; font: 16px/1.6 Arial, sans-serif; }
.hero { min-height: 560px; padding: 32px; }
section { padding: 32px; min-height: 900px; }
.fade-in { opacity: 0; transform: translateY(24px); transition: opacity .6s ease, transform .6s ease; }
.fade-in.is-visible { opacity: 1; transform: none; }
</style></head>
<body>
<div class="hero"><h1>Foam like a café, at home</h1><a href="#features" data-testid="home-hero-cta">See how it works</a></div>
<section class="fade-in" id="features"><h2>Why it works</h2><p>Air in a thin film of milk protein.</p></section>
<section class="fade-in" id="gallery"><h2>In the kitchen</h2><p>Photos.</p></section>
<script>
addEventListener("load", () =>
  setTimeout(() => document.querySelector("#features").classList.add("is-visible"), 300),
);
</script>
</body></html>`;

describe("what a page changes by itself, with the timing forced", () => {
  it("a section that fades in just after load is not volatile, so an in-page link still scrolls to its heading", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const tab = await context.newPage();
      await tab.route(
        "http://crawl.test/**",
        (route: { fulfill: (o: object) => Promise<void> }) =>
          route.fulfill({ contentType: "text/html", body: FADE }),
      );
      const volatile = await observeVolatile(
        tab,
        "http://crawl.test/",
        "/",
        [],
        0,
      );
      expect(volatile.shown).not.toContain("H2:Why it works");
      const effect = await activate(
        tab,
        "http://crawl.test/",
        "/",
        '[data-testid="home-hero-cta"]',
        { masks: [], volatile, settleMs: 0 },
      );
      expect(effect?.scrollTarget).toBe("H2:Why it works");
    } finally {
      await context.close();
    }
  }, 60_000);
});
