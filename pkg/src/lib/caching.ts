import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

export const MAX_CACHED_REPRESENTATION_BYTES = 2 * 1024 * 1024; // 2 MiB per entry limit for memory retention
export const MAX_COMPRESSED_CACHE_ENTRIES = 200;

export type RepresentationEncoding = "identity" | "br" | "gzip";

/**
 * A selected static representation owns its body, strong validator, and
 * length as one immutable unit. Every field is derived from the same bytes
 * (`buffer`) that are delivered on the wire, so a response never advertises a
 * hash or length that describes different content. Prompt 107.
 */
export interface StaticRepresentation {
  buffer: Buffer;
  encoding: RepresentationEncoding;
  /** Strong ETag for the exact `buffer` delivered: identity, or `"-br"`/`"-gzip"` suffixed. */
  etag: string;
  /** Strong ETag of the raw (identity) bytes this representation derives from. */
  rawEtag: string;
  size: number;
}

interface ReprCacheItem {
  representation: StaticRepresentation;
  /** Raw file size at cache time (invalidation hint). */
  size: number;
  /** Raw file mtime at cache time (invalidation hint). */
  mtimeMs: number;
}

// Single-flight in-progress representation reads/compressions.
const inFlightRepresentations = new Map<string, Promise<StaticRepresentation | null>>();

// Bounded in-memory representation cache (raw and encoded shares one store).
const representationCache = new Map<string, ReprCacheItem>();

/** Clear all cached representations and any in-flight work. */
export const clearStaticRepresentationCache = (): void => {
  inFlightRepresentations.clear();
  representationCache.clear();
};

// Back-compat alias used by the shutdown lifecycle and prompt 96 tests.
export const clearCompressedRepresentationCache = clearStaticRepresentationCache;

/** Number of in-progress single-flight representation ops. */
export const getInFlightCompressionsCount = (): number => {
  return inFlightRepresentations.size;
};

/** Number of entries held in the shared bounded representation cache. */
export const getCompressedCacheEntriesCount = (): number => {
  return representationCache.size;
};

/**
 * Load a precompressed sidecar only if its recorded provenance matches the
 * current raw content identity. Validation happens at representation creation
 * (the sidecar is decompressed once to prove it is not corrupt), never a
 * synchronous decompression on every request. Unverified, stale, or corrupt
 * sidecars return null so the caller falls back to on-the-fly compression.
 */
const getVerifiedPrecompressedBytes = async (
  fullPath: string,
  encoding: "br" | "gzip",
  rawEtag: string,
): Promise<Buffer | null> => {
  const sidecarPath = `${fullPath}.${encoding}`;
  const metaPath = `${fullPath}.${encoding}.bmeta`;
  let sidecar: Buffer;
  try {
    sidecar = await readFile(sidecarPath);
    if (!sidecar || !Buffer.isBuffer(sidecar) || sidecar.length === 0) {
      return null;
    }
  } catch {
    return null;
  }
  let meta: { rawHash?: string } | undefined;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as { rawHash?: string };
  } catch {
    // No provenance sidecar: never serve unverified bytes as current content.
    return null;
  }
  if (!meta || meta.rawHash !== rawEtag) {
    // Stale provenance: never serve old bytes under the current ETag.
    return null;
  }
  try {
    // One-time validation at representation creation.
    if (encoding === "br") {
      zlib.brotliDecompressSync(sidecar);
    } else {
      zlib.gunzipSync(sidecar);
    }
  } catch {
    // Corrupt gzip / Brotli bytes must not be served.
    return null;
  }
  return sidecar;
};

/**
 * Acquire a static representation as one immutable owner.
 *
 * `encoding` selects the representation to serve. A single file read binds the
 * body, strong validator, and length together; encoded variants derive from the
 * identical raw snapshot (never a re-opened path that could have changed in
 * between). Concurrency is single-flighted per key and memory is bounded by
 * `MAX_COMPRESSED_CACHE_ENTRIES`.
 *
 * `mtimeMs`/`size` are cache-invalidation hints only: the returned
 * representation's `etag` and `size` always describe its own `buffer`, never
 * the stat values.
 *
 * Returns null if the file is unreadable (caller maps to 404/500).
 */
export const getStaticRepresentation = async (
  fullPath: string,
  encoding: RepresentationEncoding = "identity",
  mtimeMs?: number,
  size?: number,
): Promise<StaticRepresentation | null> => {
  const cacheKey = `${fullPath}\0${encoding}`;

  // Bounded cache hit (mirrors prompt 96 reuse/invalidation semantics).
  const cached = representationCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.representation;
  }

  const flightKey = `${cacheKey}\0${mtimeMs ?? 0}\0${size ?? 0}`;
  const existing = inFlightRepresentations.get(flightKey);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<StaticRepresentation | null> => {
    let raw: Buffer;
    try {
      const content = await readFile(fullPath);
      if (!content || !Buffer.isBuffer(content)) return null;
      raw = content;
    } catch {
      return null;
    }
    const rawEtag = getContentHashEtag(raw);

    let buffer: Buffer = raw;
    let reprEncoding: RepresentationEncoding = "identity";
    let etag = rawEtag;

    if (encoding === "br" || encoding === "gzip") {
      // Prefer a verified precompressed sidecar bound to these exact raw bytes.
      const verified = await getVerifiedPrecompressedBytes(fullPath, encoding, rawEtag);
      if (verified && verified.length > 0) {
        buffer = verified;
        reprEncoding = encoding;
        etag = getEncodedEtag(rawEtag, encoding);
      } else {
        const compressed = encoding === "br"
          ? await brotliCompressAsync(raw)
          : await gzipAsync(raw);
        if (!compressed || !Buffer.isBuffer(compressed) || compressed.length === 0) {
          // Compression unavailable: this asset cannot be served encoded.
          return null;
        }
        buffer = compressed;
        reprEncoding = encoding;
        etag = getEncodedEtag(rawEtag, encoding);
      }
    }

    const representation: StaticRepresentation = {
      buffer,
      encoding: reprEncoding,
      etag,
      rawEtag,
      size: buffer.byteLength,
    };

    if (buffer.byteLength <= MAX_CACHED_REPRESENTATION_BYTES) {
      // Bounded FIFO eviction shared by identity and encoded entries.
      if (representationCache.size >= MAX_COMPRESSED_CACHE_ENTRIES) {
        const oldestKey = representationCache.keys().next().value;
        if (oldestKey) representationCache.delete(oldestKey);
      }
      representationCache.set(cacheKey, {
        representation,
        size: size ?? raw.byteLength,
        mtimeMs: mtimeMs ?? 0,
      });
    }

    return representation;
  })().finally(() => {
    inFlightRepresentations.delete(flightKey);
  });

  inFlightRepresentations.set(flightKey, promise);
  return promise;
};

/**
 * Prompt 96 compatibility wrapper: returns just the compressed Buffer for the
 * negotiated encoding, backed by the shared single-flight owner so there is
 * exactly one compression cache, not a second one.
 */
export const getCompressedStaticAsset = async (
  fullPath: string,
  mtimeMs: number,
  size: number,
  encoding: "br" | "gzip"
): Promise<Buffer | null> => {
  const repr = await getStaticRepresentation(fullPath, encoding, mtimeMs, size);
  return repr ? repr.buffer : null;
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
