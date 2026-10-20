import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  __segmentMemoForTests,
  createMinifyJsMemo,
  minifyJs,
} from "./js-minifier.ts";

const referenceNormalize = (text: string): string => {
  let code = text.replace(/\s+/g, " ");
  code = code.replace(/\s*([{}();,:=?*!^~%])\s*/g, "$1");
  code = code.replace(
    /\s*(<|>|<=|>=|==|===|!=|!==|<<|>>|>>>|\&\&|\|\||\?\?|\+=|-=|\*=|\/=|%=)\s*/g,
    "$1",
  );
  code = code.replace(/([^\s+-])\s*\+/g, "$1+");
  code = code.replace(/\+\s*([^\s+-])/g, "+$1");
  code = code.replace(/([^\s+-])\s*-/g, "$1-");
  code = code.replace(/-\s*([^\s+-])/g, "-$1");
  code = code.replace(/([^\d\s])\s*\.\s*/g, "$1.");
  return code.replace(/([^\d])\s*\.\s*([^\d\s])/g, "$1.$2");
};

const codeToken = fc.constantFrom(
  "value",
  "return",
  "typeof",
  "$1",
  "$&",
  "$$",
  "1",
  "2",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  ":",
  "=",
  "?",
  "*",
  "!",
  "^",
  "~",
  "%",
  "<",
  ">",
  "+",
  "-",
  "&",
  "|",
  ".",
);

describe("minifyJs segment normalization characterization", () => {
  it("matches the unmemoized regex passes for generated code and Unicode whitespace", () => {
    const whitespace = fc.constantFrom(
      " ",
      "\t",
      "\r",
      "\u00a0",
      "\u2028",
      "\u2029",
      "\ufeff",
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(codeToken, whitespace), { maxLength: 100 }),
        (parts) => {
          const source = parts.join("");
          const expected = referenceNormalize(source.trim()).trim();
          expect(minifyJs(source)).toBe(expected);
          expect(minifyJs(source)).toBe(expected);
        },
      ),
      { numRuns: 1500, seed: 761241 },
    );
  });

  it("keeps every normalization pass byte-neutral for whitespace-free code", () => {
    fc.assert(
      fc.property(fc.array(codeToken, { maxLength: 100 }), (parts) => {
        const source = parts.join("");
        expect(referenceNormalize(source)).toBe(source);
        expect(minifyJs(source)).toBe(source);
      }),
      { numRuns: 1000, seed: 762241 },
    );
  });

  it("keeps shared segment text independent of control headers and literal boundaries", () => {
    const cases = [
      [
        'if (value === "x")\n  use();\nelse stop();',
        'if(value==="x")use();else stop();',
      ],
      ['call(value === "x")\n  use();', 'call(value==="x");use();'],
      ['while (value === "x")\n  use();', 'while(value==="x")use();'],
      ["call(value === `x`)\n  use();", "call(value===`x`);use();"],
      ["if (value === /x/.source)\n  use();", "if(value===/x/.source)use();"],
      ['const a = "x"\nnext();', 'const a="x";next();'],
      ['const a = "x";\nnext();', 'const a="x";next();'],
      ['const a = "x"\n + value;', 'const a="x"+value;'],
      [
        'if (value === "x")\r\n  use();\r\nelse stop();',
        'if(value==="x")use();else stop();',
      ],
      [
        'const a = "$1$&$$"\r\nconst b = /a  b/g;',
        'const a="$1$&$$";const b=/a  b/g;',
      ],
      [
        "const a\u00a0=\ufeff1;\u2028a\u00a0.\u2028next();",
        "const a=1;a.next();",
      ],
      [
        "const a = ` x ${value + 1} `; a + +b; a - -b; 1 .toString();",
        "const a=` x ${value + 1} `;a+ +b;a- -b;1 .toString();",
      ],
    ];
    for (const [source, expected] of [...cases, ...cases.toReversed()]) {
      expect(minifyJs(source)).toBe(expected);
    }
  });

  it("preserves cold and warm output for generated ASI and literal contexts", () => {
    const literal = fc.constantFrom(
      '"$1$&"',
      "' x  y '",
      "`a ${1 + 2}`",
      "/a  b/g",
    );
    fc.assert(
      fc.property(
        literal,
        fc.constantFrom("\n", "\r\n", "\n\n"),
        fc.constantFrom("next();", "++value;", ".next();", " + value;"),
        (value, newline, tail) => {
          const source = `const value = ${value}${newline}${tail}`;
          const expected = minifyJs(source);
          minifyJs(`if (other === ${value})${newline}${tail}`);
          minifyJs(`call(other === ${value})${newline}${tail}`);
          expect(minifyJs(source)).toBe(expected);
        },
      ),
      { numRuns: 500, seed: 763241 },
    );
  });

  it("preserves normalization after deterministic entry and byte eviction", () => {
    const memo = createMinifyJsMemo(referenceNormalize, {
      maxEntries: 2,
      maxBytes: 80,
    });
    const sources = [
      "a + b",
      "a - b",
      "a . b",
      "x".repeat(30),
      "\ufeff=\u00a0",
    ];
    for (const source of [...sources, ...sources.toReversed()]) {
      expect(memo.minify(source)).toBe(referenceNormalize(source));
      expect(memo.stats().entries).toBeLessThanOrEqual(2);
      expect(memo.stats().bytes).toBeLessThanOrEqual(80);
    }
  });
});

describe("minifyJs bounded segment memo", () => {
  beforeEach(() => __segmentMemoForTests.reset());
  afterEach(() => __segmentMemoForTests.reset());

  it("matches the frozen unmemoized normalization for arbitrary segment text", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            codeToken,
            fc.string({ maxLength: 20 }),
            fc.constantFrom("\r\n", "\u00a0", "\u2028", "\ufeff", "$`", "$'"),
          ),
          { maxLength: 60 },
        ),
        (parts) => {
          const text = parts.join("");
          const expected = referenceNormalize(text);
          expect(__segmentMemoForTests.normalizeUnmemoized(text)).toBe(
            expected,
          );
          expect(__segmentMemoForTests.normalize(text)).toBe(expected);
          expect(__segmentMemoForTests.normalize(text)).toBe(expected);
        },
      ),
      { numRuns: 1500, seed: 764241 },
    );
  });

  it("hits the normalization memo across distinct scripts with shared segments", () => {
    expect(minifyJs('const value = "first"; value + +next;')).toBe(
      'const value="first";value+ +next;',
    );
    const cold = __segmentMemoForTests.stats();
    expect(cold.normalizationRuns).toBe(2);
    expect(minifyJs('const value = "second"; value + +next;')).toBe(
      'const value="second";value+ +next;',
    );
    expect(__segmentMemoForTests.stats()).toEqual(cold);
  });

  it("uses exact pre-normalization text as the cache key", () => {
    for (const text of ["a + b", "a\u00a0+ b", "a+b"]) {
      expect(__segmentMemoForTests.normalize(text)).toBe("a+b");
    }
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(3);
    expect(__segmentMemoForTests.stats().entries).toBe(3);
    __segmentMemoForTests.normalize("a + b");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(3);
  });

  it("evicts the least recently used segment deterministically by entry count", () => {
    __segmentMemoForTests.reset({ maxEntries: 2, maxBytes: 1024 });
    for (const text of ["a + b", "a - b", "a + b", "a . b"]) {
      expect(__segmentMemoForTests.normalize(text)).toBe(
        referenceNormalize(text),
      );
    }
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(3);
    expect(__segmentMemoForTests.stats().entries).toBe(2);
    __segmentMemoForTests.normalize("a + b");
    __segmentMemoForTests.normalize("a . b");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(3);
    __segmentMemoForTests.normalize("a - b");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(4);
  });

  it("bounds UTF-16 input plus output bytes and bypasses oversized segments", () => {
    __segmentMemoForTests.reset({ maxEntries: 100, maxBytes: 40 });
    expect(__segmentMemoForTests.normalize("😀".repeat(5))).toBe(
      "😀".repeat(5),
    );
    expect(__segmentMemoForTests.stats()).toEqual({
      entries: 1,
      bytes: 40,
      normalizationRuns: 1,
    });
    __segmentMemoForTests.normalize("abc");
    expect(__segmentMemoForTests.stats()).toEqual({
      entries: 1,
      bytes: 12,
      normalizationRuns: 2,
    });
    for (let i = 0; i < 2; i++) {
      expect(__segmentMemoForTests.normalize("x".repeat(11))).toBe(
        "x".repeat(11),
      );
    }
    expect(__segmentMemoForTests.stats()).toEqual({
      entries: 1,
      bytes: 12,
      normalizationRuns: 4,
    });
    __segmentMemoForTests.normalize("abc");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(4);
  });

  it("caches empty normalized output without confusing it with a miss", () => {
    expect(__segmentMemoForTests.normalize("")).toBe("");
    expect(__segmentMemoForTests.normalize("")).toBe("");
    expect(__segmentMemoForTests.stats()).toEqual({
      entries: 1,
      bytes: 0,
      normalizationRuns: 1,
    });
  });

  it("keeps full minification byte-identical while segments are evicted", () => {
    const sources = [
      'if (value === "x")\r\n use();\r\nelse stop();',
      'call(value === "x")\r\n use();',
      "const value = '$1$&'\n++next;",
      "const value = `a ${1 + 2}`\n.next();",
      "const value\ufeff=\u00a01; value + +other; 1 .toString();",
    ];
    const expected = sources.map(minifyJs);
    __segmentMemoForTests.reset({ maxEntries: 2, maxBytes: 80 });
    for (let round = 0; round < 3; round++) {
      sources.forEach((source, i) => {
        expect(minifyJs(source)).toBe(expected[i]);
        expect(__segmentMemoForTests.stats().entries).toBeLessThanOrEqual(2);
        expect(__segmentMemoForTests.stats().bytes).toBeLessThanOrEqual(80);
      });
    }
  });

  it("enforces the production entry limit on minifyJs calls", () => {
    for (let i = 0; i <= 2048; i++) minifyJs(`item${i}`);
    expect(__segmentMemoForTests.stats().entries).toBe(2048);
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(2049);
    minifyJs("item2048");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(2049);
    minifyJs("item0");
    expect(__segmentMemoForTests.stats().normalizationRuns).toBe(2050);
    expect(__segmentMemoForTests.stats().bytes).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
  });
});
