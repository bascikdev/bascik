// Unit tests for skills/bascik-refactor/scripts/lib/matrix.mjs and the breakpoint-matrix.mjs CLI: finding the
// widths where the legacy site's layout switches, and expanding them into the B - 1, B, B + 1 matrix with one width
// inside every interval and the narrowest and widest widths. Fixtures are strings and temp files; no network.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverThresholds,
  expandMatrix,
} from "../../skills/bascik-refactor/scripts/lib/matrix.mjs";
import {
  buildMatrix,
  expandInputs,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/breakpoint-matrix.mjs";
import { mkdirSync } from "node:fs";
import { relative } from "node:path";

const SCSS = `
$gutter: 24px;
$bp-md: 992px;
$screen-lg: 1200px;

.hero { width: 1100px; padding: 0 24px; }

@media (min-width: 768px) {
  .pricing-slider { display: grid; }
}
@media screen and (max-width: 767px) {
  .review-carousel { overflow: hidden; }
}
@media (min-width: 48em) and (max-width: 1439.98px) {
  .press { padding-inline: 16px; }
}
@media (width >= 600px) {
  .contact-form { columns: 2; }
}
`;

const JS = `
const wide = window.matchMedia("(min-width: 1280px)").matches;
if (window.innerWidth < 640) openDrawer();
if (innerWidth >= 1024) prefetch();
`;

describe("discoverThresholds", () => {
  it("finds min-width, max-width, range syntax and em media queries", () => {
    expect(discoverThresholds(SCSS)).toEqual(
      expect.arrayContaining([600, 767, 768, 1439]),
    );
  });

  it("finds Sass breakpoint variables but not other px variables or declarations", () => {
    const found = discoverThresholds(SCSS);
    expect(found).toEqual(expect.arrayContaining([992, 1200]));
    expect(found).not.toContain(24);
    expect(found).not.toContain(1100);
    expect(found).not.toContain(16);
  });

  it("finds matchMedia and innerWidth checks in scripts", () => {
    expect(discoverThresholds(JS)).toEqual([640, 1024, 1280]);
  });

  it("returns sorted unique numbers", () => {
    const found: number[] = discoverThresholds(SCSS + JS + SCSS);
    expect(found).toEqual([...new Set(found)].sort((a, b) => a - b));
    expect(found).toEqual([600, 640, 767, 768, 992, 1024, 1200, 1280, 1439]);
  });

  it("finds media queries in any quoted string: sizes attributes, useMediaQuery queries, styled-components", () => {
    expect(
      discoverThresholds(
        '<img src="hero.webp" sizes="(max-width: 600px) 100vw, 50vw" alt="">',
      ),
    ).toEqual([600]);
    expect(
      discoverThresholds('useMediaQuery({ query: "(max-width: 767px)" })'),
    ).toEqual([767]);
    expect(
      discoverThresholds(
        "const Box = styled.div`@media (min-width: 900px) { gap: 8px; }`",
      ),
    ).toEqual([900]);
  });

  it("finds react-responsive object queries and <MediaQuery> props", () => {
    expect(discoverThresholds("useMediaQuery({ maxWidth: 767 })")).toEqual([
      767,
    ]);
    expect(
      discoverThresholds("<MediaQuery minWidth={1024}><Nav /></MediaQuery>"),
    ).toEqual([1024]);
  });

  it("finds Less breakpoint variables and theme breakpoint tokens", () => {
    expect(
      discoverThresholds("@screen-md: 768px;\n@screen-lg: 992px;\n@gap: 16px;"),
    ).toEqual([768, 992]);
    expect(
      discoverThresholds(
        "const theme = { token: { screenMD: 768, screenLGMin: 992, fontSize: 14 } };",
      ),
    ).toEqual([768, 992]);
    expect(discoverThresholds("export const tabletBreakpoint = 840;")).toEqual([
      840,
    ]);
  });

  it("ignores CSS min-width declarations that are not media queries", () => {
    expect(discoverThresholds(".btn { min-width: 120px; }")).toEqual([]);
  });

  it("returns an empty list for text without breakpoints", () => {
    expect(discoverThresholds(".a { color: red; }")).toEqual([]);
  });
});

describe("expandMatrix", () => {
  const widths = (cases: { width: number }[]) => cases.map((c) => c.width);

  it("adds B - 1, B, B + 1, one width inside every interval, and the extremes, sorted", () => {
    const cases = expandMatrix([768, 1024], { min: 320, max: 1920 });
    expect(widths(cases)).toEqual([
      320, 544, 767, 768, 769, 896, 1023, 1024, 1025, 1472, 1920,
    ]);
  });

  it("dedupes overlapping neighbors and clips to min and max", () => {
    const cases = expandMatrix([767, 768, 1920, 2400], {
      min: 320,
      max: 1920,
    });
    const w = widths(cases);
    expect(w).toEqual([...new Set(w)].sort((a, b) => a - b));
    expect(Math.min(...w)).toBe(320);
    expect(Math.max(...w)).toBe(1920);
    expect(w).toEqual(expect.arrayContaining([766, 767, 768, 769, 1919]));
    expect(w).not.toContain(2400);
  });

  it("pairs every width with a height", () => {
    const cases = expandMatrix([768], {
      min: 320,
      max: 1440,
      heightFor: (w: number) => (w < 768 ? 812 : 900),
    });
    for (const c of cases) {
      expect(c.height, String(c.width)).toBe(c.width < 768 ? 812 : 900);
    }
    for (const c of expandMatrix([768], { min: 320, max: 1440 })) {
      expect(Number.isInteger(c.height) && c.height > 0, String(c.width)).toBe(
        true,
      );
    }
  });

  it("a fixed height applies to every case", () => {
    for (const c of expandMatrix([768], { min: 320, max: 1440, height: 1000 }))
      expect(c.height).toBe(1000);
  });

  it("no thresholds still gives the extremes and a middle", () => {
    expect(widths(expandMatrix([], { min: 320, max: 1920 }))).toEqual([
      320, 1120, 1920,
    ]);
  });

  it("misuse: min greater than max is rejected with both values", () => {
    expect(() => expandMatrix([768], { min: 1920, max: 320 })).toThrow(
      /1920.*320|min.*max/,
    );
  });

  it("misuse: a non-positive or non-numeric bound is rejected", () => {
    expect(() => expandMatrix([768], { min: 0, max: 1920 })).toThrow(/min/);
    expect(() => expandMatrix([768], { min: 320, max: Number.NaN })).toThrow(
      /max/,
    );
  });
});

describe("breakpoint-matrix CLI", () => {
  it("parses --css (repeatable and positional), --min, --max, --height", () => {
    const args = parseCliArgs([
      "--css",
      "legacy/a.scss",
      "legacy/b.css",
      "--min",
      "320",
      "--max",
      "1920",
      "--height",
      "900",
    ]);
    expect(args).toMatchObject({
      css: ["legacy/a.scss", "legacy/b.css"],
      min: 320,
      max: 1920,
      height: 900,
    });
  });

  it("parses --add: extra thresholds such as a component library's documented breakpoints", () => {
    expect(
      parseCliArgs(["--css", "a.css", "--add", "576,768, 992"]),
    ).toMatchObject({ add: [576, 768, 992] });
    expect(() => parseCliArgs(["--css", "a.css", "--add", "576,wide"])).toThrow(
      /--add/,
    );
  });

  it("--add thresholds join the matrix and are sourced as added by hand", () => {
    const dir = mkdtempSync(join(tmpdir(), "breakpoint-matrix-"));
    try {
      const css = join(dir, "site.css");
      writeFileSync(css, "@media (min-width: 768px) { .a { color: red; } }");
      const matrix = buildMatrix([css], {
        min: 320,
        max: 1920,
        add: [576, 768],
      });
      expect(matrix.thresholds).toEqual([576, 768]);
      expect(matrix.sources[576]).toEqual(["--add"]);
      expect(matrix.sources[768]).toEqual([css, "--add"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands globs that climb out of the working directory (../legacy/...), skipping node_modules and dot folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "breakpoint-matrix-glob-"));
    try {
      mkdirSync(join(dir, "legacy/src/a"), { recursive: true });
      mkdirSync(join(dir, "legacy/src/node_modules/lib"), { recursive: true });
      mkdirSync(join(dir, "legacy/src/.cache"), { recursive: true });
      for (const f of [
        "legacy/src/x.scss",
        "legacy/src/a/y.scss",
        "legacy/src/node_modules/lib/n.scss",
        "legacy/src/.cache/c.scss",
      ])
        writeFileSync(join(dir, f), "");
      const rel = relative(process.cwd(), join(dir, "legacy/src"));
      expect(rel.startsWith("..")).toBe(true);
      const files = expandInputs([`${rel}/**/*.scss`]);
      expect(files.map((f: string) => f.slice(rel.length + 1)).sort()).toEqual([
        "a/y.scss",
        "x.scss",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misuse: no --css input names the flag", () => {
    expect(() => parseCliArgs(["--min", "320"])).toThrow(/--css/);
  });

  it("misuse: a non-numeric --min names the flag", () => {
    expect(() => parseCliArgs(["--css", "a.css", "--min", "small"])).toThrow(
      /--min/,
    );
  });

  it("builds breakpoints.json from files, recording which file each threshold came from", () => {
    const dir = mkdtempSync(join(tmpdir(), "breakpoint-matrix-"));
    try {
      const css = join(dir, "site.scss");
      const js = join(dir, "drawer.js");
      writeFileSync(css, SCSS);
      writeFileSync(js, JS);
      const matrix = buildMatrix([css, js], { min: 320, max: 1920 });
      expect(matrix.thresholds).toEqual([
        600, 640, 767, 768, 992, 1024, 1200, 1280, 1439,
      ]);
      expect(matrix.sources[768]).toEqual([css]);
      expect(matrix.sources[640]).toEqual([js]);
      expect(matrix.cases[0]).toMatchObject({ width: 320 });
      expect(matrix.cases.at(-1)).toMatchObject({ width: 1920 });
      expect(matrix.cases.length).toBeGreaterThan(20);
      // The same object round-trips through JSON, so a reader can commit it.
      expect(JSON.parse(JSON.stringify(matrix))).toEqual(matrix);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misuse: a missing file is named in the error", () => {
    expect(() =>
      buildMatrix(["/nonexistent/legacy.scss"], { min: 320, max: 1920 }),
    ).toThrow(/\/nonexistent\/legacy\.scss/);
  });
});
