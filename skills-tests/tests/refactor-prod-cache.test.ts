// Unit tests for skills/bascik-refactor/scripts/lib/prod-cache.mjs: the cache of production-side measurements the
// parity checks share. The browser half (a run that measures production once and then reads it from the cache) is in
// refactor-parity-checks.integration.test.ts.
//
// Why it exists: in an agent-driven refactor every check run measured production again, at every matrix case, although
// production did not change between runs. A full run took 20 to 50 minutes per route and agents reran it after every
// fix. Production measured once and reused cuts that, as long as anything that changes what production measures (a
// mask, a skip-control, the case, the settle time, the browser, the skill's own code) is part of the key.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROD_CACHE,
  cacheKey,
  cachedProd,
  openProdCache,
  prodCacheFlags,
  prodCacheSummary,
} from "../../skills/bascik-refactor/scripts/lib/prod-cache.mjs";
import { parseArgsFor } from "../../skills/bascik-refactor/scripts/lib/checks.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bascik-prod-cache-"));
});
afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Already removable.
  }
  rmSync(dir, { recursive: true, force: true });
});

const browser = (version = "140.0.0.0") => ({ version: () => version });
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
  "base64",
);
const CASE: Record<string, unknown> = { width: 360, height: 812 };
const base = {
  prod: "https://www.example.com",
  settleMs: 5000,
  masks: [],
  skipControls: [],
  dismiss: [],
};

/** A measuring function that counts its calls. */
function counter<T>(value: T) {
  const fn = async () => {
    fn.calls++;
    return value;
  };
  fn.calls = 0;
  return fn;
}

async function open(over: Record<string, unknown> = {}) {
  return openProdCache(browser(), {
    dir: join(dir, "cache"),
    quiet: true,
    ...over,
  });
}

describe("cachedProd", () => {
  it("runs the measurement every time without a cache (the API default)", async () => {
    const fn = counter({ a: 1 });
    const key = { check: "spacing-diff", route: "/", case: CASE };
    expect(await cachedProd(base, key, fn)).toEqual({ a: 1 });
    expect(await cachedProd(base, key, fn)).toEqual({ a: 1 });
    expect(fn.calls).toBe(2);
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("stores the first measurement under <dir>/<check>/<sha256>.json and reads it back on the next run", async () => {
    const fn = counter({ sections: [{ gap: 24 }] });
    const key = { check: "spacing-diff", route: "/", case: CASE };
    const first = await open();
    expect(await cachedProd({ ...base, prodCache: first }, key, fn)).toEqual({
      sections: [{ gap: 24 }],
    });
    expect(first.stats).toMatchObject({ fromCache: 0, captured: 1 });
    const files = readdirSync(join(dir, "cache", "spacing-diff"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const entry = JSON.parse(
      readFileSync(join(dir, "cache", "spacing-diff", files[0]), "utf8"),
    );
    expect(Date.parse(entry.capturedAt)).not.toBeNaN();
    expect(entry.key).toMatchObject({
      check: "spacing-diff",
      prod: "https://www.example.com",
      route: "/",
      case: CASE,
      settleMs: 5000,
      browser: "140.0.0.0",
    });
    expect(entry.key.source).toMatch(/^[0-9a-f]{64}$/);

    const second = await open();
    expect(await cachedProd({ ...base, prodCache: second }, key, fn)).toEqual({
      sections: [{ gap: 24 }],
    });
    expect(fn.calls).toBe(1);
    expect(second.stats).toMatchObject({ fromCache: 1, captured: 0 });
    expect(second.stats.oldest).toBe(entry.capturedAt);
  });

  it("misses on anything that changes what production measures, and ignores the order of masks", async () => {
    const state = await open();
    const fn = counter(1);
    const key: Record<string, unknown> = {
      check: "text-style-diff",
      route: "/",
      case: CASE,
    };
    const run = (options: Record<string, unknown>, k = key) =>
      cachedProd({ ...base, ...options, prodCache: state }, k, fn);
    await run({ masks: [".a", ".b"] });
    await run({ masks: [".b", ".a"] });
    expect(fn.calls).toBe(1);
    for (const [options, k] of [
      [{ masks: [".a"] }, key],
      [{ masks: [".a", ".b"], skipControls: ["[data-cart]"] }, key],
      [{ masks: [".a", ".b"] }, { ...key, dismiss: [".close"] }],
      [{ masks: [".a", ".b"], settleMs: 0 }, key],
      [{ masks: [".a", ".b"], prod: "https://staging.example.com" }, key],
      [{ masks: [".a", ".b"] }, { ...key, route: "/about" }],
      [{ masks: [".a", ".b"] }, { ...key, case: { ...CASE, height: 640 } }],
      [
        { masks: [".a", ".b"] },
        { ...key, case: { ...CASE, colorScheme: "dark" } },
      ],
      [{ masks: [".a", ".b"] }, { ...key, check: "spacing-diff" }],
      [{ masks: [".a", ".b"] }, { ...key, anchor: "BUTTON:Menu" }],
    ] as const)
      await run(options, k);
    expect(fn.calls).toBe(11);
    // The same key again is a hit.
    await run({ masks: [".a"] });
    expect(fn.calls).toBe(11);
  });

  it("--dismiss changes only presence-by-route's key: state-capture's production side is the same with or without it", async () => {
    // run-checks passes --dismiss to every check; capture-baselines --states takes none. Its open states must still be
    // the entries the first run-checks reads.
    const state = await open();
    const fn = counter(1);
    const key = { check: "state-capture", route: "/", case: CASE };
    await cachedProd({ ...base, prodCache: state }, key, fn);
    await cachedProd(
      { ...base, dismiss: [".close"], prodCache: state },
      key,
      fn,
    );
    expect(fn.calls).toBe(1);
  });

  it("misses after a browser update or a change to the skill's scripts", async () => {
    const key = { check: "spacing-diff", route: "/", case: CASE };
    const a = await openProdCache(browser("140.0.0.0"), {
      dir: join(dir, "cache"),
      quiet: true,
    });
    const b = await openProdCache(browser("141.0.0.0"), {
      dir: join(dir, "cache"),
      quiet: true,
    });
    expect(cacheKey(a, base, key).hash).not.toBe(cacheKey(b, base, key).hash);
    const edited = { ...a, source: "0".repeat(64) };
    expect(cacheKey(a, base, key).hash).not.toBe(
      cacheKey(edited, base, key).hash,
    );
    expect(cacheKey(a, base, key).parts.format).toBeGreaterThanOrEqual(1);
  });

  it("--refresh-prod measures again and overwrites the entry", async () => {
    const key = { check: "spacing-diff", route: "/", case: CASE };
    await cachedProd({ ...base, prodCache: await open() }, key, counter("old"));
    const refreshed = await open({ refresh: true });
    const fn = counter("new");
    expect(await cachedProd({ ...base, prodCache: refreshed }, key, fn)).toBe(
      "new",
    );
    expect(fn.calls).toBe(1);
    expect(refreshed.stats).toMatchObject({ fromCache: 0, captured: 1 });
    expect(
      await cachedProd(
        { ...base, prodCache: await open() },
        key,
        counter("unused"),
      ),
    ).toBe("new");
  });

  it("keeps PNG crops as files beside the entry and restores them as buffers", async () => {
    const key = { check: "overlap-diff", route: "/", case: CASE };
    const value = {
      pairs: [
        { a: "LI:One", png: PNG },
        { a: "LI:Two", png: null },
      ],
    };
    await cachedProd({ ...base, prodCache: await open() }, key, counter(value));
    const files = readdirSync(join(dir, "cache", "overlap-diff")).sort();
    expect(files.some((f) => f.endsWith(".png"))).toBe(true);
    const json = files.find((f) => f.endsWith(".json"))!;
    expect(
      readFileSync(join(dir, "cache", "overlap-diff", json), "utf8"),
    ).not.toContain('"Buffer"');
    const back = (await cachedProd(
      { ...base, prodCache: await open() },
      key,
      counter(null),
    )) as { pairs: Array<{ png: Buffer | null }> };
    expect(Buffer.isBuffer(back.pairs[0].png)).toBe(true);
    expect(back.pairs[0].png!.equals(PNG)).toBe(true);
    expect(back.pairs[1].png).toBeNull();
  });

  it("unhappy path: a corrupt entry or a missing crop file is measured again, not trusted", async () => {
    const key = { check: "overlap-diff", route: "/", case: CASE };
    await cachedProd(
      { ...base, prodCache: await open() },
      key,
      counter({ png: PNG }),
    );
    const folder = join(dir, "cache", "overlap-diff");
    const png = readdirSync(folder).find((f) => f.endsWith(".png"))!;
    rmSync(join(folder, png));
    const state = await open();
    const fn = counter({ png: PNG });
    await cachedProd({ ...base, prodCache: state }, key, fn);
    expect(fn.calls).toBe(1);
    expect(state.warnings.join("\n")).toMatch(/measuring production again/);

    const json = readdirSync(folder).find((f) => f.endsWith(".json"))!;
    writeFileSync(join(folder, json), "{ not json");
    const again = await open();
    const fn2 = counter({ png: PNG });
    await cachedProd({ ...base, prodCache: again }, key, fn2);
    expect(fn2.calls).toBe(1);
    // And the rewritten entry is good again.
    const third = await open();
    await cachedProd({ ...base, prodCache: third }, key, counter(null));
    expect(third.stats.fromCache).toBe(1);
  });

  it("unhappy path: a cache folder it cannot write warns once and runs uncached", async () => {
    // A file where the folder should be: mkdir fails on every platform, as root too.
    writeFileSync(join(dir, "blocked"), "");
    const state = await openProdCache(browser(), {
      dir: join(dir, "blocked", "cache"),
      quiet: true,
    });
    const key = { check: "spacing-diff", route: "/", case: CASE };
    const fn = counter(7);
    expect(await cachedProd({ ...base, prodCache: state }, key, fn)).toBe(7);
    expect(
      await cachedProd(
        { ...base, prodCache: state },
        { ...key, route: "/a" },
        fn,
      ),
    ).toBe(7);
    expect(fn.calls).toBe(2);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toMatch(/cannot write the production cache/);
    expect(state.stats).toMatchObject({ fromCache: 0, captured: 2 });
  });
});

describe("prodCacheSummary", () => {
  it("says how many measurements came from the cache, how old the oldest is, and how to refresh", () => {
    expect(
      prodCacheSummary({
        fromCache: 3,
        captured: 2,
        oldest: "2026-10-30T08:00:00.000Z",
      }),
    ).toBe(
      "production: 3 measurements from cache (oldest 2026-10-30T08:00:00.000Z), 2 captured; pass --refresh-prod after production changes",
    );
    expect(prodCacheSummary({ fromCache: 0, captured: 4 })).toBe(
      "production: 0 measurements from cache, 4 captured; pass --refresh-prod after production changes",
    );
  });
});

describe("the cache flags", () => {
  it("default on, under artifacts/prod-cache", () => {
    expect(DEFAULT_PROD_CACHE).toBe("artifacts/prod-cache");
    expect(prodCacheFlags({})).toEqual({
      prodCache: "artifacts/prod-cache",
      refreshProd: false,
    });
    expect(prodCacheFlags({ "prod-cache": "tmp/c" })).toEqual({
      prodCache: "tmp/c",
      refreshProd: false,
    });
    expect(prodCacheFlags({ "no-prod-cache": true })).toEqual({
      prodCache: null,
      refreshProd: false,
    });
  });

  it("every check CLI takes --refresh-prod, --no-prod-cache and --prod-cache", () => {
    const argv = [
      "--prod",
      "https://a.example",
      "--target",
      "http://b",
      "--route",
      "/",
    ];
    expect(parseArgsFor(argv)).toMatchObject({
      prodCache: "artifacts/prod-cache",
      refreshProd: false,
    });
    expect(parseArgsFor([...argv, "--refresh-prod"])).toMatchObject({
      refreshProd: true,
    });
    expect(parseArgsFor([...argv, "--no-prod-cache"]).prodCache).toBeNull();
  });

  it("misuse: --refresh-prod with --no-prod-cache, or --prod-cache with --no-prod-cache, is an error", () => {
    expect(() =>
      prodCacheFlags({ "refresh-prod": true, "no-prod-cache": true }),
    ).toThrow(/--refresh-prod.*--no-prod-cache/);
    expect(() =>
      prodCacheFlags({ "prod-cache": "x", "no-prod-cache": true }),
    ).toThrow(/--prod-cache.*--no-prod-cache/);
    expect(() => prodCacheFlags({ "prod-cache": " " })).toThrow(/--prod-cache/);
  });
});
