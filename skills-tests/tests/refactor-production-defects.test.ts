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
  LEDGER_EVIDENCE,
  LEDGER_NOTE,
  appendLedger,
  applyCorrections,
  detectAcross,
  detectDefects,
  diffDefects,
  ledgerId,
  ledgerRows,
  parseCliArgs,
  rejectDefects,
  rejectedFrom,
  rejectionsFrom,
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

  it("escapes a backslash before a pipe, so the escaped pipe still cannot end the cell", () => {
    const [row] = ledgerRows([
      { ...defects()[0], selector: String.raw`.a\|b` },
    ]);
    expect(row).toContain(String.raw`.a\\\|b`);
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

  it("lists the rejected production defects with their id and source, and every rejection the run used", () => {
    const html = renderReviewPage({
      route: "/",
      productionDefects: [],
      rejectedDefects: [
        {
          check: CHECK,
          kind: "text-overflow",
          route: "/",
          width: 400,
          selector: "header a > span",
          message: "SPAN:<i>MILK</i> overflows its box",
          id: "PD-1a2b3c",
          sources: ["--reject"],
        },
      ],
      rejections: [
        { id: "PD-1a2b3c", source: "--reject", matched: 1 },
        { id: "PD-00ff00", source: "D-07", ledgerRow: true, matched: 0 },
      ],
      base: tmpdir(),
    });
    const section =
      html
        .split('data-testid="review-rejected-defects"')[1]
        ?.split(/data-testid="review-(?!rejected-defect|rejection)/)[0] ?? "";
    expect(section, "a review-rejected-defects section").not.toBe("");
    expect(section).toContain("PD-1a2b3c");
    expect(section).toContain("--reject");
    expect(section).toContain("header a &gt; span");
    expect(section).toContain("&lt;i&gt;MILK&lt;/i&gt;");
    expect(section).toContain("PD-00ff00");
    expect(section).toContain("D-07");
    expect(section).toMatch(/matches no defect/);
    expect(html).not.toContain("<i>MILK</i>");
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

  it("takes reviewed false positives with --reject PD-xxxxxx and an accepted.json file with --accepted", () => {
    expect(
      parseCliArgs([
        ...base,
        "--route",
        "/",
        "--reject",
        "PD-1a2b3c",
        "--reject",
        "PD-00ff00",
        "--accepted",
        "docs/migration/accepted.json",
      ]),
    ).toMatchObject({
      reject: ["PD-1a2b3c", "PD-00ff00"],
      accepted: "docs/migration/accepted.json",
    });
    expect(parseCliArgs([...base, "--route", "/"]).reject).toEqual([]);
  });

  it("refuses a --reject that is not a production-defects ledger id, naming it", () => {
    for (const id of ["PD-1a2b", "D-07", "pd-1a2b3c", "PD-1A2B3G"])
      expect(
        () => parseCliArgs([...base, "--route", "/", "--reject", id]),
        id,
      ).toThrow(new RegExp(`--reject ${id}.*PD-`));
  });
});

/** A text box as the browser half measures it: one line of 36 px by default, nothing overflowing. */
const textBox = (over: Record<string, unknown> = {}) => ({
  key: "H2:Silky milk in thirty seconds",
  selector: "main h2",
  path: "0.0",
  rect: rect(24, 200, 288, 36),
  scrollWidth: 288,
  clientWidth: 288,
  scrollHeight: 36,
  clientHeight: 36,
  lineHeight: 36,
  overflow: "visible",
  ...over,
});

describe("detectDefects: what is not a defect (false positives found in real trials)", () => {
  it("glyphs a few px past a tight line-height with overflow visible are not text-overflow: a logotype and a display heading", () => {
    // A two-line wordmark at line-height 0.9: content 113x36, box 113x33.
    const wordmark = textBox({
      key: "SPAN:MILKFROTHER",
      scrollWidth: 113,
      clientWidth: 113,
      scrollHeight: 36,
      clientHeight: 33,
      lineHeight: 16.2,
    });
    // A display font at 30px/36px: content 288x38, box 288x36.
    const heading = textBox({ scrollHeight: 38 });
    expect(detectDefects(snapshot({ texts: [wordmark] }))).toEqual([]);
    expect(detectDefects(snapshot({ texts: [heading] }))).toEqual([]);
  });

  it("text that wraps to a line its box has no room for is still text-overflow, and a clipped box is text-clipped however small the excess", () => {
    // A button label that wraps at 768 px inside a 20 px tall box.
    const wrapped = textBox({
      key: "BUTTON:Book a demo",
      scrollHeight: 40,
      clientHeight: 20,
      lineHeight: 20,
    });
    expect(kinds(detectDefects(snapshot({ texts: [wrapped] })))).toEqual([
      "text-overflow",
    ]);
    // The same 2 px ink overflow under overflow hidden cuts the glyphs off.
    const clipped = textBox({ scrollHeight: 38, overflow: "hidden" });
    expect(kinds(detectDefects(snapshot({ texts: [clipped] })))).toEqual([
      "text-clipped",
    ]);
    // Wider than its column is overflow whatever the line height.
    const wide = textBox({ scrollWidth: 340 });
    expect(kinds(detectDefects(snapshot({ texts: [wide] })))).toEqual([
      "text-overflow",
    ]);
  });

  it("a snapshot measured before line heights were recorded keeps the 1 px tolerance", () => {
    const old = textBox({ scrollHeight: 38, lineHeight: undefined });
    expect(kinds(detectDefects(snapshot({ texts: [old] })))).toEqual([
      "text-overflow",
    ]);
  });

  it("a visually hidden label (sr-only: clipped to 1x1) is neither clipped text nor an overlap", () => {
    const srOnly = textBox({
      key: "SPAN:Toggle theme",
      path: "0.1",
      rect: rect(24, 200, 1, 1),
      scrollWidth: 92,
      clientWidth: 1,
      scrollHeight: 20,
      clientHeight: 1,
      overflow: "hidden",
      visuallyHidden: true,
    });
    const neighbor = textBox({ path: "0.2" });
    expect(detectDefects(snapshot({ texts: [srOnly, neighbor] }))).toEqual([]);
  });

  it("the face of a flip card turned away (backface-visibility hidden) does not overlap the face shown", () => {
    const front = textBox({ key: "P:Froths in 30 s", path: "0.0.0" });
    const back = textBox({
      key: "P:Wash the jug by hand",
      path: "0.0.1",
      facingAway: true,
    });
    expect(detectDefects(snapshot({ texts: [front, back] }))).toEqual([]);
    // Both faces shown is a real overlap.
    expect(
      kinds(
        detectDefects(
          snapshot({ texts: [front, { ...back, facingAway: false }] }),
        ),
      ),
    ).toEqual(["text-overlap"]);
  });
});

describe("detectAcross: defects that need every case of a route", () => {
  const row = (wrapped: boolean) =>
    iconRow(
      rect(24, 100, 24, 24),
      wrapped ? rect(24, 132, 316, 28) : rect(60, 98, 316, 28),
    );
  const at = (width: number, wrapped: boolean, route = "/") =>
    snapshot({ route, width, iconRows: [row(wrapped)] });

  it("an icon above its heading at every width is the design, not icon-wrapped", () => {
    expect(
      detectAcross([at(320, true), at(768, true), at(1280, true)]),
    ).toEqual([]);
  });

  it("an icon that drops to its own line at some widths only is icon-wrapped at those widths", () => {
    const defects = detectAcross([
      at(320, true),
      at(768, false),
      at(1280, false),
    ]);
    expect(
      defects.map((d: { kind: string; width: number }) => [d.kind, d.width]),
    ).toEqual([["icon-wrapped", 320]]);
  });

  it("decides per route, and one case alone cannot tell a design from a defect", () => {
    expect(detectAcross([at(320, true)])).toEqual([]);
    const defects = detectAcross([
      at(320, true, "/"),
      at(768, true, "/"),
      at(320, true, "/shop"),
      at(768, false, "/shop"),
    ]);
    expect(
      defects.map((d: { route: string; width: number }) => [d.route, d.width]),
    ).toEqual([["/shop", 320]]);
  });

  it("keeps every other defect of every case", () => {
    const defects = detectAcross([
      snapshot({ width: 320, page: { scrollWidth: 356, clientWidth: 320 } }),
      snapshot({ width: 768 }),
    ]);
    expect(kinds(defects)).toEqual(["horizontal-scroll"]);
  });
});

describe("ledger rows collapse the same defect across widths and routes", () => {
  const overflow = (route: string, width: number, selector = "header h2") => ({
    check: CHECK,
    kind: "text-overflow",
    route,
    width,
    key: "H2:Silky milk in thirty seconds",
    selector,
    message: `H2:Silky milk in thirty seconds at ${width} px overflows its box`,
  });

  it("writes one row per element and kind, with the width range and every route", () => {
    const defects = [
      overflow("/", 320),
      overflow("/", 375),
      overflow("/", 414),
      overflow("/shop", 320, "footer h2"),
    ];
    const rows = ledgerRows(defects, { widths: [320, 375, 414, 768, 1280] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\|\s*\/, \/shop\s*\|/);
    expect(rows[0]).toContain("320-414 px wide");
    expect(rows[0]).toContain(ledgerId(defects[0]));
  });

  it("names separate ranges when the defect skips a measured width", () => {
    const rows = ledgerRows(
      [overflow("/", 320), overflow("/", 375), overflow("/", 1280)],
      { widths: [320, 375, 768, 1280] },
    );
    expect(rows[0]).toContain("320-375, 1280 px wide");
  });

  it("the row id does not depend on the route or width, so one --reject covers the element everywhere", () => {
    expect(ledgerId(overflow("/", 320))).toBe(
      ledgerId(overflow("/shop", 1280)),
    );
    expect(ledgerId(overflow("/", 320))).toMatch(/^PD-[0-9a-f]{6}$/);
    expect(ledgerId(overflow("/", 320))).not.toBe(
      ledgerId({ ...overflow("/", 320), kind: "text-clipped" }),
    );
  });

  it("appending the collapsed rows twice still adds each once", () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-defects-"));
    try {
      const file = join(dir, "decisions.md");
      const defects = [overflow("/", 320), overflow("/", 375)];
      expect(appendLedger(file, defects).added).toBe(1);
      expect(appendLedger(file, defects)).toMatchObject({
        added: 0,
        updated: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rejecting a reviewed false positive", () => {
  const logo = {
    check: CHECK,
    kind: "text-overflow",
    route: "/",
    width: 400,
    key: "SPAN:MILKFROTHER",
    selector: "header a > span",
    message: "SPAN:MILKFROTHER at 400 px overflows its box",
  };
  const id = ledgerId(logo);

  it("rejectDefects drops the rejected ids and names any id that matched nothing", () => {
    const other = { ...logo, kind: "text-clipped" };
    const { kept, rejected, unused } = rejectDefects(
      [logo, { ...logo, route: "/shop" }, other],
      [id, "PD-000000"],
    );
    expect(kept).toEqual([other]);
    expect(rejected).toHaveLength(2);
    expect(unused).toEqual(["PD-000000"]);
  });

  it("a target that keeps a rejected defect is not a copied-defect, and one only the target has is not a target-defect", () => {
    expect(diffDefects([logo], [logo], { rejected: [id] })).toEqual([]);
    expect(diffDefects([], [logo], { rejected: [id] })).toEqual([]);
    expect(
      diffDefects([logo], [logo]).map((f: { kind: string }) => f.kind),
    ).toEqual(["copied-defect"]);
  });

  it("reads the ids from accepted.json entries that carry a defect list, and ignores the other entries", () => {
    expect(
      rejectedFrom([
        { id: "D-01", mask: ["footer"] },
        { id: "D-07", defect: [id] },
        { id: "D-08", defect: ["PD-00ff00"] },
      ]),
    ).toEqual([id, "PD-00ff00"]);
    expect(rejectedFrom([])).toEqual([]);
  });
});

describe("rejections are recorded with where each came from (review of the reject change)", () => {
  const logo = {
    check: CHECK,
    kind: "text-overflow",
    route: "/",
    width: 400,
    key: "SPAN:MILKFROTHER",
    selector: "header a > span",
    message: "SPAN:MILKFROTHER at 400 px overflows its box",
  };
  const id = ledgerId(logo);
  const ledgerText = `| D-07 | / | all | logotype | kept | nothing is cut off | review | Sam Rivera |\n`;

  it("rejectionsFrom names each id's source: --reject, or the accepted.json entry and whether the ledger has its row", () => {
    expect(
      rejectionsFrom({
        reject: ["PD-00aa00"],
        accepted: [
          { id: "D-01", mask: ["footer"] },
          { id: "D-07", defect: [id] },
          { id: "D-09", defect: ["PD-00ff00"] },
        ],
        ledgerText,
      }),
    ).toEqual([
      { id: "PD-00aa00", source: "--reject" },
      { id, source: "D-07", ledgerRow: true },
      { id: "PD-00ff00", source: "D-09", ledgerRow: false },
    ]);
    expect(rejectionsFrom({})).toEqual([]);
  });

  it("each rejected defect carries its id and sources, and a run's rejections say how many defects each matched", () => {
    const rejections = rejectionsFrom({
      reject: ["PD-000000"],
      accepted: [{ id: "D-07", defect: [id] }],
      ledgerText,
    });
    const { kept, rejected, unused, applied } = rejectDefects(
      [logo, { ...logo, width: 1280 }],
      rejections,
    );
    expect(kept).toEqual([]);
    expect(rejected).toEqual([
      { ...logo, id, sources: ["D-07"] },
      { ...logo, width: 1280, id, sources: ["D-07"] },
    ]);
    expect(unused).toEqual(["PD-000000"]);
    expect(applied).toEqual([
      { id: "PD-000000", source: "--reject", matched: 0 },
      { id, source: "D-07", ledgerRow: true, matched: 2 },
    ]);
  });

  it("warns when one rejected id covers elements at more than one selector (elements with the same text and kind share an id)", () => {
    const { broad } = rejectDefects(
      [
        logo,
        { ...logo, route: "/shop", selector: "footer a > span" },
        { ...logo, width: 1280 },
      ],
      [id],
    );
    expect(broad).toEqual([
      {
        id,
        selectors: ["header a > span", "footer a > span"],
        routes: ["/", "/shop"],
      },
    ]);
    expect(rejectDefects([logo, { ...logo, width: 1280 }], [id]).broad).toEqual(
      [],
    );
  });
});

describe("appendLedger keeps its own rows current and migrates old per-case rows", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bascik-defects-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const overflow = (route: string, width: number, selector = "header h2") => ({
    check: CHECK,
    kind: "text-overflow",
    route,
    width,
    key: "H2:Silky milk in thirty seconds",
    selector,
    message: `H2:Silky milk in thirty seconds at ${width} px overflows its box`,
  });

  it("a row first written by a partial run grows its routes, widths and selectors on a later, wider run", () => {
    const file = join(dir, "decisions.md");
    expect(appendLedger(file, [overflow("/", 320)], { widths: [320] })).toEqual(
      { added: 1, updated: 0, removed: 0, staleKept: [] },
    );
    expect(
      appendLedger(
        file,
        [
          overflow("/", 320),
          overflow("/", 375),
          overflow("/shop", 375, "footer h2"),
        ],
        { widths: [320, 375, 768] },
      ),
    ).toEqual({ added: 0, updated: 1, removed: 0, staleKept: [] });
    const text = readFileSync(file, "utf8");
    const rows = text.split("\n").filter((l) => l.includes(LEDGER_NOTE));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\|\s*\/, \/shop\s*\|/);
    expect(rows[0]).toContain("320-375 px wide");
    expect(rows[0]).toContain("`header h2`, `footer h2`");
    // Nothing new: the row is left as it is.
    expect(appendLedger(file, [overflow("/", 320)], { widths: [320] })).toEqual(
      { added: 0, updated: 0, removed: 0, staleKept: [] },
    );
  });

  it("keeps what a person wrote in a row it updates (approved by), and never touches a row a person wrote", () => {
    const file = join(dir, "decisions.md");
    appendLedger(file, [overflow("/", 320)], { widths: [320] });
    const id = ledgerId(overflow("/", 320));
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/\| \|\n$/, "| Sam Rivera |\n"),
    );
    appendLedger(file, [overflow("/", 1280)], { widths: [320, 1280] });
    const row = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`| ${id} `));
    expect(row).toContain("320, 1280 px wide");
    expect(row).toMatch(/\| Sam Rivera \|$/);

    // Misuse: a person reused a PD- id for a row of their own; it is not the script's row and stays as written.
    const other = join(dir, "other.md");
    const human = `| ${id} | /about | all | hand-written | kept | reviewed | notes | Sam Rivera |`;
    writeFileSync(other, `# Differences and decisions\n\n${human}\n`);
    expect(
      appendLedger(other, [overflow("/", 320)], { widths: [320] }),
    ).toEqual({ added: 0, updated: 0, removed: 0, staleKept: [] });
    expect(readFileSync(other, "utf8")).toContain(human);
  });

  it("removes the old one-row-per-case rows nobody approved, keeps an approved one and names it", () => {
    const file = join(dir, "decisions.md");
    const old = (pd: string, approved = "") =>
      `| ${pd} | / | 320 px wide | text-overflow: H2:Silky at 320 px overflows its box (\`header h2\`) | ${LEDGER_NOTE} | the target fixes what production gets wrong | production-defects.mjs | ${approved} |`;
    const human =
      "| D-01 | / | all | Footer links at 3.1:1 contrast | 4.6:1 | WCAG AA | report | Sam Rivera |";
    writeFileSync(
      file,
      `# Differences and decisions\n\n${human}\n${old("PD-111111")}\n${old("PD-222222")}\n${old("PD-333333", "Sam Rivera")}\n`,
    );
    expect(appendLedger(file, [overflow("/", 320)], { widths: [320] })).toEqual(
      { added: 1, updated: 0, removed: 2, staleKept: ["PD-333333"] },
    );
    const text = readFileSync(file, "utf8");
    expect(text).toContain(human);
    expect(text).not.toContain("PD-111111");
    expect(text).not.toContain("PD-222222");
    expect(text).toContain("PD-333333");
    expect(text).toContain(LEDGER_EVIDENCE);
  });
});

describe("text covered by an opaque layer painted above it is not text-overlap (a stacked card deck)", () => {
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
  const texts = [
    t("P:Froths in 30 seconds", "0.0.0", rect(24, 100, 300, 24)),
    t("P:Wash the jug by hand", "0.1.0", rect(24, 100, 300, 24)),
  ];

  it("a pair the page measured as covered is left out; the same pair uncovered is still reported", () => {
    expect(
      detectDefects(snapshot({ texts, covered: [["0.0.0", "0.1.0"]] })),
    ).toEqual([]);
    expect(
      detectDefects(snapshot({ texts, covered: [["0.1.0", "0.0.0"]] })),
    ).toEqual([]);
    expect(kinds(detectDefects(snapshot({ texts })))).toEqual(["text-overlap"]);
    // Misuse: a covered pair for other elements does not hide this one.
    expect(
      kinds(detectDefects(snapshot({ texts, covered: [["0.0.0", "0.2.0"]] }))),
    ).toEqual(["text-overlap"]);
  });
});
