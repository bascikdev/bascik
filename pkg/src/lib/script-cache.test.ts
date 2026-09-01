import { describe, expect, it, vi, beforeEach } from "vitest";

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
    directory: { out: "dist", pages: "src/pages", components: "src/components" },
    isBuild: true,
  },
}));

import { isScriptCacheEnabledForPath, pruneScriptCache } from "./script-cache.ts";
import { BascikConfig } from "./config.ts";
import { mkdir, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("script-cache configuration and scoping", () => {
  beforeEach(() => {
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
