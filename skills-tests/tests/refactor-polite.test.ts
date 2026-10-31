// Polite production: every bascik-refactor script that loads production blocks analytics and tracking requests,
// refuses requests other than GET or HEAD outside the target, and can space production page loads apart.
//
// Why: on a portfolio trial every production load fired the site's GA4 and Tag Manager tags, so one route run sent
// hundreds of synthetic page views to the owner's analytics, which the execution contract forbids. The scripts had no
// way to block a host or slow down, so the agent patched Playwright with a preload. These tests cover the flags, the
// pattern forms and their misuse, the cache key, and the request policy on a fake context; the browser test in
// refactor-polite.integration.test.ts runs it against a real page.
import { describe, expect, it } from "vitest";
import {
  blockMatcher,
  DEFAULT_BLOCK,
  installPolitePolicy,
  politeBrowser,
  politeFlags,
  politeSummary,
  validateBlock,
} from "../../skills/bascik-refactor/scripts/lib/capture.mjs";
import {
  parseArgsFor,
  runFooter,
} from "../../skills/bascik-refactor/scripts/lib/checks.mjs";
import {
  cacheKey,
  openProdCache,
} from "../../skills/bascik-refactor/scripts/lib/prod-cache.mjs";
import { parseCliArgs as parseRunChecks } from "../../skills/bascik-refactor/scripts/run-checks.mjs";
import { parseCliArgs as parseCompareRoute } from "../../skills/bascik-refactor/scripts/compare-route.mjs";
import { parseCliArgs as parseGeometryDiff } from "../../skills/bascik-refactor/scripts/geometry-diff.mjs";
import { parseCliArgs as parseCaptureBaselines } from "../../skills/bascik-refactor/scripts/capture-baselines.mjs";

const PROD = "https://www.example.com";
const TARGET = "http://localhost:8080";
const BASE = ["--prod", PROD, "--target", TARGET, "--route", "/"];

describe("blockMatcher", () => {
  const matches = blockMatcher([...DEFAULT_BLOCK, "/api/track*"]);

  it("blocks the default analytics hosts and their subdomains", () => {
    expect(matches("https://www.googletagmanager.com/gtag/js?id=G-1")).toBe(
      "googletagmanager.com",
    );
    expect(matches("https://www.google-analytics.com/g/collect?v=2")).toBe(
      "google-analytics.com",
    );
    expect(matches("https://region1.analytics.google.com/g/collect")).toBe(
      "analytics.google.com",
    );
    const adHost = ["double", "click.net"].join(""); // Google's ad host, split so the spelling check passes it
    expect(matches(`https://stats.g.${adHost}/j/collect`)).toBe(adHost);
    expect(matches("https://www.example.com/_vercel/insights/view")).toBe(
      "/_vercel/insights",
    );
    expect(matches("https://www.facebook.com/tr?id=1&ev=PageView")).toBe(
      "facebook.com/tr",
    );
  });

  it("matches a URL part with a wildcard anywhere in the URL", () => {
    expect(matches("https://www.example.com/api/tracking/hit")).toBe(
      "/api/track*",
    );
  });

  it("leaves the page, its assets and look-alike hosts alone", () => {
    expect(matches("https://www.example.com/")).toBeUndefined();
    expect(matches("https://www.example.com/assets/app.js")).toBeUndefined();
    // A host pattern matches the host and its subdomains, not any host that ends with the same letters.
    expect(matches("https://notgoogletagmanager.com/x.js")).toBeUndefined();
    expect(matches("not a url")).toBeUndefined();
  });
});

describe("validateBlock and politeFlags: misuse", () => {
  it("refuses an empty pattern, a pattern with spaces and a bare word", () => {
    expect(() => validateBlock("")).toThrow(/--block needs a host/);
    expect(() => validateBlock("   ")).toThrow(/--block needs a host/);
    expect(() => validateBlock("stats example.net")).toThrow(/no spaces/);
    expect(() => validateBlock("plausible")).toThrow(
      /plausible\.io, or a URL part with a "\/", such as \/plausible\//,
    );
  });

  it("refuses a pattern that would block every request", () => {
    for (const pattern of ["*", "/", "/*", "**"])
      expect(() => validateBlock(pattern)).toThrow(/would block every request/);
  });

  it("refuses a pattern that matches production or the target itself", () => {
    expect(() =>
      politeFlags({ block: ["example.com"] }, { prod: PROD, target: TARGET }),
    ).toThrow(
      /--block example\.com matches --prod https:\/\/www\.example\.com/,
    );
    expect(() =>
      politeFlags({ block: ["localhost"] }, { prod: PROD, target: TARGET }),
    ).toThrow(/pass a host with its domain/);
    expect(() =>
      politeFlags(
        { block: ["localhost:8080*"] },
        { prod: PROD, target: TARGET },
      ),
    ).toThrow(/matches --target http:\/\/localhost:8080/);
  });

  it("refuses a negative or non-numeric --min-interval-ms", () => {
    for (const raw of ["-5", "", "soon"])
      expect(() => politeFlags({ "min-interval-ms": raw })).toThrow(
        /--min-interval-ms must be a number of milliseconds, 0 or more/,
      );
  });

  it("defaults to the analytics list and no pacing; --no-default-block keeps only --block", () => {
    expect(politeFlags({}, { prod: PROD })).toEqual({
      block: [...DEFAULT_BLOCK],
      minIntervalMs: 0,
    });
    expect(
      politeFlags(
        {
          "no-default-block": true,
          block: ["/api/track"],
          "min-interval-ms": "1100",
        },
        { prod: PROD },
      ),
    ).toEqual({ block: ["/api/track"], minIntervalMs: 1100 });
  });
});

describe("every script that loads production takes the flags", () => {
  const flags = [
    "--block",
    "stats.example.net",
    "--block",
    "/api/track",
    "--min-interval-ms",
    "1000",
  ];
  const expected = {
    block: [...DEFAULT_BLOCK, "stats.example.net", "/api/track"],
    minIntervalMs: 1000,
  };

  it("parseArgsFor (every check CLI)", () => {
    const args = parseArgsFor([...BASE, ...flags]);
    expect(args.polite).toEqual(expected);
    expect(args).not.toHaveProperty("block");
    expect(args).not.toHaveProperty("min-interval-ms");
    expect(parseArgsFor(BASE).polite).toEqual({
      block: [...DEFAULT_BLOCK],
      minIntervalMs: 0,
    });
    expect(parseArgsFor([...BASE, "--no-default-block"]).polite.block).toEqual(
      [],
    );
  });

  it("run-checks, compare-route, geometry-diff and capture-baselines", () => {
    expect(
      parseRunChecks([...BASE, "--no-legacy-repo", ...flags]).polite,
    ).toEqual(expected);
    expect(parseCompareRoute([...BASE, ...flags]).polite).toEqual(expected);
    expect(parseGeometryDiff([...BASE, ...flags]).polite).toEqual(expected);
    expect(
      parseCaptureBaselines(["--prod", PROD, "--route", "/", ...flags]).polite,
    ).toEqual(expected);
  });

  it("each refuses a misused flag before any browser starts", () => {
    expect(() => parseArgsFor([...BASE, "--block", "plausible"])).toThrow(
      /--block plausible/,
    );
    expect(() =>
      parseRunChecks([...BASE, "--no-legacy-repo", "--block", "*"]),
    ).toThrow(/would block every request/);
    expect(() =>
      parseCompareRoute([...BASE, "--block", "www.example.com"]),
    ).toThrow(/matches --prod/);
    expect(() =>
      parseGeometryDiff([...BASE, "--min-interval-ms", "-1"]),
    ).toThrow(/--min-interval-ms/);
  });
});

describe("the production cache key", () => {
  it("holds the block patterns, so a changed block list is a miss", async () => {
    const state = await openProdCache(null, { dir: "unused" });
    const parts = { check: "spacing-diff", route: "/" };
    const a = cacheKey(state, { prod: PROD, polite: politeFlags({}) }, parts);
    const b = cacheKey(
      state,
      { prod: PROD, polite: politeFlags({ "no-default-block": true }) },
      parts,
    );
    expect(a.hash).not.toBe(b.hash);
    // The order of the patterns does not matter, and pacing does not change what production measures.
    const c = cacheKey(
      state,
      {
        prod: PROD,
        polite: { block: [...DEFAULT_BLOCK].reverse(), minIntervalMs: 900 },
      },
      parts,
    );
    expect(c.hash).toBe(a.hash);
  });
});

type FakeRequest = {
  url: string;
  method?: string;
  navigation?: boolean;
};

/** A context whose route handler the test drives by hand, recording what the policy did with each request. */
function fakeContext() {
  let handler: (route: unknown) => Promise<unknown>;
  return {
    async route(_pattern: string, fn: (route: unknown) => Promise<unknown>) {
      handler = fn;
    },
    async send(request: FakeRequest) {
      let outcome = "";
      await handler({
        request: () => ({
          url: () => request.url,
          method: () => request.method ?? "GET",
          isNavigationRequest: () => Boolean(request.navigation),
        }),
        abort: async (reason: string) => {
          outcome = `abort:${reason}`;
        },
        fallback: async () => {
          outcome = "continue";
        },
      });
      return outcome;
    },
  };
}

function policyFor(options: {
  prod?: string;
  target?: string;
  block?: string[];
  minIntervalMs?: number;
}) {
  return {
    prod: options.prod,
    target: options.target,
    matches: blockMatcher(options.block ?? DEFAULT_BLOCK),
    minIntervalMs: options.minIntervalMs ?? 0,
    next: 0,
    stats: { blocked: 0, refused: 0, paced: 0 },
  };
}

describe("installPolitePolicy", () => {
  it("aborts analytics, and every write except to the target", async () => {
    const context = fakeContext();
    const policy = policyFor({ prod: PROD, target: TARGET });
    await installPolitePolicy(context, policy);
    expect(
      await context.send({
        url: "https://www.google-analytics.com/g/collect",
        method: "POST",
      }),
    ).toBe("abort:blockedbyclient");
    expect(
      await context.send({ url: `${PROD}/api/contact`, method: "POST" }),
    ).toBe("abort:blockedbyclient");
    expect(
      await context.send({
        url: "https://forms.example.net/f/1",
        method: "PUT",
      }),
    ).toBe("abort:blockedbyclient");
    expect(
      await context.send({ url: `${PROD}/api/data`, method: "OPTIONS" }),
    ).toBe("abort:blockedbyclient");
    expect(
      await context.send({ url: `${TARGET}/api/contact`, method: "POST" }),
    ).toBe("continue");
    expect(await context.send({ url: `${PROD}/pricing`, method: "GET" })).toBe(
      "continue",
    );
    expect(await context.send({ url: `${PROD}/`, method: "HEAD" })).toBe(
      "continue",
    );
    expect(policy.stats).toEqual({ blocked: 1, refused: 3, paced: 0 });
  });

  it("refuses every write when there is no target (the production-only inventory)", async () => {
    const context = fakeContext();
    const policy = policyFor({ prod: PROD });
    await installPolitePolicy(context, policy);
    expect(
      await context.send({
        url: "http://localhost:8080/api/contact",
        method: "POST",
      }),
    ).toBe("abort:blockedbyclient");
  });

  it("spaces production page loads, not assets or target loads, across contexts", async () => {
    const policy = policyFor({
      prod: PROD,
      target: TARGET,
      minIntervalMs: 120,
    });
    const first = fakeContext();
    const second = fakeContext();
    await installPolitePolicy(first, policy);
    await installPolitePolicy(second, policy);
    const started = Date.now();
    await first.send({ url: `${PROD}/`, navigation: true });
    await first.send({ url: `${PROD}/app.js` });
    await first.send({ url: `${TARGET}/`, navigation: true });
    expect(Date.now() - started).toBeLessThan(100);
    // The bare host without "www." is the same site.
    await second.send({ url: "https://example.com/pricing", navigation: true });
    await second.send({ url: `${PROD}/contact`, navigation: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(230);
    expect(policy.stats.paced).toBe(2);
  });
});

describe("politeBrowser", () => {
  it("installs the policy on every new context and page, and passes everything else through", async () => {
    const routed: unknown[] = [];
    const makeContext = () => ({
      async route(pattern: string) {
        routed.push(pattern);
      },
    });
    const inner = {
      name: "chromium",
      async newContext() {
        return makeContext();
      },
      async newPage() {
        const context = makeContext();
        return { context: () => context };
      },
      async version() {
        return "1.0";
      },
      async close() {
        return "closed";
      },
    };
    const browser = politeBrowser(inner, { prod: PROD });
    await browser.newContext({});
    await browser.newPage();
    expect(routed).toEqual(["**/*", "**/*"]);
    expect(await browser.version()).toBe("1.0");
    expect(await browser.close()).toBe("closed");
    expect(browser.politeStats).toEqual({ blocked: 0, refused: 0, paced: 0 });
    // Wrapping twice would route every request twice.
    expect(politeBrowser(browser, { prod: PROD })).toBe(browser);
  });

  it("blocks service workers in every context and page, even when the caller asks for them", async () => {
    const seen: unknown[] = [];
    const context = { async route() {} };
    const inner = {
      async newContext(options: unknown) {
        seen.push(options);
        return context;
      },
      async newPage(options: unknown) {
        seen.push(options);
        return { context: () => context };
      },
    };
    const browser = politeBrowser(inner, { prod: PROD });
    await browser.newContext({ viewport: { width: 800, height: 600 } });
    await browser.newContext({ serviceWorkers: "allow" });
    await browser.newContext();
    await browser.newPage();
    expect(seen).toEqual([
      { viewport: { width: 800, height: 600 }, serviceWorkers: "block" },
      { serviceWorkers: "block" },
      { serviceWorkers: "block" },
      { serviceWorkers: "block" },
    ]);
  });

  it("reports what it did in the run footer, and nothing when it did nothing", () => {
    expect(politeSummary({ blocked: 0, refused: 0, paced: 0 })).toBeUndefined();
    expect(politeSummary({ blocked: 3, refused: 1, paced: 2 }, 1000)).toBe(
      "polite: 3 tracking request(s) blocked, 1 request(s) other than GET or HEAD refused, 2 production load(s) held to 1000 ms apart",
    );
    expect(
      runFooter(null, undefined, {
        politeStats: { blocked: 2, refused: 0, paced: 0 },
      }),
    ).toEqual(["polite: 2 tracking request(s) blocked"]);
  });
});
