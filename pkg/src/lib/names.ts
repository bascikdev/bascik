import { createHash, randomBytes } from "node:crypto";
import { BascikConfig } from "./config.js";

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

export const getAttributeNameHash = (attributeName: string): string => {
  const digest = createHash("sha256").update(attributeName).digest();
  const num = typeof digest === "string" ? Buffer.from(digest).readBigUInt64BE(0) : digest.readBigUInt64BE(0);
  // Must start with a letter, so `b` for Bascik + 11 Base62 chars = 12 chars
  return `b${toBase62(num, 11)}`;
};

export const minifyAttributeName = (attributeName: string): string => {
  return BascikConfig.minify.identifiers
    ? getAttributeNameHash(attributeName)
    : attributeName;
};

export const obfuscateAttributeName = minifyAttributeName;

export const getUniqueId = (length: number): string => {
  if (length % 2 !== 0) {
    length++;
  }
  return randomBytes(length / 2).toString("hex");
};

export const makeEtag = (buf: Buffer): string =>
  `"${createHash("sha256").update(buf).digest("base64url").slice(0, 27)}"`;
