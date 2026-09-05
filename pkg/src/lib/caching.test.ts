import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getContentHashEtag,
  getEncodedEtag,
  resolveCacheControl,
  negotiateCompression,
  parseAcceptEncoding,
  matchesIfNoneMatch,
  getCompressedStaticAsset,
  clearCompressedRepresentationCache,
  getInFlightCompressionsCount,
  getCompressedCacheEntriesCount,
  isCompressibleMime,
  STATIC_CACHE_METADATA,
} from "./caching.ts";

describe("Prompt 39 - Caching Layer Unit Tests", () => {
  beforeEach(() => {
    STATIC_CACHE_METADATA.clear();
  });

  it("produces identical ETags for identical bytes across two separate calls / instances", () => {
    const buf1 = Buffer.from("identical file content test 123");
    const buf2 = Buffer.from("identical file content test 123");

    const etag1 = getContentHashEtag(buf1);
    const etag2 = getContentHashEtag(buf2);

    expect(etag1).toBe(etag2);
    expect(etag1.startsWith('"')).toBe(true);
    expect(etag1.endsWith('"')).toBe(true);
  });

  it("is a content hash, not mtime-derived", () => {
    const buf = Buffer.from("some content");
    const etag = getContentHashEtag(buf);
    expect(etag).not.toContain("W/");
    expect(etag).toMatch(/^"[0-9a-f]{32,64}"$/);
  });

  it("computes the content hash ETag once and caches it per file path", () => {
    const buf = Buffer.from("cached content");
    const spy = vi.fn(() => getContentHashEtag(buf));

    // First call computes
    const res1 = spy();
    // Subsequent lookup uses cache
    STATIC_CACHE_METADATA.set("/path/to/asset.svg", { etag: res1, size: buf.length, mtimeMs: 12345 });

    const cached = STATIC_CACHE_METADATA.get("/path/to/asset.svg");
    expect(cached?.etag).toBe(res1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resolves cache-control with default and per-extension mapping", () => {
    expect(resolveCacheControl(".js", undefined)).toBe("public, max-age=3600");
    expect(resolveCacheControl(".png", "public, max-age=3600")).toBe("public, max-age=3600");

    const configMapping = {
      ".js": "public, max-age=31536000, immutable",
      ".png": "public, max-age=86400",
    };
    expect(resolveCacheControl(".js", configMapping)).toBe("public, max-age=31536000, immutable");
    expect(resolveCacheControl(".png", configMapping)).toBe("public, max-age=86400");
    expect(resolveCacheControl(".unknown", configMapping)).toBe("public, max-age=3600");
  });

  it("emits immutable when configured", () => {
    const config = { ".woff2": "public, max-age=31536000, immutable" };
    expect(resolveCacheControl(".woff2", config)).toContain("immutable");
  });

  it("derives distinct, deterministic ETags for encoded representations", () => {
    const rawEtag = '"abc123"';
    const brEtag = getEncodedEtag(rawEtag, "br");
    const gzipEtag = getEncodedEtag(rawEtag, "gzip");

    expect(brEtag).not.toBe(rawEtag);
    expect(gzipEtag).not.toBe(rawEtag);
    expect(brEtag).toBe('"abc123-br"');
    expect(gzipEtag).toBe('"abc123-gzip"');
  });

  it("negotiates compression: br when accepted, gzip when only gzip accepted, identity when neither", () => {
    expect(negotiateCompression("br, gzip, deflate")).toBe("br");
    expect(negotiateCompression("gzip, deflate")).toBe("gzip");
    expect(negotiateCompression("deflate")).toBe("identity");
    expect(negotiateCompression("")).toBe("identity");
    expect(negotiateCompression(undefined)).toBe("identity");
  });

  describe("RFC 9110 representation negotiation (q-values, wildcards, case, exclusions)", () => {
    it.each([
      // Explicit rejection (q=0)
      { header: "br;q=0, gzip;q=0", expected: "identity" },
      { header: "br;q=0, gzip;q=1.0", expected: "gzip" },
      { header: "br;q=0.5, gzip;q=0.8", expected: "gzip" },
      { header: "br;q=0.8, gzip;q=0.5", expected: "br" },
      { header: "br;q=1, gzip;q=1", expected: "br" },
      // Case-insensitivity
      { header: "GZIP, DEFLATE", expected: "gzip" },
      { header: "BR, GZIP", expected: "br" },
      { header: "gzip;Q=0.8, br;Q=0.9", expected: "br" },
      // Wildcard handling
      { header: "*;q=0.1", expected: "br" },
      { header: "identity;q=0.8, *;q=0.5", expected: "identity" },
      { header: "*;q=0.9, identity;q=0.1", expected: "br" },
      // Whitespace and array inputs
      { header: "  br ; q=0.5 ,  gzip ; q=0.9  ", expected: "gzip" },
      { header: ["gzip", "br;q=0.5"], expected: "gzip" },
      { header: ["br;q=0", "gzip;q=0"], expected: "identity" },
    ])("negotiateCompression($header) -> $expected", ({ header, expected }) => {
      expect(negotiateCompression(header)).toBe(expected);
    });

    it("parses accept-encoding into preference map", () => {
      const map = parseAcceptEncoding("gzip, deflate;q=0.5, br;q=1.0, *;q=0.1");
      expect(map.get("gzip")).toBe(1.0);
      expect(map.get("deflate")).toBe(0.5);
      expect(map.get("br")).toBe(1.0);
      expect(map.get("*")).toBe(0.1);
    });

    it("restricts negotiation to available encodings", () => {
      // Client accepts br with higher preference, but server only has gzip available
      expect(negotiateCompression("br;q=1.0, gzip;q=0.8", ["gzip"])).toBe("gzip");
      // Client accepts only br, but server only has gzip
      expect(negotiateCompression("br, deflate", ["gzip"])).toBe("identity");
    });
  });

  describe("matchesIfNoneMatch (RFC 9110 / RFC 9111 weak & list validator matching)", () => {
    it.each([
      { header: '"tag1"', etags: ['"tag1"'], expected: true },
      { header: '"tag1"', etags: ['"tag2"'], expected: false },
      { header: '"tag1", "tag2", "tag3"', etags: ['"tag2"'], expected: true },
      { header: ' "other" , "abc123-br" ', etags: ['"abc123-br"'], expected: true },
      { header: 'W/"tag1"', etags: ['"tag1"'], expected: true },
      { header: '"tag1"', etags: ['W/"tag1"'], expected: true },
      { header: 'W/"tag1"', etags: ['W/"tag1"'], expected: true },
      { header: '*', etags: ['"anything"'], expected: true },
      { header: ['"other"', '"matching"'], etags: ['"matching"'], expected: true },
      { header: '', etags: ['"tag1"'], expected: false },
      { header: undefined, etags: ['"tag1"'], expected: false },
    ])("matchesIfNoneMatch($header, $etags) -> $expected", ({ header, etags, expected }) => {
      expect(matchesIfNoneMatch(header, ...etags)).toBe(expected);
    });
  });

  it("recognizes compressible and already-compressed MIME types / extensions", () => {
    // Compressible
    expect(isCompressibleMime("text/css", ".css")).toBe(true);
    expect(isCompressibleMime("application/javascript", ".js")).toBe(true);
    expect(isCompressibleMime("image/svg+xml", ".svg")).toBe(true);
    expect(isCompressibleMime("application/json", ".json")).toBe(true);
    expect(isCompressibleMime("text/html", ".html")).toBe(true);

    // Already-compressed (images, video, archives, woff2)
    expect(isCompressibleMime("image/png", ".png")).toBe(false);
    expect(isCompressibleMime("image/jpeg", ".jpg")).toBe(false);
    expect(isCompressibleMime("image/webp", ".webp")).toBe(false);
    expect(isCompressibleMime("font/woff2", ".woff2")).toBe(false);
    expect(isCompressibleMime("video/mp4", ".mp4")).toBe(false);
    expect(isCompressibleMime("application/zip", ".zip")).toBe(false);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Prompt 96 - Bounded Asynchronous Static Compression", () => {
  let tempDir: string;

  beforeEach(async () => {
    clearCompressedRepresentationCache();
    tempDir = await mkdtemp(join(tmpdir(), "bascik-compress-"));
  });

  afterEach(async () => {
    clearCompressedRepresentationCache();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("deduplicates concurrent requests into a single in-flight compression operation", async () => {
    const filePath = join(tempDir, "bundle.js");
    const content = Buffer.from("console.log('hello world');".repeat(100));
    await writeFile(filePath, content);

    const mtime = 1000;
    const size = content.length;

    // Launch 5 concurrent compression requests
    const promises = [
      getCompressedStaticAsset(filePath, mtime, size, "br"),
      getCompressedStaticAsset(filePath, mtime, size, "br"),
      getCompressedStaticAsset(filePath, mtime, size, "br"),
      getCompressedStaticAsset(filePath, mtime, size, "br"),
      getCompressedStaticAsset(filePath, mtime, size, "br"),
    ];

    const results = await Promise.all(promises);

    expect(results[0]).toBeDefined();
    expect(Buffer.isBuffer(results[0])).toBe(true);
    // All 5 promises must return the exact same buffer instance
    for (let i = 1; i < 5; i++) {
      expect(results[i]).toBe(results[0]);
    }

    expect(getInFlightCompressionsCount()).toBe(0);
    expect(getCompressedCacheEntriesCount()).toBe(1);
  });

  it("reuses cached compressed buffer on subsequent calls without reading disk again", async () => {
    const filePath = join(tempDir, "style.css");
    const content = Buffer.from(".class { color: red; }".repeat(50));
    await writeFile(filePath, content);

    const mtime = 2000;
    const size = content.length;

    const res1 = await getCompressedStaticAsset(filePath, mtime, size, "gzip");
    expect(res1).toBeDefined();

    // Second call with same mtime and size uses cache
    const res2 = await getCompressedStaticAsset(filePath, mtime, size, "gzip");
    expect(res2).toBe(res1);
  });

  it("re-compresses if mtimeMs or size changes (invalidation)", async () => {
    const filePath = join(tempDir, "app.js");
    await writeFile(filePath, Buffer.from("version 1 content"));

    const res1 = await getCompressedStaticAsset(filePath, 1000, 17, "br");

    await writeFile(filePath, Buffer.from("version 2 content with different size"));
    const res2 = await getCompressedStaticAsset(filePath, 2000, 38, "br");

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(res1).not.toBe(res2);
  });

  it("returns null and clears in-flight entry if file is missing", async () => {
    const filePath = join(tempDir, "non-existent.js");
    const res = await getCompressedStaticAsset(filePath, 1000, 10, "br");

    expect(res).toBeNull();
    expect(getInFlightCompressionsCount()).toBe(0);
    expect(getCompressedCacheEntriesCount()).toBe(0);
  });
});
