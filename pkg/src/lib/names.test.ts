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
import { createHash } from "node:crypto";
import { createNameHasher, nameHashFromDigest } from "./name-hash.ts";

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

// The portable half a Worker computes from its own sha256 (prompt 157): one
// algorithm, so a request-time rendered class name is the build's.
describe("nameHashFromDigest", () => {
  it("equals getAttributeNameHash for the same name", () => {
    clearHashCache();
    for (const name of ["tile", "bascik__product-card__tile", "", "ü-ß"]) {
      const digest = new Uint8Array(createHash("sha256").update(name).digest());
      expect(nameHashFromDigest(digest)).toBe(getAttributeNameHash(name));
    }
  });

  it("reads only the first 8 bytes, big-endian: a longer or zero digest still gives a 12-character name starting with b", () => {
    const zeros = new Uint8Array(32);
    expect(nameHashFromDigest(zeros)).toBe(`b${"0".repeat(11)}`);
    const tail = new Uint8Array(32);
    tail[8] = 255;
    expect(nameHashFromDigest(tail)).toBe(nameHashFromDigest(zeros));
    const max = new Uint8Array(8).fill(255);
    expect(nameHashFromDigest(max)).toBe(`b${toBase62(2n ** 64n - 1n, 11)}`);
    expect(nameHashFromDigest(max)).toHaveLength(12);
  });
});

// A request-time host hashes names that embed per-request instance ids, so
// its memo must stay bounded whatever a client sends (prompt 157).
describe("createNameHasher", () => {
  const sha256 = (input: string) =>
    new Uint8Array(createHash("sha256").update(input).digest());

  it("gives the build's names", () => {
    clearHashCache();
    const hash = createNameHasher(sha256);
    for (const name of ["tile", "bascik__product-card__r1234567__tile", ""])
      expect(hash(name)).toBe(getAttributeNameHash(name));
  });

  it("memoizes a repeated name, and forgets everything once it holds `limit` names instead of growing", () => {
    const digest = vi.fn(sha256);
    const hash = createNameHasher(digest, 3);
    hash("a");
    hash("a");
    expect(digest).toHaveBeenCalledTimes(1);
    hash("b");
    hash("c");
    hash("a");
    expect(digest).toHaveBeenCalledTimes(3);
    // A fourth distinct name clears the memo: "a" is computed again.
    hash("d");
    hash("a");
    expect(digest).toHaveBeenCalledTimes(5);
    expect(hash("a")).toBe(getAttributeNameHash("a"));
  });

  it("misuse: a limit below 1 still hashes every name correctly (nothing is kept)", () => {
    const digest = vi.fn(sha256);
    const hash = createNameHasher(digest, 0);
    expect(hash("a")).toBe(getAttributeNameHash("a"));
    expect(hash("a")).toBe(getAttributeNameHash("a"));
    expect(digest).toHaveBeenCalledTimes(2);
  });
});

describe("minifyAttributeName", () => {
  it("returns the name unchanged when minify.identifiers is false", () => {
    expect(minifyAttributeName("my-class")).toBe("my-class");
  });

  it("returns the hash when minify.identifiers is true", () => {
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers =
      true;
    const minified = minifyAttributeName("my-class");
    expect(minified).toMatch(/^b[0-9a-zA-Z]{11}$/);
    (BascikConfig as { minify: { identifiers: boolean } }).minify.identifiers =
      false;
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
    const id1 = deriveInstanceId(
      "src/pages/index.html",
      "card-item",
      1,
      issued,
    );
    const id2 = deriveInstanceId(
      "src/pages/index.html",
      "card-item",
      2,
      issued,
    );
    expect(id1).not.toBe(id2);
  });

  it("assigns different IDs to the same component at the same ordinal on two different pages", () => {
    const id1 = deriveInstanceId("src/pages/index.html", "card-item", 1);
    const id2 = deriveInstanceId("src/pages/about.html", "card-item", 1);
    expect(id1).not.toBe(id2);
  });

  // Request-time instance ids are `r` + 7 hex (prompt 157). They are minted
  // per request without the build's issued-id set, so the two shapes must be
  // disjoint by construction: a build id is always exactly 8 lowercase hex
  // characters, on the natural and on the salted path.
  it("always emits ^[0-9a-f]{8}$, never the request id shape ^r[0-9a-f]{7}$", () => {
    const buildShape = /^[0-9a-f]{8}$/;
    const requestShape = /^r[0-9a-f]{7}$/;
    const issued = new Set<string>();
    const ids: string[] = [];
    for (let n = 0; n < 5000; n++) {
      ids.push(
        deriveInstanceId(
          `src/pages/p${n % 7}.html`,
          `c${n % 13}-box`,
          n + 1,
          issued,
        ),
      );
    }
    // Force the salt loop too: re-request every id a second time.
    for (let n = 0; n < 5000; n++) {
      ids.push(
        deriveInstanceId(
          `src/pages/p${n % 7}.html`,
          `c${n % 13}-box`,
          n + 1,
          issued,
        ),
      );
    }
    expect(ids).toHaveLength(10_000);
    expect(issued.size).toBe(10_000);
    expect(ids.filter((id) => !buildShape.test(id))).toEqual([]);
    expect(ids.filter((id) => requestShape.test(id))).toEqual([]);
  });

  it("resolves forced collisions deterministically without emitting duplicates", () => {
    const issued = new Set<string>();
    // Pre-seed collision
    const naturalId = deriveInstanceId("src/pages/index.html", "card-item", 1);
    issued.add(naturalId);

    const resolvedId = deriveInstanceId(
      "src/pages/index.html",
      "card-item",
      1,
      issued,
    );
    expect(resolvedId).toMatch(/^[0-9a-f]{8}$/);
    expect(resolvedId).not.toBe(naturalId);

    // Repeat to ensure deterministic resolution
    const issued2 = new Set<string>([naturalId]);
    const resolvedId2 = deriveInstanceId(
      "src/pages/index.html",
      "card-item",
      1,
      issued2,
    );
    expect(resolvedId2).toBe(resolvedId);
  });
});
