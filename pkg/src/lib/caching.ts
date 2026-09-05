import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

export const MAX_CACHED_REPRESENTATION_BYTES = 2 * 1024 * 1024; // 2 MiB per entry limit for memory retention
export const MAX_COMPRESSED_CACHE_ENTRIES = 200;

// Single-flight in-progress compression operations
const inFlightCompressions = new Map<string, Promise<Buffer | null>>();

// Bounded in-memory compressed representation cache
interface CompressedCacheItem {
  buffer: Buffer;
  encoding: "br" | "gzip";
  mtimeMs: number;
  size: number;
}
const compressedRepresentationCache = new Map<string, CompressedCacheItem>();

export const clearCompressedRepresentationCache = (): void => {
  inFlightCompressions.clear();
  compressedRepresentationCache.clear();
};

export const getInFlightCompressionsCount = (): number => {
  return inFlightCompressions.size;
};

export const getCompressedCacheEntriesCount = (): number => {
  return compressedRepresentationCache.size;
};

export const getCompressedStaticAsset = async (
  fullPath: string,
  mtimeMs: number,
  size: number,
  encoding: "br" | "gzip"
): Promise<Buffer | null> => {
  const cacheKey = `${fullPath}:${encoding}`;

  // 1. Check existing cached buffer if mtime and size match
  const cached = compressedRepresentationCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.buffer;
  }

  // 2. Check if a single-flight compression is already in progress
  const flightKey = `${cacheKey}:${mtimeMs}:${size}`;
  const existingFlight = inFlightCompressions.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  // 3. Initiate single-flight async compression
  const compressionPromise = (async (): Promise<Buffer | null> => {
    try {
      const raw = await readFile(fullPath);
      if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
        return null;
      }

      const compressed = encoding === "br"
        ? await brotliCompressAsync(raw)
        : await gzipAsync(raw);

      if (compressed && Buffer.isBuffer(compressed) && compressed.length > 0) {
        // Only retain in memory if under per-item size threshold
        if (compressed.byteLength <= MAX_CACHED_REPRESENTATION_BYTES) {
          // Bounded cache eviction (LRU / FIFO eviction if full)
          if (compressedRepresentationCache.size >= MAX_COMPRESSED_CACHE_ENTRIES) {
            const oldestKey = compressedRepresentationCache.keys().next().value;
            if (oldestKey) compressedRepresentationCache.delete(oldestKey);
          }
          compressedRepresentationCache.set(cacheKey, {
            buffer: compressed,
            encoding,
            mtimeMs,
            size,
          });
        }
        return compressed;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    inFlightCompressions.delete(flightKey);
  });

  inFlightCompressions.set(flightKey, compressionPromise);
  return compressionPromise;
};

export interface StaticCacheEntry {
  etag: string;
  size: number;
  mtimeMs: number;
}

export const STATIC_CACHE_METADATA = new Map<string, StaticCacheEntry>();

export const getContentHashEtag = (content: Buffer | string): string => {
  const hash = createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content) : content)
    .digest("hex");
  return `"${hash}"`;
};

export const getEncodedEtag = (etag: string, encoding: "br" | "gzip"): string => {
  const inner = etag.replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "");
  return `"${inner}-${encoding}"`;
};

export const resolveCacheControl = (
  ext: string,
  configCacheControl?: string | Record<string, string>
): string => {
  if (typeof configCacheControl === "string") {
    return configCacheControl;
  }
  if (typeof configCacheControl === "object" && configCacheControl !== null) {
    if (ext in configCacheControl) {
      return configCacheControl[ext];
    }
    const withDot = ext.startsWith(".") ? ext : `.${ext}`;
    if (withDot in configCacheControl) {
      return configCacheControl[withDot];
    }
  }
  return "public, max-age=3600";
};

export const parseAcceptEncoding = (
  acceptEncodingHeader?: string | string[]
): Map<string, number> => {
  const map = new Map<string, number>();
  if (!acceptEncodingHeader) return map;

  const raw = Array.isArray(acceptEncodingHeader)
    ? acceptEncodingHeader.join(", ")
    : acceptEncodingHeader;

  const parts = raw.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(";").map((t) => t.trim());
    const coding = tokens[0].toLowerCase();
    let q = 1.0;
    for (let i = 1; i < tokens.length; i++) {
      const param = tokens[i];
      const match = param.match(/^q=([0-9.]*)$/i);
      if (match) {
        const parsed = parseFloat(match[1]);
        if (!isNaN(parsed)) {
          q = Math.max(0, Math.min(1, parsed));
        }
      }
    }
    map.set(coding, q);
  }
  return map;
};

export const negotiateCompression = (
  acceptEncodingHeader?: string | string[],
  availableEncodings: Array<"br" | "gzip"> = ["br", "gzip"]
): "br" | "gzip" | "identity" => {
  if (!acceptEncodingHeader) return "identity";
  const raw = Array.isArray(acceptEncodingHeader)
    ? acceptEncodingHeader.join(", ")
    : acceptEncodingHeader;
  if (!raw.trim()) return "identity";

  const preferences = parseAcceptEncoding(raw);

  const getQ = (coding: string): number => {
    if (preferences.has(coding)) return preferences.get(coding)!;
    if (preferences.has("*")) return preferences.get("*")!;
    return 0;
  };

  const hasExplicitIdentity = preferences.has("identity");
  const qIdentity = hasExplicitIdentity
    ? preferences.get("identity")!
    : preferences.has("*")
      ? preferences.get("*")!
      : 1.0;

  const candidates = availableEncodings
    .map((enc) => ({
      encoding: enc,
      q: getQ(enc),
    }))
    .filter((c) => c.q > 0);

  if (candidates.length === 0) {
    return "identity";
  }

  // Sort candidates by q descending. If equal, prefer 'br' over 'gzip'.
  candidates.sort((a, b) => {
    if (b.q !== a.q) return b.q - a.q;
    if (a.encoding === "br") return -1;
    if (b.encoding === "br") return 1;
    return 0;
  });

  const bestCandidate = candidates[0];
  // If identity was explicitly assigned a higher q than the best compression candidate, honor it
  if (hasExplicitIdentity && qIdentity > bestCandidate.q) {
    return "identity";
  }

  return bestCandidate.encoding;
};

export const matchesIfNoneMatch = (
  ifNoneMatchHeader?: string | string[],
  ...resourceEtags: (string | undefined)[]
): boolean => {
  if (!ifNoneMatchHeader) return false;
  const raw = Array.isArray(ifNoneMatchHeader)
    ? ifNoneMatchHeader.join(", ")
    : ifNoneMatchHeader;
  const header = raw.trim();
  if (!header) return false;

  const validResourceTags = resourceEtags.filter(Boolean) as string[];
  if (validResourceTags.length === 0) return false;

  if (header === "*") return true;

  const normalizeEtag = (tag: string) =>
    tag.trim().replace(/^W\//i, "").replace(/^"/, "").replace(/"$/, "");

  const normalizedResourceTags = validResourceTags.map(normalizeEtag);

  const clientTags = header.split(",").map((t) => t.trim()).filter(Boolean);
  for (const clientTag of clientTags) {
    if (clientTag === "*") return true;
    const norm = normalizeEtag(clientTag);
    if (normalizedResourceTags.includes(norm)) {
      return true;
    }
  }

  return false;
};

const INCOMPRESSIBLE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff2",
  ".mp4", ".webm", ".ogg", ".mp3", ".wav",
  ".zip", ".gz", ".tgz", ".br", ".7z", ".rar", ".tar",
]);

export const isCompressibleMime = (mimeType: string, ext: string): boolean => {
  const cleanExt = ext.toLowerCase();
  if (INCOMPRESSIBLE_EXTS.has(cleanExt)) return false;

  const lowMime = mimeType.toLowerCase();
  if (lowMime.startsWith("image/") && !lowMime.includes("svg") && !lowMime.includes("xml")) {
    return false;
  }
  if (lowMime.startsWith("video/") || lowMime.startsWith("audio/")) {
    return false;
  }
  if (lowMime === "font/woff2") {
    return false;
  }

  return true;
};

export const COMPRESSION_MIN_BYTES = 512;
