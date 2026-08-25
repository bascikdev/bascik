import { describe, expect, it, vi } from "vitest";
import {
  minifyAttributeName,
  obfuscateAttributeName,
  getAttributeNameHash,
  clearHashCache,
  getUniqueId,
  toBase62,
} from "./names.js";
import { BascikConfig } from "./config.js";

vi.mock("./config.js", () => {
  return {
    BascikConfig: { minify: { identifiers: false } },
  };
});

describe("toBase62", () => {
  it("converts 0n to padded zero string", () => {
    expect(toBase62(0n, 11)).toBe("00000000000");
  });

  it("converts small numbers correctly", () => {
    expect(toBase62(1n, 4)).toBe("0001");
    expect(toBase62(10n, 4)).toBe("000a");
    expect(toBase62(61n, 4)).toBe("000Z");
    expect(toBase62(62n, 4)).toBe("0010");
  });

  it("converts large 64-bit uint correctly", () => {
    const maxUint64 = 18446744073709551615n;
    const base62 = toBase62(maxUint64, 11);
    expect(base62.length).toBe(11);
    expect(base62).toMatch(/^[0-9a-zA-Z]{11}$/);
  });
});

describe("getAttributeNameHash", () => {
  it("returns a 12-character Base62 string prefixed with 'b'", () => {
    const hash = getAttributeNameHash("my-class");
    expect(hash).toMatch(/^b[0-9a-zA-Z]{11}$/);
    expect(hash.length).toBe(12);
  });

  it("is deterministic for the same input and uses the Map cache", () => {
    clearHashCache();
    const hash1 = getAttributeNameHash("bascik__btn__primary");
    const hash2 = getAttributeNameHash("bascik__btn__primary");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = getAttributeNameHash("bascik__btn__primary");
    const hash2 = getAttributeNameHash("bascik__btn__secondary");
    expect(hash1).not.toBe(hash2);
  });
});

describe("minifyAttributeName", () => {
  it("returns the name unchanged when minify.identifiers is false", () => {
    expect(minifyAttributeName("my-class")).toBe("my-class");
    expect(obfuscateAttributeName("my-class")).toBe("my-class");
  });

  it("returns the hash when minify.identifiers is true", () => {
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers = true;
    const minified = minifyAttributeName("my-class");
    expect(minified).toMatch(/^b[0-9a-zA-Z]{11}$/);
    expect(obfuscateAttributeName("my-class")).toBe(minified);
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers = false;
  });
});

describe("getUniqueId", () => {
  it("returns a lowercase hex string of the requested length", () => {
    const id = getUniqueId(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rounds an odd length up to the nearest even number", () => {
    // length=7 → rounds to 8 → randomBytes(4) → 8 hex chars
    const id = getUniqueId(7);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different values on each call", () => {
    const id1 = getUniqueId(8);
    const id2 = getUniqueId(8);
    expect(id1).not.toBe(id2);
  });
});