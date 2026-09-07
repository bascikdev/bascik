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
  getStaticRepresentation,
  clearStaticRepresentationCache,
  MAX_CACHED_REPRESENTATION_BYTES,
  MAX_BUFFERED_ASSET_BYTES,
  getStaticDelivery,
  getOpenStreamedAssetHandles,
  makeStreamedAssetEtag,
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

import { mkdtemp, rm, writeFile, stat as fsStat } from "node:fs/promises";
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

describe("Prompt 107 - Static representation snapshot owner", () => {
  let dir: string;

  beforeEach(async () => {
    clearStaticRepresentationCache();
    dir = await mkdtemp(join(tmpdir(), "bascik-repr-"));
  });

  afterEach(async () => {
    clearStaticRepresentationCache();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("derives a strong etag and length from the exact immutable bytes delivered", async () => {
    const p = join(dir, "app.css");
    const body = Buffer.from("body { color: red; }".repeat(20));
    await writeFile(p, body);

    const repr = await getStaticRepresentation(p);

    expect(repr).not.toBeNull();
    expect(repr!.encoding).toBe("identity");
    expect(repr!.size).toBe(body.byteLength);
    expect(repr!.etag).toBe(getContentHashEtag(body));
    expect(repr!.etag).toMatch(/^"[0-9a-f]{32,64}"$/);
  });

  it("single-flights concurrent readers into one file read", async () => {
    const p = join(dir, "style.js");
    const body = Buffer.from("const x = 1;".repeat(50));
    await writeFile(p, body);

    const results = await Promise.all([
      getStaticRepresentation(p),
      getStaticRepresentation(p),
      getStaticRepresentation(p),
    ]);

    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).not.toBeNull();
    // Concurrent readers must share the same immutable buffer.
    expect(results[1]!.buffer).toBe(results[0]!.buffer);
    expect(results[2]!.buffer).toBe(results[0]!.buffer);
  });

  it("re-reads when the file length changes (invalidation on content replacement)", async () => {
    const p = join(dir, "main.css");
    const first = Buffer.from("A".repeat(100));
    const second = Buffer.from("B".repeat(220));
    await writeFile(p, first);

    const repr1 = await getStaticRepresentation(p);
    // Length-changing replacement to a same-path file.
    await writeFile(p, second);
    const repr2 = await getStaticRepresentation(p);

    expect(repr1!.buffer.toString()).toBe("A".repeat(100));
    expect(repr2!.buffer.toString()).toBe("B".repeat(220));
    expect(repr1!.etag).not.toBe(repr2!.etag);
    expect(repr2!.size).toBe(220);
  });

  it("handles empty files as a valid zero-length representation", async () => {
    const p = join(dir, "empty.css");
    await writeFile(p, Buffer.alloc(0));

    const repr = await getStaticRepresentation(p);
    expect(repr).not.toBeNull();
    expect(repr!.size).toBe(0);
    expect(repr!.buffer.byteLength).toBe(0);
    expect(repr!.etag).toBe(getContentHashEtag(Buffer.alloc(0)));
  });

  it("produces a distinct encoded representation bound to the raw etag", async () => {
    const p = join(dir, "bundle.js");
    const body = Buffer.from("export const q = 42;".repeat(30));
    await writeFile(p, body);

    const raw = await getStaticRepresentation(p);
    const br = await getStaticRepresentation(p, "br");
    const gz = await getStaticRepresentation(p, "gzip");

    expect(br!.encoding).toBe("br");
    expect(gz!.encoding).toBe("gzip");
    expect(br!.etag).toBe(getEncodedEtag(raw!.etag, "br"));
    expect(gz!.etag).toBe(getEncodedEtag(raw!.etag, "gzip"));
    expect(br!.size).toBe(br!.buffer.byteLength);
  });

  describe("two-tier delivery (prompt 140)", () => {
    it("streams a file one byte over MAX_BUFFERED_ASSET_BYTES from one handle with a weak validator, never buffered or cached", async () => {
      const p = join(dir, "large.bin");
      const body = Buffer.alloc(MAX_BUFFERED_ASSET_BYTES + 1, 0x61);
      await writeFile(p, body);
      const st = await fsStat(p);

      // Even with a compressible encoding negotiated, the large tier is
      // identity only: no buffer-compress path exists for it.
      const delivery = await getStaticDelivery(p, "br", st);
      expect(delivery).not.toBeNull();
      expect(delivery!.kind).toBe("streamed");
      if (!delivery || delivery.kind !== "streamed") throw new Error("unreachable");
      try {
        expect(delivery.encoding).toBe("identity");
        expect(delivery.size).toBe(MAX_BUFFERED_ASSET_BYTES + 1);
        // Weak validator derived from the opened handle's fstat.
        const hst = await delivery.fd.stat();
        expect(delivery.etag).toBe(makeStreamedAssetEtag(hst));
        expect(delivery.etag).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+-[0-9a-z]+"$/);
        expect(getOpenStreamedAssetHandles()).toBe(1);
        expect(getCompressedCacheEntriesCount()).toBe(0);
        // The handle reads the same bytes the validator describes.
        const chunk = Buffer.alloc(16);
        const { bytesRead } = await delivery.fd.read(chunk, 0, 16, 0);
        expect(bytesRead).toBe(16);
        expect(chunk.equals(body.subarray(0, 16))).toBe(true);
      } finally {
        await delivery.close();
      }
      expect(getOpenStreamedAssetHandles()).toBe(0);
      // close() is idempotent.
      await delivery.close();
      expect(getOpenStreamedAssetHandles()).toBe(0);
    });

    it("keeps a file exactly at MAX_BUFFERED_ASSET_BYTES on the buffered tier with a strong ETag", async () => {
      const p = join(dir, "exact.bin");
      const body = Buffer.alloc(MAX_BUFFERED_ASSET_BYTES, 0x62);
      await writeFile(p, body);
      const st = await fsStat(p);

      const delivery = await getStaticDelivery(p, "identity", st);
      expect(delivery!.kind).toBe("buffered");
      if (!delivery || delivery.kind !== "buffered") throw new Error("unreachable");
      expect(delivery.representation.etag).toBe(getContentHashEtag(body));
      expect(delivery.representation.size).toBe(MAX_BUFFERED_ASSET_BYTES);
      expect(getOpenStreamedAssetHandles()).toBe(0);
    });

    it("falls back to identity on the buffered tier when the encoded representation is unavailable", async () => {
      const p = join(dir, "small.css");
      const body = Buffer.from("body{color:red}".repeat(40));
      await writeFile(p, body);
      const st = await fsStat(p);
      const delivery = await getStaticDelivery(p, "gzip", st);
      expect(delivery!.kind).toBe("buffered");
      if (!delivery || delivery.kind !== "buffered") throw new Error("unreachable");
      expect(delivery.representation.encoding).toBe("gzip");
      expect(delivery.representation.rawEtag).toBe(getContentHashEtag(body));
    });

    it("returns null for a large file that disappears between stat and open, leaving no handle open", async () => {
      const p = join(dir, "gone.bin");
      const st = { size: MAX_BUFFERED_ASSET_BYTES + 1, mtimeMs: 1 };
      const delivery = await getStaticDelivery(p, "identity", st);
      expect(delivery).toBeNull();
      expect(getOpenStreamedAssetHandles()).toBe(0);
    });

    it("the bound is the cache ceiling, so buffered and cacheable describe the same assets", () => {
      expect(MAX_BUFFERED_ASSET_BYTES).toBe(MAX_CACHED_REPRESENTATION_BYTES);
    });
  });

  it("ignores a precompressed .br sidecar without a .bmeta provenance stamp and compresses on the fly", async () => {
    // Pins the current contract (S3): nothing in the build emits `.bmeta`, so
    // a bare `.br` sidecar is unverified and never served.
    const zlib = await import("node:zlib");
    const p = join(dir, "asset.js");
    const body = Buffer.from("export const answer = 42;".repeat(40));
    await writeFile(p, body);
    // A sidecar with recognizably different (stale) content.
    await writeFile(`${p}.br`, zlib.brotliCompressSync(Buffer.from("stale bytes")));

    const br = await getStaticRepresentation(p, "br");
    expect(br).not.toBeNull();
    expect(zlib.brotliDecompressSync(br!.buffer).equals(body)).toBe(true);

    // With a matching provenance stamp, the sidecar is served verbatim.
    clearStaticRepresentationCache();
    const sidecar = zlib.brotliCompressSync(body);
    await writeFile(`${p}.br`, sidecar);
    await writeFile(`${p}.br.bmeta`, JSON.stringify({ rawHash: getContentHashEtag(body) }));
    const verified = await getStaticRepresentation(p, "br");
    expect(verified!.buffer.equals(sidecar)).toBe(true);
  });
});
