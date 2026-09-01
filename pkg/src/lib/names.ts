import { createHash, randomBytes } from "node:crypto";
import { BascikConfig } from "./config.ts";

const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Convert a 64-bit unsigned integer to an N-character Base62 string.
 */
export const toBase62 = (num: bigint, length = 11): string => {
  if (num === 0n) return "0".repeat(length);
  let str = "";
  let current = num;
  while (current > 0n) {
    const remainder = Number(current % 62n);
    str = BASE62_ALPHABET[remainder] + str;
    current = current / 62n;
  }
  return str.padStart(length, "0");
};

const hashCache = new Map<string, string>();

export const clearHashCache = (): void => {
  hashCache.clear();
};

export const getAttributeNameHash = (attributeName: string): string => {
  const cached = hashCache.get(attributeName);
  if (cached !== undefined) return cached;
  const digest = createHash("sha256").update(attributeName).digest();
  const num = typeof digest === "string" ? Buffer.from(digest).readBigUInt64BE(0) : digest.readBigUInt64BE(0);
  // Must start with a letter, so `b` for Bascik + 11 Base62 chars = 12 chars
  const hash = `b${toBase62(num, 11)}`;
  hashCache.set(attributeName, hash);
  return hash;
};

export const minifyAttributeName = (attributeName: string): string => {
  return BascikConfig.minify.identifiers
    ? getAttributeNameHash(attributeName)
    : attributeName;
};

export const getUniqueId = (length: number): string => {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
};

export const makeEtag = (buf: Buffer): string =>
  `"${createHash("sha256").update(buf).digest("base64url").slice(0, 27)}"`;
