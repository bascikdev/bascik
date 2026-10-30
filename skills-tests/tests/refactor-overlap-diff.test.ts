// Unit tests for skills/bascik-refactor/scripts/overlap-diff.mjs: finding the element pairs that overlap in production,
// and requiring the same center-to-center offset and size ratio on the target within 1 px. The browser half (the
// zero-tolerance pixel diff of each overlap rectangle) is in refactor-parity-checks.integration.test.ts.
//
// Why it exists: a timeline had an SVG over one of its circles that was not perfectly aligned. A 2 px offset is far
// below any whole-page pixel budget, so only a check that knows the two elements overlap catches it.
import { describe, expect, it } from "vitest";
import {
  CHECK,
  DEFAULT_TOLERANCE,
  diffOverlaps,
  findOverlaps,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/overlap-diff.mjs";

type Box = {
  key: string;
  path: string;
  rect: { x: number; y: number; width: number; height: number };
  positioned: boolean;
  media: boolean;
};
const box = (
  key: string,
  path: string,
  x: number,
  y: number,
  w: number,
  h: number,
  over: Partial<Box> = {},
): Box => ({
  key,
  path,
  rect: { x, y, width: w, height: h },
  positioned: false,
  media: false,
  ...over,
});

describe("constants", () => {
  it("names the check and defaults to 1 px", () => {
    expect(CHECK).toBe("overlap-diff");
    expect(DEFAULT_TOLERANCE).toBe(1);
  });
});

describe("findOverlaps", () => {
  const dot = box("LI:Design review > SPAN", "0.1.0", 40, 100, 24, 24, {
    positioned: true,
  });
  const icon = box("LI:Design review > SVG", "0.1.1", 46, 106, 12, 12, {
    positioned: true,
    media: true,
  });

  it("pairs intersecting siblings when one is positioned or an svg or img, with center offset and size ratio", () => {
    const pairs = findOverlaps([dot, icon]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      a: dot.key,
      b: icon.key,
      dx: 0,
      dy: 0,
      wRatio: 0.5,
      hRatio: 0.5,
    });
    expect(pairs[0].rect).toEqual({ x: 46, y: 106, width: 12, height: 12 });
  });

  it("ignores flow boxes that touch or overlap without positioning or media", () => {
    const a = box("P:One", "0.0", 0, 0, 100, 20);
    const b = box("P:Two", "0.1", 0, 10, 100, 20);
    expect(findOverlaps([a, b])).toEqual([]);
  });

  it("ignores boxes that only share an edge", () => {
    const a = box("SPAN:A", "0.0", 0, 0, 10, 10, { positioned: true });
    const b = box("SPAN:B", "0.1", 10, 0, 10, 10, { positioned: true });
    expect(findOverlaps([a, b])).toEqual([]);
  });

  it("ignores an element and its own ancestor", () => {
    const li = box("LI:Design review", "0.1", 0, 96, 400, 56, {
      positioned: true,
    });
    expect(findOverlaps([li, { ...icon, path: "0.1.1" }])).toEqual([]);
  });
});

describe("diffOverlaps", () => {
  const pair = (dx: number, dy = 0) => ({
    a: "LI:Design review > SPAN",
    b: "LI:Design review > SVG",
    dx,
    dy,
    wRatio: 0.5,
    hRatio: 0.5,
    rect: { x: 46, y: 106, width: 12, height: 12 },
  });

  it("the same offset produces no findings, and 1 px is within tolerance", () => {
    expect(diffOverlaps([pair(0)], [pair(0)])).toEqual([]);
    expect(diffOverlaps([pair(0)], [pair(1)])).toEqual([]);
  });

  it("an icon moved past 1 px is an offset finding naming both elements and the delta", () => {
    const findings = diffOverlaps([pair(0)], [pair(2)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: CHECK, kind: "offset" });
    expect(findings[0].message).toContain("Design review");
    expect(findings[0].message).toMatch(/2(\.0)? ?px/);
  });

  it("a size ratio change is a size finding", () => {
    const findings = diffOverlaps([pair(0)], [{ ...pair(0), wRatio: 0.75 }]);
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual(["size"]);
  });

  it("an overlap production has and the target lost is a missing-overlap finding", () => {
    const findings = diffOverlaps([pair(0)], []);
    expect(findings).toEqual([
      expect.objectContaining({ kind: "missing-overlap" }),
    ]);
  });
});

describe("parseCliArgs", () => {
  it("defaults --tolerance to 1 and rejects a negative one", () => {
    const base = [
      "--prod",
      "https://example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/",
    ];
    expect(parseCliArgs(base).tolerance).toBe(1);
    expect(() => parseCliArgs([...base, "--tolerance", "-2"])).toThrow(
      /--tolerance/,
    );
  });
});
