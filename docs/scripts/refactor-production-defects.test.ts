// Unit tests for skills/bascik-refactor/scripts/production-defects.mjs: the defects found ON PRODUCTION at every matrix
// case before parity runs (squished or stretched images, an icon off its heading or wrapped away from it, text that
// overflows or is clipped, overlapping text, horizontal page scroll), the ledger rows they become, and how the parity
// checks then compare the target with the corrected expectation instead of with production. The browser half is in
// refactor-parity-checks.integration.test.ts.
//
// Why it exists: the refactor faithfully copied production bugs, an icon and a section heading misaligned at small
// widths and images squished at some widths, because every check treated production as the truth.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASPECT_TOLERANCE,
  CHECK,
  ICON_CENTER_TOLERANCE,
  LEDGER_NOTE,
  appendLedger,
  applyCorrections,
  detectDefects,
  diffDefects,
  ledgerRows,
  parseCliArgs,
} from "../../skills/bascik-refactor/scripts/production-defects.mjs";
import { renderReviewPage } from "../../skills/bascik-refactor/scripts/review-page.mjs";

type Rect = { x: number; y: number; width: number; height: number };
const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

/** One matrix case as the browser half measures it; every list empty means a page with nothing to report. */
const snapshot = (over: Record<string, unknown> = {}) => ({
  route: "/",
  width: 400,
  height: 800,
  images: [],
  iconRows: [],
  texts: [],
  page: { scrollWidth: 400, clientWidth: 400 },
  ...over,
});
const image = (
  rendered: [number, number],
  objectFit = "fill",
  natural: [number, number] = [400, 300],
) => ({
  key: "IMG:A board with three columns of cards",
  selector: "main section figure > img",
  natural: { width: natural[0], height: natural[1] },
  rendered: { width: rendered[0], height: rendered[1] },
  objectFit,
});
const iconRow = (icon: Rect, heading: Rect) => ({
  key: "H3:Boards that update themselves the moment work moves",
  selector: "main section li:nth-child(1)",
  icon,
  heading,
});
const kinds = (defects: Array<{ kind: string }>) =>
  defects.map((d) => d.kind).sort();

describe("constants", () => {
  it("names the check, 2 percent for aspect ratios, 4 px for icon centers, and the ledger wording", () => {
    expect(CHECK).toBe("production-defects");
    expect(ASPECT_TOLERANCE).toBe(0.02);
    expect(ICON_CENTER_TOLERANCE).toBe(4);
    expect(LEDGER_NOTE).toBe("production defect: fix in target");
  });
});

describe("detectDefects", () => {
  it("a clean case has no defects", () => {
    expect(detectDefects(snapshot())).toEqual([]);
  });

  it("an image drawn at another aspect ratio with object-fit fill or none is squished, with route, width and selector", () => {
    for (const fit of ["fill", "none"]) {
      const defects = detectDefects(
        snapshot({ images: [image([352, 240], fit)] }),
      );
      expect(defects, fit).toEqual([
        expect.objectContaining({
          check: CHECK,
          kind: "squished",
          route: "/",
          width: 400,
          selector: "main section figure > img",
        }),
      ]);
      expect(defects[0].message).toMatch(/4:3|1\.33/);
    }
  });

  it("the same box is fine when the image keeps its ratio, is cropped with cover or contain, or is within 2 percent", () => {
    expect(detectDefects(snapshot({ images: [image([320, 240])] }))).toEqual(
      [],
    );
    for (const fit of ["cover", "contain", "scale-down"])
      expect(
        detectDefects(snapshot({ images: [image([352, 240], fit)] })),
        fit,
      ).toEqual([]);
    // 404 x 300 is 1 percent wider than 4:3.
    expect(detectDefects(snapshot({ images: [image([404, 300])] }))).toEqual(
      [],
    );
  });

  it("an image that has not loaded has no natural size and is skipped, not reported as infinitely squished", () => {
    expect(
      detectDefects(snapshot({ images: [image([352, 240], "fill", [0, 0])] })),
    ).toEqual([]);
  });

  it("an icon whose center is more than 4 px off its heading's is misaligned, naming the offset", () => {
    const defects = detectDefects(
      snapshot({
        iconRows: [iconRow(rect(24, 100, 24, 24), rect(60, 100, 316, 56))],
      }),
    );
    expect(defects).toEqual([
      expect.objectContaining({ kind: "icon-misaligned", width: 400 }),
    ]);
    expect(defects[0].message).toMatch(/16(\.0)? ?px/);
  });

  it("2 px off is within tolerance", () => {
    expect(
      detectDefects(
        snapshot({
          iconRows: [iconRow(rect(24, 100, 24, 24), rect(60, 100, 300, 28))],
        }),
      ),
    ).toEqual([]);
  });

  it("an icon wrapped to its own line above or below its heading is reported as wrapped", () => {
    const defects = detectDefects(
      snapshot({
        iconRows: [iconRow(rect(24, 100, 24, 24), rect(24, 132, 316, 28))],
      }),
    );
    expect(kinds(defects)).toEqual(["icon-wrapped"]);
  });

  it("text that overflows its box, or is clipped by it, is reported", () => {
    const text = (over: Record<string, unknown>) => ({
      key: "P:Boards, timelines and reports",
      selector: "main p",
      rect: rect(24, 200, 352, 48),
      scrollWidth: 352,
      clientWidth: 352,
      scrollHeight: 48,
      clientHeight: 48,
      overflow: "visible",
      ...over,
    });
    expect(
      kinds(detectDefects(snapshot({ texts: [text({ scrollWidth: 380 })] }))),
    ).toEqual(["text-overflow"]);
    expect(
      kinds(
        detectDefects(
          snapshot({
            texts: [text({ scrollHeight: 72, overflow: "hidden" })],
          }),
        ),
      ),
    ).toEqual(["text-clipped"]);
    // Sub-pixel rounding is not overflow.
    expect(
      detectDefects(snapshot({ texts: [text({ scrollWidth: 353 })] })),
    ).toEqual([]);
  });

  it("two text boxes that overlap are reported once; a text box inside another is not an overlap", () => {
    const t = (key: string, path: string, r: Rect) => ({
      key,
      selector: key,
      path,
      rect: r,
      scrollWidth: r.width,
      clientWidth: r.width,
      scrollHeight: r.height,
      clientHeight: r.height,
      overflow: "visible",
    });
    const overlapping = detectDefects(
      snapshot({
        texts: [
          t("H2:Why teams switch", "0.0", rect(24, 100, 300, 40)),
          t("P:Start free", "0.1", rect(24, 130, 300, 24)),
        ],
      }),
    );
    expect(kinds(overlapping)).toEqual(["text-overlap"]);
    const nested = detectDefects(
      snapshot({
        texts: [
          t("P:Start free", "0.1", rect(24, 130, 300, 24)),
          t("STRONG:free", "0.1.0", rect(60, 130, 40, 24)),
        ],
      }),
    );
    expect(nested).toEqual([]);
  });

  it("horizontal page scroll is a defect of the case", () => {
    const defects = detectDefects(
      snapshot({ page: { scrollWidth: 436, clientWidth: 400 } }),
    );
    expect(defects).toEqual([
      expect.objectContaining({ kind: "horizontal-scroll", width: 400 }),
    ]);
    expect(defects[0].message).toMatch(/36 ?px/);
  });
});

describe("diffDefects: the target against the corrected expectation", () => {
  const squished = detectDefects(snapshot({ images: [image([352, 240])] }));

  it("a target that copies a production defect fails with a copied-defect finding", () => {
    const findings = diffDefects(squished, squished);
    expect(findings).toEqual([
      expect.objectContaining({
        check: CHECK,
        kind: "copied-defect",
        defect: "squished",
        route: "/",
        width: 400,
        selector: "main section figure > img",
      }),
    ]);
  });

  it("a target that fixes it passes", () => {
    expect(diffDefects(squished, [])).toEqual([]);
  });

  it("a defect only the target has is a finding too", () => {
    const findings = diffDefects([], squished);
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "target-defect",
    ]);
  });
});

describe("ledgerRows and appendLedger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bascik-defects-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const defects = () => [
    ...detectDefects(snapshot({ images: [image([352, 240])] })),
    ...detectDefects(
      snapshot({
        iconRows: [iconRow(rect(24, 100, 24, 24), rect(60, 100, 316, 56))],
      }),
    ),
  ];

  it("writes one ledger row per defect, with route, width, selector and the ledger wording", () => {
    const rows = ledgerRows(defects());
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatch(/^\|.*\|$/);
      expect(row).toContain(LEDGER_NOTE);
      expect(row).toMatch(/\|\s*\/\s*\|/);
      expect(row).toMatch(/\b400\b/);
    }
    expect(rows[0]).toContain("main section figure > img");
    expect(rows[1]).toContain("main section li:nth-child(1)");
  });

  it("escapes a pipe in a selector so the table keeps its columns", () => {
    const [row] = ledgerRows([{ ...defects()[0], selector: 'a[href|="en"]' }]);
    expect(row).toContain('a[href\\|="en"]');
  });

  it("appending twice adds each row once, and leaves the rows people wrote alone", () => {
    const file = join(dir, "decisions.md");
    const human =
      "| D-01 | / | all | Footer links at 3.1:1 contrast | 4.6:1 | WCAG AA | report | Sam Rivera |";
    writeFileSync(file, `# Differences and decisions\n\n${human}\n`);
    appendLedger(file, defects());
    appendLedger(file, defects());
    const text = readFileSync(file, "utf8");
    expect(text).toContain(human);
    expect(text.split(LEDGER_NOTE).length - 1).toBe(2);
  });
});

describe("applyCorrections", () => {
  const defect = {
    check: CHECK,
    kind: "icon-misaligned",
    route: "/",
    width: 400,
    key: "H3:Boards that update themselves the moment work moves",
    selector: "main section li:nth-child(1)",
    message: "icon 16 px off its heading",
  };
  const finding = (over: Record<string, unknown> = {}) => ({
    check: "alignment-diff",
    kind: "left",
    route: "/",
    width: 400,
    key: defect.key,
    message: "H3 left offset differs by 18 px",
    ...over,
  });

  it("a parity finding on a corrected element at the defect's case is moved to corrected, not reported", () => {
    const { kept, corrected } = applyCorrections([finding()], [defect]);
    expect(kept).toEqual([]);
    expect(corrected).toEqual([finding()]);
  });

  it("the same element at another width, another route or another element is still a finding", () => {
    const others = [
      finding({ width: 1024 }),
      finding({ route: "/about" }),
      finding({ key: "H3:Reports" }),
    ];
    const { kept, corrected } = applyCorrections(others, [defect]);
    expect(kept).toEqual(others);
    expect(corrected).toEqual([]);
  });

  it("never hides a copied-defect finding: the target must still fix the defect", () => {
    const copied = finding({ check: CHECK, kind: "copied-defect" });
    expect(applyCorrections([copied], [defect]).kept).toEqual([copied]);
  });
});

describe("the review page lists production defects apart from the findings", () => {
  it("shows each one with route, width and selector, escaped", () => {
    const html = renderReviewPage({
      route: "/",
      cases: [],
      states: [],
      findings: [],
      productionDefects: [
        {
          check: CHECK,
          kind: "squished",
          route: "/",
          width: 400,
          selector: 'figure > img[alt="<b>board</b>"]',
          message: "image drawn at 1.47:1, natural 4:3",
        },
      ],
      base: tmpdir(),
    });
    // From the section's test id up to the next review-* test id that is not one of its own rows.
    const section =
      html
        .split('data-testid="review-production-defects"')[1]
        ?.split(/data-testid="review-(?!production-defect)/)[0] ?? "";
    expect(section, "a review-production-defects section").not.toBe("");
    expect(section).toContain(LEDGER_NOTE);
    expect(section).toContain("400");
    expect(section).toContain("&lt;b&gt;board&lt;/b&gt;");
    expect(html).not.toContain("<b>board</b>");
  });

  it("has no production-defects section when production had none", () => {
    const html = renderReviewPage({
      route: "/",
      cases: [],
      states: [],
      findings: [],
      productionDefects: [],
      base: tmpdir(),
    });
    expect(html).not.toContain('data-testid="review-production-defects"');
  });
});

describe("parseCliArgs", () => {
  const base = [
    "--prod",
    "https://example.com",
    "--target",
    "http://localhost:8080",
  ];

  it("needs --route and defaults the matrix, the ledger and the output folder", () => {
    expect(() => parseCliArgs(base)).toThrow(/--route/);
    expect(parseCliArgs([...base, "--route", "/"])).toMatchObject({
      matrix: "docs/migration/breakpoints.json",
      ledger: "docs/migration/decisions.md",
      out: "artifacts/checks",
    });
  });

  it("can run on production alone, before any target exists", () => {
    expect(() =>
      parseCliArgs(["--prod", "https://example.com", "--route", "/"]),
    ).not.toThrow();
  });
});
