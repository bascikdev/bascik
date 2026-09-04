/**
 * Complexity guard for the JS minifier's lexical scan (prompt 62).
 *
 * The scan must be linear in input bytes. The old implementation rescanned
 * the whole accumulated code prefix on every `/` to decide between regex,
 * division, and comment, which made slash-heavy input quadratic. This test
 * counts characters examined by the scanner (not wall time) at N and 2N and
 * asserts the growth ratio is close to 2, never close to 4.
 *
 * The counter is a test-only hook; it is never read in production paths.
 */
import { describe, expect, it } from "vitest";
import { minifyJs, __scanStatsForTests } from "./js-minifier.ts";

const SLASH_HEAVY_UNIT = "const a = b / c / d; // note\nconst e = f / g; /* block */ x = y / z;\n";
const SLASH_LIGHT_UNIT = "const alpha = beta + gamma;\nlet delta = epsilon(zeta, eta);\n";
// Many short lines with no literals: exercises the ASI line-join assembly
// phase rather than slash disambiguation.
const NEWLINE_HEAVY_UNIT = "a = b\nc()\nif (x) y()\nreturn z\n";

const examined = (source: string): number => {
  __scanStatsForTests.reset();
  minifyJs(source);
  return __scanStatsForTests.charsExamined;
};

describe("minifyJs scan complexity", () => {
  it("examines a linear number of characters for slash-heavy input", () => {
    const n = examined(SLASH_HEAVY_UNIT.repeat(400));
    const twoN = examined(SLASH_HEAVY_UNIT.repeat(800));
    const ratio = twoN / n;
    expect(n).toBeGreaterThan(0);
    // Linear: ~2.0. Quadratic prefix rescans push this toward 4.0.
    expect(ratio).toBeLessThan(2.5);
  });

  it("examines a linear number of characters for slash-light input", () => {
    const n = examined(SLASH_LIGHT_UNIT.repeat(400));
    const twoN = examined(SLASH_LIGHT_UNIT.repeat(800));
    expect(twoN / n).toBeLessThan(2.5);
  });

  it("examines a linear number of characters for newline-heavy input (ASI join phase)", () => {
    const n = examined(NEWLINE_HEAVY_UNIT.repeat(400));
    const twoN = examined(NEWLINE_HEAVY_UNIT.repeat(800));
    expect(twoN / n).toBeLessThan(2.5);
  });

  it("examines each input character a bounded number of times", () => {
    const source = SLASH_HEAVY_UNIT.repeat(500);
    const count = examined(source);
    // Every character may be looked at a small constant number of times
    // (main loop, lookahead, regex body probe). Anything approaching
    // length^2 / 2 means a prefix rescan is back.
    expect(count).toBeLessThan(source.length * 8);
  });
});
