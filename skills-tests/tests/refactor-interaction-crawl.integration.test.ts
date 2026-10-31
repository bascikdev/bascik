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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import {
  activate,
  diffEffects,
  discover,
  observeVolatile,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";
import { packageDir } from "./refactor-parity-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;

beforeAll(async () => {
  const { chromium } = await loadPlaywright({ cwd: packageDir });
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

/**
 * A menu button (and, with `twins`, a second look-alike) whose id a script randomizes on every load, so the selector
 * recorded at discovery finds nothing after activate()'s reload.
 */
const randomIds = (twins: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Menu · Milk frother</title></head>
<body>
<header>
  <button type="button" aria-expanded="false" data-role="menu">Menu</button>
  ${twins ? '<button type="button" aria-expanded="false" data-role="menu">Menu</button>' : ""}
</header>
<script>
for (const button of document.querySelectorAll("[data-role=menu]")) {
  button.id = "menu-" + Math.random().toString(16).slice(2, 6);
  button.addEventListener("click", () => button.setAttribute("aria-expanded", "true"));
}
</script>
</body></html>`;

describe("an element whose selector changes between loads", () => {
  const menu = {
    selector: "#menu-3f9a",
    anchor: {
      mode: "click",
      tag: "BUTTON",
      role: "button",
      name: "Menu",
      text: "Menu",
      href: null,
      testId: null,
    },
  };
  const effectOnMenu = async (twins: boolean) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const tab = await context.newPage();
      await tab.route(
        "http://crawl.test/**",
        (route: { fulfill: (o: object) => Promise<void> }) =>
          route.fulfill({ contentType: "text/html", body: randomIds(twins) }),
      );
      return await activate(tab, "http://crawl.test/", "/", menu, {
        masks: [],
        volatile: {},
        settleMs: 0,
      });
    } finally {
      await context.close();
    }
  };

  it("is found again by its role and name, so its effect is still measured", async () => {
    const effect = await effectOnMenu(false);
    expect(effect?.changed.join("\n")).toContain(
      "aria-expanded: false -> true",
    );
  }, 60_000);

  it("is left unmeasured, not guessed, when look-alikes share its anchor", async () => {
    // Two "Menu" buttons with fresh ids: picking either could measure the wrong one. diffEffects reports it.
    expect(await effectOnMenu(true)).toBeNull();
  }, 60_000);
});

/** A product page whose Add to cart button posts to the live site's cart API through fetch, next to a harmless menu. */
const CART = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Milk frother</title></head>
<body>
<header><button type="button" aria-expanded="false" data-testid="site-menu">Menu</button></header>
<main>
  <h1>Milk frother</h1>
  <button type="button" data-testid="add-to-cart">Add to cart</button>
  <div class="vote" style="cursor: pointer" data-testid="vote">Like</div>
</main>
<script>
document.querySelector("[data-testid=site-menu]").addEventListener("click", (e) =>
  e.currentTarget.setAttribute("aria-expanded", "true"),
);
document.querySelector("[data-testid=add-to-cart]").addEventListener("click", () =>
  fetch("/api/cart", { method: "POST" }),
);
document.querySelector("[data-testid=vote]").addEventListener("click", () =>
  fetch("/api/vote", { method: "POST" }),
);
</script>
</body></html>`;

describe("controls with side effects on the live site", () => {
  const discovered = async (skip: string[]) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const tab = await context.newPage();
      await tab.route(
        "http://crawl.test/**",
        (route: { fulfill: (o: object) => Promise<void> }) =>
          route.fulfill({ contentType: "text/html", body: CART }),
      );
      await tab.goto("http://crawl.test/");
      const items = await discover(tab, [], skip);
      return items.map(
        (i: { anchor: { testId: string | null } }) => i.anchor.testId,
      );
    } finally {
      await context.close();
    }
  };

  it("a JS-handled button that posts is crawled like any other: the crawl is not read-only", async () => {
    const ids = await discovered([]);
    expect(ids).toContain("add-to-cart");
    expect(ids).toContain("vote");
  }, 60_000);

  it("--skip-control keeps the crawl off the controls it names, button or listener-only element", async () => {
    const ids = await discovered([
      '[data-testid="add-to-cart"]',
      '[data-testid="vote"]',
    ]);
    expect(ids).not.toContain("add-to-cart");
    expect(ids).not.toContain("vote");
    expect(ids).toContain("site-menu");
  }, 60_000);
});

describe("a production origin that redirects to another origin", () => {
  const ABOUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>About · Milk frother</title></head>
<body><main><h1>About</h1><button type="button" aria-expanded="false" data-testid="about-more">More</button></main>
<script>
document.querySelector("[data-testid=about-more]").addEventListener("click", (e) =>
  e.currentTarget.setAttribute("aria-expanded", "true"),
);
</script>
</body></html>`;

  it("records the URL as a path, as on the target, instead of a 'leaves the page' finding on every control", async () => {
    // --prod http://localhost:<port> while production answers from http://127.0.0.1:<port> (a 301, like http to
    // https or a bare domain to www).
    const server = createServer((req, res) => {
      if (String(req.headers.host).startsWith("localhost")) {
        res.writeHead(301, {
          location: `http://127.0.0.1:${port}${req.url}`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(ABOUT);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const tab = await context.newPage();
      const effect = await activate(
        tab,
        `http://localhost:${port}/`,
        "/about",
        '[data-testid="about-more"]',
        { masks: [], volatile: {}, settleMs: 0 },
      );
      expect(tab.url()).toBe(`http://127.0.0.1:${port}/about`);
      expect(effect?.url).toBe("/about");
      expect(effect?.changed).toContain("aria-expanded: false -> true");
    } finally {
      await context.close();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});
