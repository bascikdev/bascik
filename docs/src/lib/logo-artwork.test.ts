import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderOgSvg } from "../../scripts/generate-og-images.ts";

/**
 * The BASCIK wordmark is not text: bascik-logo.svg holds the six Courier New
 * Bold glyphs as one hand-copied outline path, and generate-og-images.ts keeps
 * a fallback copy of it. A mistyped coordinate there gave the I a pointed
 * top-right serif corner and the K a notch where its upper serif meets the
 * arm. These checks read the outline geometry, so a corner that loses its
 * radius fails here instead of in a zoomed-in screenshot.
 */

const docsDir = resolve(import.meta.dirname, "../..");
const GLYPHS = "BASCIK";

/**
 * The transform the outline was exported at, fitted by least squares to the
 * B, A, S and C contours (every point reproduces to within 0.01 units after
 * the path's two-decimal rounding): font size 18.339 on a 19.4313 baseline,
 * the B's origin at x 23.6576, and 12.4717 units from one glyph to the next.
 */
const FONT_SIZE = 18.339;
const BASELINE_Y = 19.4313;
const FIRST_GLYPH_X = 23.6576;
const GLYPH_STEP = 12.4717;
/** Fit error plus half of the path's 0.01 rounding step. */
const FONT_TOLERANCE = 0.011;

interface Point {
  x: number;
  y: number;
}

interface Segment {
  type: "L" | "Q";
  from: Point;
  control?: Point;
  to: Point;
}

type Contour = Segment[];

interface OpenTypeFont {
  unitsPerEm: number;
  charToGlyph(char: string): {
    getPath(
      x: number,
      y: number,
      fontSize: number,
    ): { toPathData(decimals: number): string };
  };
}

/** Reads the fill-rule="nonzero" letter path out of a logo SVG. */
function logoPathData(svg: string, source: string): string {
  const match = /<path\b[^>]*\bfill-rule="nonzero"[^>]*\bd="([^"]+)"/.exec(svg);
  if (!match) {
    throw new Error(`${source}: no <path fill-rule="nonzero" d="..."> found`);
  }
  return match[1];
}

/**
 * Parses absolute M, L, Q and Z commands, the only ones the exported outline
 * uses. Drops zero-length L segments (the exporter repeats each curve's end
 * point as an L) and a final L back to the contour's start, which Z already
 * draws (opentype.js leaves the Z out).
 */
function parsePathData(d: string): Contour[] {
  const contours: Contour[] = [];
  let contour: Contour | undefined;
  let start: Point = { x: 0, y: 0 };
  let pen: Point = { x: 0, y: 0 };
  const closeContour = () => {
    const last = contour?.at(-1);
    if (last?.type === "L" && samePoint(last.to, start)) contour?.pop();
  };
  const commandPattern = /([A-Za-z])([^A-Za-z]*)/g;
  for (const match of d.matchAll(commandPattern)) {
    const [, command, args] = match;
    const offset = match.index;
    const numbers = (args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(
      Number,
    );
    const point = (i: number): Point => ({
      x: numbers[i],
      y: numbers[i + 1],
    });
    const expectArgs = (count: number) => {
      if (numbers.length !== count) {
        throw new Error(
          `logo path: "${command}" at offset ${offset} takes ${count} numbers, got ${numbers.length}`,
        );
      }
    };
    if (command === "M") {
      expectArgs(2);
      closeContour();
      start = pen = point(0);
      contour = [];
      contours.push(contour);
    } else if (command === "Z") {
      expectArgs(0);
      closeContour();
      pen = start;
    } else if (command === "L" || command === "Q") {
      if (!contour) {
        throw new Error(
          `logo path: "${command}" at offset ${offset} comes before any M`,
        );
      }
      if (command === "L") {
        expectArgs(2);
        const to = point(0);
        if (!samePoint(to, pen)) contour.push({ type: "L", from: pen, to });
        pen = to;
      } else {
        expectArgs(4);
        const to = point(2);
        contour.push({ type: "Q", from: pen, control: point(0), to });
        pen = to;
      }
    } else {
      throw new Error(
        `logo path: unsupported command "${command}" at offset ${offset} (only absolute M, L, Q and Z)`,
      );
    }
  }
  closeContour();
  return contours;
}

/** Equal within a thousandth of a unit, below the path's 0.01 precision. */
function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
}

function bounds(contour: Contour) {
  const points = contour.flatMap((s) =>
    s.control ? [s.from, s.control, s.to] : [s.from, s.to],
  );
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * Groups contours into glyphs: a contour whose box lies inside another's is a
 * counter (the holes in B and A) and belongs to that glyph. Glyphs come back
 * in reading order.
 */
function glyphContours(contours: Contour[]): Contour[][] {
  const boxes = contours.map(bounds);
  const inside = (i: number, j: number) =>
    i !== j &&
    boxes[i].minX >= boxes[j].minX &&
    boxes[i].maxX <= boxes[j].maxX &&
    boxes[i].minY >= boxes[j].minY &&
    boxes[i].maxY <= boxes[j].maxY;
  const outer = contours
    .map((_, i) => i)
    .filter((i) => !contours.some((_, j) => inside(i, j)))
    .sort((a, b) => boxes[a].minX - boxes[b].minX);
  return outer.map((o) => [
    contours[o],
    ...contours.filter((_, i) => inside(i, o)),
  ]);
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
/** Sine of the turn from a to b: which way the outline bends, and how far. */
const turnSine = (a: Point, b: Point) =>
  cross(a, b) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
const angleBetween = (a: Point, b: Point) =>
  (Math.abs(Math.atan2(cross(a, b), a.x * b.x + a.y * b.y)) * 180) / Math.PI;
const label = (p: Point) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

/**
 * Runs of consecutive curve segments. A serif end is one run: its two rounded
 * corners meet at the serif's outermost point.
 */
function curveRuns(contour: Contour): Segment[][] {
  const runs: Segment[][] = [];
  let run: Segment[] = [];
  for (const segment of contour) {
    if (segment.type === "Q") run.push(segment);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Curve segments whose control point lies on the chord: a straight line. */
function degenerateCurves(contour: Contour): string[] {
  return contour
    .filter(
      (s) =>
        s.type === "Q" &&
        Math.abs(cross(sub(s.control!, s.from), sub(s.to, s.control!))) < 1e-4,
    )
    .map((s) => `curve ${label(s.from)} -> ${label(s.to)} is a straight line`);
}

/**
 * Where one curve meets the next, the outline must keep its direction: a
 * rounded corner drawn as two quadratic curves is smooth at the point they
 * share. A kink there is a visible point or notch.
 */
function curveKinks(contour: Contour, maxDegrees = 12): string[] {
  const kinks: string[] = [];
  for (const run of curveRuns(contour)) {
    for (let i = 1; i < run.length; i++) {
      const incoming = sub(run[i - 1].to, run[i - 1].control!);
      const outgoing = sub(run[i].control!, run[i].from);
      const degrees = angleBetween(incoming, outgoing);
      if (degrees > maxDegrees) {
        kinks.push(`${label(run[i].from)} turns ${degrees.toFixed(0)} deg`);
      }
    }
  }
  return kinks;
}

/**
 * Inside a rounded corner the outline bends one way only. A curve that bends
 * the other way partway round the corner cuts into the letter. Turns under
 * about 8 degrees are rounding noise between collinear handles and are
 * ignored.
 */
function cornerInflections(contour: Contour): string[] {
  const found: string[] = [];
  for (const run of curveRuns(contour)) {
    const turns: Point[] = [];
    for (const s of run)
      turns.push(sub(s.control!, s.from), sub(s.to, s.control!));
    const signs = turns
      .slice(1)
      .map((t, i) => turnSine(turns[i], t))
      .filter((sine) => Math.abs(sine) > 0.15)
      .map(Math.sign);
    if (signs.some((sign) => sign !== signs[0])) {
      found.push(
        `corner ${label(run[0].from)} -> ${label(run.at(-1)!.to)} bends inward`,
      );
    }
  }
  return found;
}

/**
 * A rounded serif corner as offsets from the square corner it rounds,
 * starting at the end that lies on a horizontal edge, so mirrored corners
 * compare equal.
 */
function cornerShape(run: Segment[]): { corner: Point; offsets: Point[] } {
  const points = [run[0].from, ...run.flatMap((s) => [s.control!, s.to])];
  const startsHorizontal =
    Math.abs(run[0].control!.y - run[0].from.y) <
    Math.abs(run[0].control!.x - run[0].from.x);
  const ordered = startsHorizontal ? points : [...points].reverse();
  const horizontalEnd = ordered[0];
  const verticalEnd = ordered.at(-1)!;
  const corner = { x: verticalEnd.x, y: horizontalEnd.y };
  return {
    corner,
    offsets: ordered.map((p) => ({
      x: Math.abs(p.x - corner.x),
      y: Math.abs(p.y - corner.y),
    })),
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Compares every rounded serif corner of a contour (each pair of curves in a
 * run) with the median corner and lists the ones that differ.
 */
function mismatchedSerifCorners(contour: Contour, tolerance = 0.03): string[] {
  const corners = curveRuns(contour).flatMap((run) =>
    run.flatMap((_, i) => (i % 2 === 0 ? [run.slice(i, i + 2)] : [])),
  );
  const shapes = corners.map(cornerShape);
  const reference = shapes[0].offsets.map((_, i) => ({
    x: median(shapes.map((s) => s.offsets[i].x)),
    y: median(shapes.map((s) => s.offsets[i].y)),
  }));
  return shapes
    .filter((shape) =>
      shape.offsets.some(
        (p, i) =>
          Math.abs(p.x - reference[i].x) > tolerance ||
          Math.abs(p.y - reference[i].y) > tolerance,
      ),
    )
    .map((shape) => `serif corner at ${label(shape.corner)}`);
}

let font: OpenTypeFont;
const sources: Record<string, string> = {};

beforeAll(async () => {
  const opentype = createRequire(import.meta.url)("opentype.js") as {
    parse(buffer: ArrayBuffer): OpenTypeFont;
  };
  const fontFile = await readFile(join(docsDir, "fonts/CourierNew-700.ttf"));
  font = opentype.parse(
    fontFile.buffer.slice(
      fontFile.byteOffset,
      fontFile.byteOffset + fontFile.byteLength,
    ) as ArrayBuffer,
  );
  const asset = await readFile(
    join(docsDir, "src/pages/assets/bascik-logo.svg"),
    "utf8",
  );
  sources["bascik-logo.svg"] = logoPathData(asset, "bascik-logo.svg");
  sources["generate-og-images.ts fallback"] = logoPathData(
    renderOgSvg("Title", "Section", "Description"),
    "generate-og-images.ts fallback",
  );
});

describe("logo path parser", () => {
  it("names the command and offset of anything it cannot read", () => {
    expect(() => parsePathData("M0 0h5Z")).toThrow(
      'unsupported command "h" at offset 4',
    );
    expect(() => parsePathData("M0 0C1 1 2 2 3 3Z")).toThrow(
      'unsupported command "C" at offset 4',
    );
    expect(() => parsePathData("M0 0Q1 1Z")).toThrow(
      '"Q" at offset 4 takes 4 numbers, got 2',
    );
    expect(() => parsePathData("L1 1Z")).toThrow(
      '"L" at offset 0 comes before any M',
    );
  });

  it("reports a logo whose letters are no longer a nonzero-filled path", () => {
    expect(() =>
      logoPathData(
        '<svg><text x="25" y="20">BASCIK</text></svg>',
        "bascik-logo.svg",
      ),
    ).toThrow('bascik-logo.svg: no <path fill-rule="nonzero" d="..."> found');
  });

  it("flags a pointed corner, a notch and a straightened curve", () => {
    // One rounded corner drawn right, then the I's old top-right corner
    // (curve mid point pushed onto the vertical edge) and the K's old
    // upper-serif corner (control point pulled into the letter).
    const [round] = parsePathData(
      "M76.28 8.57L81.82 8.57Q82.48 8.57 82.76 8.82Q83.05 9.08 83.05 9.49Z",
    );
    expect(curveKinks(round)).toEqual([]);
    expect(cornerInflections(round)).toEqual([]);
    expect(degenerateCurves(round)).toEqual([]);

    const [pointed] = parsePathData(
      "M76.28 8.57L81.82 8.58Q82.48 8.58 83.05 8.83Q83.05 9.08 83.05 9.49Z",
    );
    expect(curveKinks(pointed)).toEqual(["(83.05, 8.83) turns 66 deg"]);
    expect(degenerateCurves(pointed)).toEqual([
      "curve (83.05, 8.83) -> (83.05, 9.49) is a straight line",
    ]);

    const [notched] = parsePathData(
      "M92.36 9.51Q92.65 9.09 92.65 8.83Q92.93 8.57 93.59 8.57L95.46 8.58Z",
    );
    expect(cornerInflections(notched)).toEqual([
      "corner (92.36, 9.51) -> (93.59, 8.57) bends inward",
    ]);
  });
});

describe.each(["bascik-logo.svg", "generate-og-images.ts fallback"])(
  "BASCIK wordmark outline in %s",
  (source) => {
    let glyphs: Contour[][];

    beforeAll(() => {
      glyphs = glyphContours(parsePathData(sources[source]));
    });

    it("holds the six letters B A S C I K in order", () => {
      expect(glyphs).toHaveLength(GLYPHS.length);
      expect(glyphs.map((g) => g.length)).toEqual([3, 2, 1, 1, 1, 1]);
    });

    it("gives all eight serif corners of the I the same radius", () => {
      const [i] = glyphs[GLYPHS.indexOf("I")];
      // Four serif ends, each two rounded corners drawn as two curves apiece.
      expect(curveRuns(i).map((run) => run.length)).toEqual(Array(4).fill(4));
      expect(mismatchedSerifCorners(i)).toEqual([]);
    });

    it("draws every curve as a curve", () => {
      const problems = glyphs.flatMap((contours, g) =>
        contours.flatMap((contour) =>
          degenerateCurves(contour).map(
            (problem) => `${GLYPHS[g]}: ${problem}`,
          ),
        ),
      );
      expect(problems).toEqual([]);
    });

    it("keeps every rounded corner of the I and the K smooth", () => {
      // Only these two: the B's waist and the S's top terminal are real
      // corners in the font where one curve meets another.
      const problems = ["I", "K"].flatMap((letter) =>
        glyphs[GLYPHS.indexOf(letter)].flatMap((contour) =>
          curveKinks(contour).map((problem) => `${letter}: ${problem}`),
        ),
      );
      expect(problems).toEqual([]);
    });

    it("has no notch cut into a rounded corner of the I or the K", () => {
      const problems = ["I", "K"].flatMap((letter) =>
        glyphs[GLYPHS.indexOf(letter)].flatMap((contour) =>
          cornerInflections(contour).map((problem) => `${letter}: ${problem}`),
        ),
      );
      expect(problems).toEqual([]);
    });

    it("matches Courier New Bold point for point at the export transform", () => {
      const offPoints: string[] = [];
      [...GLYPHS].forEach((letter, g) => {
        const expected = glyphContours(
          parsePathData(
            font
              .charToGlyph(letter)
              .getPath(FIRST_GLYPH_X + g * GLYPH_STEP, BASELINE_Y, FONT_SIZE)
              .toPathData(6),
          ),
        )[0];
        const actual = glyphs[g];
        expect(actual.map((c) => c.map((s) => s.type).join(""))).toEqual(
          expected.map((c) => c.map((s) => s.type).join("")),
        );
        expected.forEach((contour, c) =>
          contour.forEach((segment, s) => {
            const have = actual[c][s];
            const pairs: [Point, Point][] = [
              [segment.to, have.to],
              ...(segment.control && have.control
                ? [[segment.control, have.control] as [Point, Point]]
                : []),
            ];
            for (const [want, got] of pairs) {
              if (
                Math.abs(want.x - got.x) > FONT_TOLERANCE ||
                Math.abs(want.y - got.y) > FONT_TOLERANCE
              ) {
                offPoints.push(
                  `${letter}: ${label(got)}, font has ${label(want)}`,
                );
              }
            }
          }),
        );
      });
      expect(offPoints).toEqual([]);
    });
  },
);
