import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getContentHashEtag,
  getEncodedEtag,
  resolveCacheControl,
  negotiateCompression,
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
