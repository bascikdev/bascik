import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createMinifyJsMemo, minifyJs, memoizedMinifyJs } from "./js-minifier.ts";

describe("createMinifyJsMemo", () => {
  it("minifies each distinct input once and returns the same result on repeats", () => {
    const minify = vi.fn((code: string) => code.trim());
    const memo = createMinifyJsMemo(minify, { maxEntries: 8, maxBytes: 1024 });
    expect(memo.minify("  a  ")).toBe("a");
    expect(memo.minify("  a  ")).toBe("a");
    expect(memo.minify(" b ")).toBe("b");
    expect(minify).toHaveBeenCalledTimes(2);
    expect(memo.stats()).toEqual({ entries: 2, bytes: 2 * ("  a  a".length + " b b".length) });
  });

  it("evicts the least recently used entry when the entry cap is reached", () => {
    const minify = vi.fn((code: string) => code.toUpperCase());
    const memo = createMinifyJsMemo(minify, { maxEntries: 2, maxBytes: 1024 });
    memo.minify("a");
    memo.minify("b");
    memo.minify("a"); // a is now most recent
    memo.minify("c"); // evicts b
    expect(memo.stats().entries).toBe(2);
    minify.mockClear();
    memo.minify("a");
    memo.minify("c");
    expect(minify).not.toHaveBeenCalled();
    memo.minify("b");
    expect(minify).toHaveBeenCalledTimes(1);
  });

  it("evicts by total size and never stores an entry larger than the byte cap", () => {
    const minify = vi.fn((code: string) => code);
    const memo = createMinifyJsMemo(minify, { maxEntries: 100, maxBytes: 40 });
    memo.minify("0123456789"); // 2 * 20 = 40 bytes
    expect(memo.stats()).toEqual({ entries: 1, bytes: 40 });
    memo.minify("abc"); // 12 bytes, evicts the first
    expect(memo.stats()).toEqual({ entries: 1, bytes: 12 });
    memo.minify("x".repeat(30)); // too large to store
    expect(memo.stats()).toEqual({ entries: 1, bytes: 12 });
    memo.minify("x".repeat(30));
    expect(minify).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failure", () => {
    const minify = vi.fn((code: string) => {
      if (minify.mock.calls.length === 1) throw new Error("boom");
      return code;
    });
    const memo = createMinifyJsMemo(minify, { maxEntries: 8, maxBytes: 1024 });
    expect(() => memo.minify("a")).toThrow("boom");
    expect(memo.minify("a")).toBe("a");
    expect(memo.stats().entries).toBe(1);
  });

  it("returns exactly what minifyJs returns", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (code) => {
        expect(memoizedMinifyJs(code)).toBe(minifyJs(code));
        expect(memoizedMinifyJs(code)).toBe(minifyJs(code));
      }),
      { numRuns: 500 },
    );
  });
});
