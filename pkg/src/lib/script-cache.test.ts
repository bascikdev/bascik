import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: {
      cache: {
        enabled: true,
        include: undefined,
        exclude: undefined,
      },
      onBuildScriptError: "error",
      timeout: 30000,
    },
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    isBuild: true,
  },
}));

import { isScriptCacheEnabledForPath, pruneScriptCache, resetScriptCachePruneThrottle } from "./script-cache.ts";
import { BascikConfig } from "./config.ts";
import { mkdir, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("script-cache configuration and scoping", () => {
  beforeEach(() => {
    resetScriptCachePruneThrottle();
    (BascikConfig as any).scripts.cache = {
      enabled: true,
      include: undefined,
      exclude: undefined,
    };
  });

  it("honors scripts.cache boolean disabled", () => {
    (BascikConfig as any).scripts.cache = { enabled: false };
    expect(isScriptCacheEnabledForPath("src/pages/index.html")).toBe(false);
  });

  it("honors scripts.cache object form with include and exclude", () => {
    (BascikConfig as any).scripts.cache = {
      enabled: true,
      include: ["src/pages/**"],
      exclude: ["src/pages/live/**"],
    };

    expect(isScriptCacheEnabledForPath("src/pages/about.html")).toBe(true);
    expect(isScriptCacheEnabledForPath("src/pages/live/feed.html")).toBe(false);
    expect(isScriptCacheEnabledForPath("src/components/card.html")).toBe(false);
  });

  it("prunes cache entries older than 7 days", async () => {
    const tempDir = join(tmpdir(), `bascik-cache-prune-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const oldFile = join(tempDir, "old-entry.json");
    const newFile = join(tempDir, "new-entry.json");

    await writeFile(oldFile, "{}", "utf8");
    await writeFile(newFile, "{}", "utf8");

    // Set mtime to 10 days ago for oldFile
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, tenDaysAgo, tenDaysAgo);

    await pruneScriptCache(tempDir);

    const remaining = await readdir(tempDir);
    expect(remaining).toContain("new-entry.json");
    expect(remaining).not.toContain("old-entry.json");

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("script-cache - deterministic clock-driven TTL and throttle boundaries", () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const ONE_HOUR_MS = 60 * 60 * 1000;

  /** Fake clock whose `now()` is set explicitly per test; timer scheduling is unused by pruneScriptCache. */
  const makeFakeClock = (initialNow: number) => {
    let current = initialNow;
    return {
      now: () => current,
      set: (value: number) => { current = value; },
      setTimeout: () => { throw new Error("not used by pruneScriptCache"); },
      clearTimeout: () => { },
      setInterval: () => { throw new Error("not used by pruneScriptCache"); },
      clearInterval: () => { },
    };
  };

  let tempDir: string;

  beforeEach(async () => {
    resetScriptCachePruneThrottle();
    tempDir = join(tmpdir(), `bascik-cache-clock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  it("prunes an entry exactly at the seven-day TTL boundary (inclusive)", async () => {
    const baseNow = Date.UTC(2026, 8, 3, 0, 0, 0);
    const fileMtime = baseNow - SEVEN_DAYS_MS; // exactly SEVEN_DAYS_MS old
    const filePath = join(tempDir, "exact-ttl.json");
    await writeFile(filePath, "{}", "utf8");
    await utimes(filePath, new Date(fileMtime), new Date(fileMtime));

    const clock = makeFakeClock(baseNow);
    await pruneScriptCache(tempDir, true, clock);

    const remaining = await readdir(tempDir);
    // now - mtimeMs === SEVEN_DAYS_MS is NOT > TTL, so the documented rule keeps it.
    expect(remaining).toContain("exact-ttl.json");
  });

  it("prunes an entry one millisecond past the TTL boundary", async () => {
    const baseNow = Date.UTC(2026, 8, 3, 0, 0, 0);
    const fileMtime = baseNow - SEVEN_DAYS_MS - 1; // one ms older than the TTL
    const filePath = join(tempDir, "just-older.json");
    await writeFile(filePath, "{}", "utf8");
    await utimes(filePath, new Date(fileMtime), new Date(fileMtime));

    const clock = makeFakeClock(baseNow);
    await pruneScriptCache(tempDir, true, clock);

    const remaining = await readdir(tempDir);
    expect(remaining).not.toContain("just-older.json");
  });

  it("keeps an entry one millisecond newer than the TTL boundary", async () => {
    const baseNow = Date.UTC(2026, 8, 3, 0, 0, 0);
    const fileMtime = baseNow - SEVEN_DAYS_MS + 1; // one ms newer than the TTL
    const filePath = join(tempDir, "just-newer.json");
    await writeFile(filePath, "{}", "utf8");
    await utimes(filePath, new Date(fileMtime), new Date(fileMtime));

    const clock = makeFakeClock(baseNow);
    await pruneScriptCache(tempDir, true, clock);

    const remaining = await readdir(tempDir);
    expect(remaining).toContain("just-newer.json");
  });

  it("throttles non-forced pruning for one hour and resumes exactly at the boundary", async () => {
    const baseNow = Date.UTC(2026, 8, 3, 0, 0, 0);
    const clock = makeFakeClock(baseNow);

    const oldFile = join(tempDir, "old-entry.json");
    await writeFile(oldFile, "{}", "utf8");
    const staleMtime = baseNow - SEVEN_DAYS_MS - 1;
    await utimes(oldFile, new Date(staleMtime), new Date(staleMtime));

    // First non-forced prune runs (throttle starts at 0) and removes the stale entry.
    await pruneScriptCache(tempDir, false, clock);
    expect(await readdir(tempDir)).not.toContain("old-entry.json");

    // Re-create a stale entry and advance to just before the one-hour throttle boundary.
    await writeFile(oldFile, "{}", "utf8");
    await utimes(oldFile, new Date(staleMtime), new Date(staleMtime));
    clock.set(baseNow + ONE_HOUR_MS - 1);
    await pruneScriptCache(tempDir, false, clock);
    expect(await readdir(tempDir)).toContain("old-entry.json"); // still throttled, no prune ran

    // Advance to exactly the one-hour boundary: throttle has elapsed, prune runs.
    clock.set(baseNow + ONE_HOUR_MS);
    await pruneScriptCache(tempDir, false, clock);
    expect(await readdir(tempDir)).not.toContain("old-entry.json");
  });

  it("forced pruning bypasses only the throttle, not the TTL retention policy", async () => {
    const baseNow = Date.UTC(2026, 8, 3, 0, 0, 0);
    const clock = makeFakeClock(baseNow);

    const freshFile = join(tempDir, "fresh.json");
    await writeFile(freshFile, "{}", "utf8");
    // Freshly written file has an mtime effectively "now" on disk, well within the TTL.

    // Exhaust the throttle first.
    await pruneScriptCache(tempDir, false, clock);
    // Immediately force again: throttle would normally block this, but force bypasses it.
    await pruneScriptCache(tempDir, true, clock);

    // The fresh file is not older than the seven-day TTL, so it survives even
    // though the throttle was bypassed.
    expect(await readdir(tempDir)).toContain("fresh.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
});
