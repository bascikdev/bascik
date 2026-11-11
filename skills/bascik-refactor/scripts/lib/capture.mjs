// Identical capture settings for production and the Bascik target. Dependency-free; Node.js 24.21+.
// The functions take a Playwright page or browser from the caller; nothing here imports Playwright.

/**
 * Browser context options for one matrix case: the exact viewport, device scale factor 1, reduced motion and the
 * light color scheme, so two captures differ only by the site. A case may override colorScheme, reducedMotion,
 * hasTouch and isMobile to test those conditions.
 */
export function contextOptions(matrixCase) {
  const options = {
    viewport: { width: matrixCase.width, height: matrixCase.height },
    deviceScaleFactor: 1,
    reducedMotion: matrixCase.reducedMotion ?? "reduce",
    colorScheme: matrixCase.colorScheme ?? "light",
  };
  for (const key of ["hasTouch", "isMobile"])
    if (matrixCase[key] !== undefined) options[key] = matrixCase[key];
  return options;
}

/** How many viewport-height steps the scroll-through takes at most, so an infinite-scroll page cannot hold it. */
export const SCROLL_STEPS_CAP = 40;

/**
 * Waits until the page is stable enough to measure: fonts ready, every image complete, finite animations finished,
 * scrolled to the top. Before that it scrolls the page through in viewport-height steps (at most SCROLL_STEPS_CAP)
 * and back: a loading="lazy" image is switched to eager, so a full-page screenshot draws it whatever distance
 * Chromium would have loaded it from, and content that appears when it scrolls into view (an IntersectionObserver
 * fade-in, framer-motion whileInView, content-visibility: auto) is revealed on both sides alike. Every scroll is
 * instant, also on a page with scroll-behavior: smooth. Each wait is capped so an image that never loads or a
 * looping animation cannot hang the run.
 */
export async function settle(page, { timeout = 10_000 } = {}) {
  await page.evaluate(
    async ({ limit, cap }) => {
      const capped = (promise) =>
        Promise.race([promise, new Promise((r) => setTimeout(r, limit))]);
      const frames = () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
      const jump = (top) =>
        window.scrollTo({ top, left: 0, behavior: "instant" });
      const loaded = (img) =>
        img.complete ||
        new Promise((r) => {
          img.addEventListener("load", r, { once: true });
          img.addEventListener("error", r, { once: true });
        });
      await capped(document.fonts.ready);
      for (const img of document.images)
        if (img.loading === "lazy" && !img.complete) img.loading = "eager";
      const step = Math.max(1, window.innerHeight);
      for (let i = 1; i <= cap; i++) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const before = window.scrollY;
        if (before >= max) break;
        jump(Math.min(i * step, max));
        // A page whose window does not scroll (overflow: hidden on the root) ends the pass at once.
        if (window.scrollY <= before) break;
        await frames();
      }
      // Images added by the pass (a lazy section, a reveal) load eagerly too.
      for (const img of document.images)
        if (img.loading === "lazy" && !img.complete) img.loading = "eager";
      jump(0);
      await frames();
      await capped(Promise.all([...document.images].map(loaded)));
      await capped(
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        ),
      );
      jump(0);
    },
    { limit: timeout, cap: SCROLL_STEPS_CAP },
  );
}

/**
 * Joins a route onto an origin: ("https://www.example.com", "/pricing") -> "https://www.example.com/pricing".
 * A path on the origin is a base path and is kept: ("http://localhost:8080/docs", "/pricing") ->
 * "http://localhost:8080/docs/pricing".
 */
export function routeUrl(origin, route) {
  const base = new URL(origin.endsWith("/") ? origin : `${origin}/`);
  return new URL(String(route).replace(/^\/+/, ""), base).href;
}

/** Opens `url` in a fresh context for `matrixCase` and settles it. The caller closes the returned context. */
export async function openPage(browser, url, matrixCase) {
  const context = await browser.newContext(contextOptions(matrixCase));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });
  await settle(page);
  return { context, page };
}

/**
 * The analytics and tracking requests every script blocks unless --no-default-block: production's owner must not see
 * synthetic page views from the crawl, the cache warm-up and every matrix case. A value without "/" is a host and
 * matches its subdomains; a value with "/" matches anywhere in the URL ("*" is a wildcard). Blocked on both sides, so a
 * tag that injects markup (an iframe, a consent layer loaded by Tag Manager) is missing from both, never from one.
 */
export const DEFAULT_BLOCK = Object.freeze([
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net", // codespell:ignore
  "/_vercel/insights",
  "/_vercel/speed-insights",
  "plausible.io",
  "cdn.segment.com",
  "api.segment.io",
  "hotjar.com",
  "hotjar.io",
  "connect.facebook.net",
  "facebook.com/tr",
  "clarity.ms",
  "static.cloudflareinsights.com",
]);

/** The parseArgs options of the polite production flags, shared by every script that loads production. */
export const POLITE_OPTIONS = Object.freeze({
  block: { type: "string", multiple: true },
  "no-default-block": { type: "boolean", default: false },
  "min-interval-ms": { type: "string" },
});

/** The --help lines of the polite production flags. */
export const POLITE_HELP = `  --block <pattern>     Block requests to this host (it and its subdomains, such as stats.example.net) or URL part
                        (such as /api/track, "*" a wildcard) on both sides, in addition to the analytics defaults
                        (repeatable)
  --no-default-block    Do not block the default analytics hosts (Google Tag Manager, Analytics and ads,
                        Vercel insights, Plausible, Segment, Hotjar, the Facebook pixel, Clarity, Cloudflare insights)
  --min-interval-ms <n> Least time between two production page loads (default 0); pass 1000 or more for a site
                        you do not run`;

const escapeRegExp = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Host and port with a leading "www." removed, the way sameSite compares origins, or null for a non-URL. */
function siteHost(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}:${u.port}`;
  } catch {
    return null;
  }
}

/**
 * Rejects a --block value that would not block what it names, or would block everything: empty, with whitespace, a
 * bare word ("plausible": a host needs its domain, a URL part its "/"), or one made only of wildcards and slashes.
 */
export function validateBlock(pattern) {
  const value = String(pattern ?? "");
  if (!value.trim())
    throw new Error(
      "--block needs a host such as stats.example.net or a URL part such as /api/track",
    );
  if (/\s/.test(value))
    throw new Error(`--block "${value}": a pattern has no spaces`);
  if (/^[*/]+$/.test(value))
    throw new Error(
      `--block ${value} would block every request, the page included; name a host or a URL part`,
    );
  if (!value.includes("/") && !value.includes("*") && !value.includes("."))
    throw new Error(
      `--block ${value}: pass a host with its domain, such as ${value}.io, or a URL part with a "/", such as /${value}/`,
    );
}

/** A function that returns the first pattern a URL matches, or undefined (see DEFAULT_BLOCK for the pattern forms). */
export function blockMatcher(patterns) {
  const tests = (patterns ?? []).map((pattern) => {
    const p = String(pattern);
    if (!p.includes("/") && !p.includes("*")) {
      const host = p.toLowerCase();
      return (u) => {
        const h = u.hostname.toLowerCase();
        return h === host || h.endsWith(`.${host}`);
      };
    }
    const re = new RegExp(p.split("*").map(escapeRegExp).join(".*"), "i");
    return (u) => re.test(u.href);
  });
  return (url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    const i = tests.findIndex((test) => test(u));
    return i === -1 ? undefined : patterns[i];
  };
}

/**
 * The polite production settings from parsed values: { block, minIntervalMs }, where block is the default list
 * (unless --no-default-block) plus every --block. A pattern that matches production's or the target's own page is
 * refused: it would block the page under test.
 */
export function politeFlags(values, { prod, target } = {}) {
  const extra = values?.block ?? [];
  for (const pattern of extra) validateBlock(pattern);
  const block = [
    ...new Set([
      ...(values?.["no-default-block"] ? [] : DEFAULT_BLOCK),
      ...extra,
    ]),
  ];
  const matches = blockMatcher(block);
  for (const [flag, origin] of [
    ["--prod", prod],
    ["--target", target],
  ]) {
    const hit = origin ? matches(origin) : undefined;
    if (hit !== undefined)
      throw new Error(
        `--block ${hit} matches ${flag} ${origin} itself, so its pages could not load; block a narrower host or URL part`,
      );
  }
  const raw = values?.["min-interval-ms"];
  const n = Number(raw);
  if (raw !== undefined && (raw === "" || !Number.isFinite(n) || n < 0))
    throw new Error(
      `--min-interval-ms must be a number of milliseconds, 0 or more (got "${raw}")`,
    );
  return { block, minIntervalMs: raw === undefined ? 0 : n };
}

const POLITE = Symbol("bascik-refactor.polite");

/**
 * Context options with service workers blocked, whatever the caller asked for. A worker answers the requests of the
 * page it controls itself, so they never reach context.route: on a reload (the crawl, state capture) a Workbox or
 * next-pwa worker could serve production from its cache, unpaced and unlike a first visit. Blocked on both sides alike.
 */
function noServiceWorkers(options) {
  return { ...(options ?? {}), serviceWorkers: "block" };
}

/**
 * Wraps a Playwright browser so every context it opens blocks service workers and follows the production read-only
 * rule (see installPolitePolicy): `prod` is the production origin, `target` the Bascik origin or undefined, `block` the patterns
 * (DEFAULT_BLOCK by default) and `minIntervalMs` the least time between two production page loads, across every
 * context of this browser. The wrapper counts what it did in `.politeStats`; wrapping it again returns it unchanged.
 * `previous`, a polite browser this one replaces (a relaunch after a crash), hands over its policy: the pacing and the
 * counts carry on instead of starting again.
 */
export function politeBrowser(
  browser,
  { prod, target, block = DEFAULT_BLOCK, minIntervalMs = 0 } = {},
  previous,
) {
  if (browser?.[POLITE]) return browser;
  const policy = previous?.[POLITE] ?? {
    prod,
    target,
    matches: blockMatcher(block),
    minIntervalMs: Number(minIntervalMs) || 0,
    next: 0,
    stats: { blocked: 0, refused: 0, paced: 0 },
  };
  return new Proxy(browser, {
    get(target_, key) {
      if (key === POLITE) return policy;
      if (key === "politeStats") return policy.stats;
      if (key === "newContext")
        return async (options) => {
          const context = await target_.newContext(noServiceWorkers(options));
          await installPolitePolicy(context, policy);
          return context;
        };
      if (key === "newPage")
        return async (options) => {
          const page = await target_.newPage(noServiceWorkers(options));
          await installPolitePolicy(page.context(), policy);
          return page;
        };
      const value = Reflect.get(target_, key);
      return typeof value === "function" ? value.bind(target_) : value;
    },
  });
}

/**
 * Routes every request of `context` through the read-only rule: a request a block pattern matches is aborted; a
 * request other than GET or HEAD is aborted unless it goes to the target origin (a form post, a beacon or an API write
 * never reaches production or a third party, from either side); and a production page load waits until
 * policy.minIntervalMs after the previous one. Routing a context turns off its HTTP cache, on both sides alike.
 */
export async function installPolitePolicy(context, policy) {
  const prodHost = policy.prod ? siteHost(policy.prod) : null;
  let targetOrigin = null;
  try {
    targetOrigin = policy.target ? new URL(policy.target).origin : null;
  } catch {
    targetOrigin = null;
  }
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (policy.matches(url) !== undefined) {
      policy.stats.blocked++;
      return route.abort("blockedbyclient");
    }
    const method = request.method();
    if (method !== "GET" && method !== "HEAD") {
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
      if (!targetOrigin || origin !== targetOrigin) {
        policy.stats.refused++;
        return route.abort("blockedbyclient");
      }
    }
    if (
      policy.minIntervalMs > 0 &&
      prodHost &&
      request.isNavigationRequest() &&
      siteHost(url) === prodHost
    ) {
      const now = Date.now();
      const at = Math.max(now, policy.next);
      policy.next = at + policy.minIntervalMs;
      if (at > now) {
        policy.stats.paced++;
        await new Promise((r) => setTimeout(r, at - now));
      }
    }
    return route.fallback();
  });
}

/** The line a run prints about what the polite policy did, or undefined when it did nothing. */
export function politeSummary(stats, minIntervalMs = 0) {
  if (!stats) return undefined;
  const parts = [];
  if (stats.blocked) parts.push(`${stats.blocked} tracking request(s) blocked`);
  if (stats.refused)
    parts.push(`${stats.refused} request(s) other than GET or HEAD refused`);
  if (stats.paced)
    parts.push(
      `${stats.paced} production load(s) held to ${minIntervalMs} ms apart`,
    );
  return parts.length ? `polite: ${parts.join(", ")}` : undefined;
}
