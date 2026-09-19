import { describe, expect, it, vi } from "vitest";
import {
  minifyAttributeName,
  getAttributeNameHash,
  clearHashCache,
  deriveInstanceId,
  getUniqueId,
  makeEtag,
  toBase62,
} from "./names.ts";
import { BascikConfig } from "./config.ts";

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
  });

  it("returns the hash when minify.identifiers is true", () => {
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers = true;
    const minified = minifyAttributeName("my-class");
    expect(minified).toMatch(/^b[0-9a-zA-Z]{11}$/);
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers = false;
  });
});

describe("getUniqueId and genuine randomness audit", () => {
  // Audit of genuine-randomness call sites outside component scoping:
  // - getUniqueId: generic cryptographically secure random hex utility (used for TLS material, nonces, random IDs where randomness is explicitly requested)
  // - makeEtag: content-hash ETag generator based on SHA-256 (remains non-deterministic/dependent strictly on buffer bytes)
  // - Math.random: used for unique temporary filenames in script runners (build-scripts, routes, server-scripts)
  it("returns a lowercase hex string of the requested length", () => {
    const id = getUniqueId(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns exactly the requested odd length", () => {
    const id = getUniqueId(7);
    expect(id).toMatch(/^[0-9a-f]{7}$/);
  });

  it("returns different values on each call (genuine randomness)", () => {
    const id1 = getUniqueId(8);
    const id2 = getUniqueId(8);
    expect(id1).not.toBe(id2);
  });

  it("makeEtag produces strong SHA-256 etag without modification", () => {
    const etag1 = makeEtag(Buffer.from("hello world"));
    const etag2 = makeEtag(Buffer.from("hello world"));
    expect(etag1).toBe(etag2);
    expect(etag1).toMatch(/^"[a-zA-Z0-9_-]{27}"$/);
  });
});

describe("deriveInstanceId", () => {
  it("returns 8 lowercase hex characters", () => {
    const id = deriveInstanceId("src/pages/index.html", "card-item", 1);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("assigns different IDs to two instances of one component on the same page", () => {
    const issued = new Set<string>();
    const id1 = deriveInstanceId("src/pages/index.html", "card-item", 1, issued);
    const id2 = deriveInstanceId("src/pages/index.html", "card-item", 2, issued);
    expect(id1).not.toBe(id2);
  });

  it("assigns different IDs to the same component at the same ordinal on two different pages", () => {
    const id1 = deriveInstanceId("src/pages/index.html", "card-item", 1);
    const id2 = deriveInstanceId("src/pages/about.html", "card-item", 1);
    expect(id1).not.toBe(id2);
  });

  it("resolves forced collisions deterministically without emitting duplicates", () => {
    const issued = new Set<string>();
    // Pre-seed collision
    const naturalId = deriveInstanceId("src/pages/index.html", "card-item", 1);
    issued.add(naturalId);

    const resolvedId = deriveInstanceId("src/pages/index.html", "card-item", 1, issued);
    expect(resolvedId).toMatch(/^[0-9a-f]{8}$/);
    expect(resolvedId).not.toBe(naturalId);

    // Repeat to ensure deterministic resolution
    const issued2 = new Set<string>([naturalId]);
    const resolvedId2 = deriveInstanceId("src/pages/index.html", "card-item", 1, issued2);
    expect(resolvedId2).toBe(resolvedId);
  });
});

describe("packet R6: identifier history measurement and ownership limits", () => {
  it("measures private hashCache instance retention across 100 revisions without production accessor", () => {
    clearHashCache();

    // Capture the actual private Map instance by scoping Map.prototype.set
    let capturedMap: Map<string, string> | undefined;
    const sentinelToken = "__sentinel_r6_capture__";
    const originalSet = Map.prototype.set;
    try {
      Map.prototype.set = function (this: Map<any, any>, key: any, value: any) {
        if (key === sentinelToken) {
          capturedMap = this;
        }
        return originalSet.call(this, key, value);
      };
      getAttributeNameHash(sentinelToken);
    } finally {
      Map.prototype.set = originalSet;
    }

    expect(capturedMap).toBeDefined();
    expect(capturedMap).toBeInstanceOf(Map);

    // Negative control: calibrate missing/retained actual owner with same assertion used in workload.
    // An empty/cleared Map throws when asserted to retain the sentinel.
    clearHashCache();
    const assertRetainsKey = (map: Map<string, string>, key: string) => {
      expect(map.has(key)).toBe(true);
    };
    expect(() => assertRetainsKey(capturedMap!, sentinelToken)).toThrow();

    // 1. When minify.identifiers is false (default), minifyAttributeName returns names unchanged
    // without populating the private hashCache.
    expect(BascikConfig.minify.identifiers).toBe(false);
    expect(capturedMap!.size).toBe(0);
    for (let i = 0; i < 100; i++) {
      const name = `class-token-${i}`;
      const result = minifyAttributeName(name);
      expect(result).toBe(name);
    }
    expect(capturedMap!.size).toBe(0);

    // 2. 100 distinct revisions: verify monotonic growth of the actual Map instance (uncapped, no eviction)
    const originalToken = "revision-0";
    let originalHash = "";
    for (let i = 0; i < 100; i++) {
      const token = `revision-${i}`;
      const hash = getAttributeNameHash(token);
      if (i === 0) originalHash = hash;
      assertRetainsKey(capturedMap!, token);
      expect(capturedMap!.size).toBe(i + 1);
    }
    expect(capturedMap!.size).toBe(100);

    // Verify repeat of original verifies retention (cache hit), not recomputation
    let gets = 0;
    let sets = 0;
    const originalGet = Map.prototype.get;
    try {
      Map.prototype.get = function (this: Map<any, any>, key: any) {
        if (this === capturedMap && key === originalToken) gets++;
        return originalGet.call(this, key);
      };
      Map.prototype.set = function (this: Map<any, any>, key: any, value: any) {
        if (this === capturedMap && key === originalToken) sets++;
        return originalSet.call(this, key, value);
      };
      const repeatedHash = getAttributeNameHash(originalToken);
      expect(repeatedHash).toBe(originalHash);
      expect(gets).toBe(1);
      expect(sets).toBe(0);
    } finally {
      Map.prototype.get = originalGet;
      Map.prototype.set = originalSet;
    }
    expect(capturedMap!.size).toBe(100);

    // 3. Clear drops the historical map completely
    clearHashCache();
    expect(capturedMap!.size).toBe(0);
    expect(() => assertRetainsKey(capturedMap!, originalToken)).toThrow();
  });
});