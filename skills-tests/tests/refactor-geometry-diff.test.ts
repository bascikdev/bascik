// Unit tests for skills/bascik-refactor/scripts/geometry-diff.mjs: the collectNodes snapshot that runs in the browser
// (fed a fake document and window here), the threshold diff, argument parsing and matrix loading. No browser, no
// network: the CLI's Playwright run is covered by the reader's own project.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectNodes,
  diffGeometry,
  loadMatrix,
  parseCliArgs,
  DEFAULT_THRESHOLDS,
} from "../../skills/bascik-refactor/scripts/geometry-diff.mjs";

type Fake = {
  tag: string;
  text: string;
  rect?: { x: number; y: number; width: number; height: number };
  style?: Partial<{ display: string; visibility: string; opacity: string }>;
};

/** A fake document and window: querySelectorAll returns the elements, getComputedStyle their style. */
const fakePage = (els: Fake[]) => {
  const elements = els.map((e) => ({
    tagName: e.tag.toUpperCase(),
    textContent: e.text,
    getBoundingClientRect: () =>
      e.rect ?? { x: 10, y: 20, width: 100, height: 30 },
    __style: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      ...e.style,
    },
  }));
  const selectors: string[] = [];
  const doc = {
    querySelectorAll: (selector: string) => {
      selectors.push(selector);
      return elements;
    },
  };
  const view = {
    getComputedStyle: (el: (typeof elements)[number]) => el.__style,
  };
  return { doc, view, selectors };
};

describe("collectNodes", () => {
  it("collects headings, paragraphs, buttons and links keyed by TAG:text with rounded rects", () => {
    const { doc, view, selectors } = fakePage([
      {
        tag: "h1",
        text: "  Plans  for\n every team ",
        rect: { x: 10.4, y: 20.6, width: 300.5, height: 40.2 },
      },
      { tag: "a", text: "Contact sales" },
    ]);
    const nodes = collectNodes(doc, view);
    expect(selectors[0]).toBe("h1, h2, h3, h4, p, button, a");
    expect(nodes).toEqual({
      "H1:Plans for every team": { x: 10, y: 21, w: 301, h: 40 },
      "A:Contact sales": { x: 10, y: 20, w: 100, h: 30 },
    });
  });

  it("skips hidden, transparent, tiny and empty nodes", () => {
    const { doc, view } = fakePage([
      { tag: "p", text: "display none", style: { display: "none" } },
      { tag: "p", text: "invisible", style: { visibility: "hidden" } },
      { tag: "p", text: "transparent", style: { opacity: "0" } },
      {
        tag: "p",
        text: "too narrow",
        rect: { x: 0, y: 0, width: 4, height: 20 },
      },
      {
        tag: "p",
        text: "too short",
        rect: { x: 0, y: 0, width: 20, height: 4 },
      },
      { tag: "button", text: "   \n " },
      {
        tag: "p",
        text: "exactly five",
        rect: { x: 0, y: 0, width: 5, height: 5 },
      },
    ]);
    expect(Object.keys(collectNodes(doc, view))).toEqual(["P:exactly five"]);
  });

  it("first occurrence wins and keys are cut at 70 characters", () => {
    const long = "x".repeat(100);
    const { doc, view } = fakePage([
      {
        tag: "a",
        text: "Read more",
        rect: { x: 1, y: 1, width: 50, height: 10 },
      },
      {
        tag: "a",
        text: "Read more",
        rect: { x: 9, y: 9, width: 50, height: 10 },
      },
      { tag: "p", text: long },
    ]);
    const nodes = collectNodes(doc, view);
    expect(nodes["A:Read more"]).toEqual({ x: 1, y: 1, w: 50, h: 10 });
    expect(Object.keys(nodes)).toContain(`P:${"x".repeat(70)}`);
  });

  it("is self-contained so page.evaluate can serialize it", () => {
    // Playwright sends the function source to the browser: it must not close over module scope.
    const source = collectNodes.toString();
    const fn = new Function(`return (${source})`)();
    const { doc, view } = fakePage([{ tag: "h2", text: "Pricing" }]);
    expect(Object.keys(fn(doc, view))).toEqual(["H2:Pricing"]);
  });
});

describe("diffGeometry", () => {
  const base = { x: 100, y: 200, w: 300, h: 40 };

  it("uses |dx| > 6, |dy| > 12, |dw| > 12 by default", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ dx: 6, dy: 12, dw: 12 });
  });

  it("does not flag deltas at exactly the thresholds", () => {
    const report = diffGeometry(
      { "H1:Hero": base },
      { "H1:Hero": { x: 106, y: 212, w: 312, h: 40 } },
    );
    expect(report.moved).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("flags each axis one pixel past its threshold, with the deltas", () => {
    const report = diffGeometry(
      { "H1:Hero": base, "P:Lead": base, "A:Buy": base },
      {
        "H1:Hero": { ...base, x: 107 },
        "P:Lead": { ...base, y: 187 },
        "A:Buy": { ...base, w: 313 },
      },
    );
    expect(report.ok).toBe(false);
    expect(
      report.moved.map(
        (m: { key: string; dx: number; dy: number; dw: number }) => [
          m.key,
          m.dx,
          m.dy,
          m.dw,
        ],
      ),
    ).toEqual([
      ["H1:Hero", 7, 0, 0],
      ["P:Lead", 0, -13, 0],
      ["A:Buy", 0, 0, 13],
    ]);
  });

  it("reports nodes missing from the target and extra in the target", () => {
    const report = diffGeometry(
      { "H2:Press": base, "P:Only in production": base },
      { "H2:Press": base, "P:Only in target": base },
    );
    expect(report.missing).toEqual(["P:Only in production"]);
    expect(report.extra).toEqual(["P:Only in target"]);
    expect(report.ok).toBe(false);
  });

  it("accepts custom thresholds", () => {
    const report = diffGeometry(
      { "H1:Hero": base },
      { "H1:Hero": { ...base, x: 103 } },
      { dx: 2, dy: 12, dw: 12 },
    );
    expect(report.moved).toHaveLength(1);
  });
});

describe("parseCliArgs and loadMatrix", () => {
  it("parses the documented flags", () => {
    const args = parseCliArgs([
      "--prod",
      "https://www.example.com",
      "--target",
      "http://localhost:8080",
      "--route",
      "/pricing",
      "--matrix",
      "docs/migration/breakpoints.json",
      "--thresholds",
      "4,10,10",
      "--out",
      "artifacts/geometry",
      "--json",
    ]);
    expect(args).toMatchObject({
      prod: "https://www.example.com",
      target: "http://localhost:8080",
      route: ["/pricing"],
      matrix: "docs/migration/breakpoints.json",
      thresholds: { dx: 4, dy: 10, dw: 10 },
      out: "artifacts/geometry",
      json: true,
    });
  });

  it("misuse: a missing --prod or --target names the flag", () => {
    expect(() => parseCliArgs(["--target", "http://localhost:8080"])).toThrow(
      /--prod/,
    );
    expect(() => parseCliArgs(["--prod", "https://www.example.com"])).toThrow(
      /--target/,
    );
  });

  it("misuse: malformed --thresholds is rejected", () => {
    expect(() =>
      parseCliArgs(["--prod", "a", "--target", "b", "--thresholds", "6,x"]),
    ).toThrow(/--thresholds/);
  });

  const withMatrix = (content: string, fn: (file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "geometry-matrix-"));
    try {
      const file = join(dir, "breakpoints.json");
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("loads a breakpoints.json matrix", () => {
    withMatrix(
      JSON.stringify({
        cases: [
          { width: 375, height: 812 },
          { width: 1440, height: 900 },
        ],
      }),
      (file) => {
        expect(loadMatrix(file)).toEqual([
          { width: 375, height: 812 },
          { width: 1440, height: 900 },
        ]);
      },
    );
  });

  it("misuse: a matrix with no cases is a located error", () => {
    withMatrix(JSON.stringify({ cases: [] }), (file) => {
      expect(() => loadMatrix(file)).toThrow(
        new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*no cases`),
      );
    });
  });

  it("misuse: a non-numeric width names the case index", () => {
    withMatrix(
      JSON.stringify({
        cases: [
          { width: 375, height: 812 },
          { width: "wide", height: 900 },
        ],
      }),
      (file) => {
        expect(() => loadMatrix(file)).toThrow(/cases\[1\]\.width/);
      },
    );
  });

  it("misuse: invalid JSON names the file", () => {
    withMatrix("{ not json", (file) => {
      expect(() => loadMatrix(file)).toThrow(/breakpoints\.json/);
    });
  });
});
