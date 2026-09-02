import { createHash } from "node:crypto";

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

export const negotiateCompression = (
  acceptEncodingHeader?: string | string[]
): "br" | "gzip" | "identity" => {
  const raw = Array.isArray(acceptEncodingHeader)
    ? acceptEncodingHeader.join(", ")
    : (acceptEncodingHeader ?? "");
  if (/\bbr\b/.test(raw)) return "br";
  if (/\bgzip\b/.test(raw)) return "gzip";
  return "identity";
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
