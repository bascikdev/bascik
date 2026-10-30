// Unit tests for the pure halves of the fixes to the bascik-refactor parity checks, one block per gap a reviewer found
// after the first version reported "no findings". The browser half is in refactor-parity-misses.integration.test.ts.
//
// Why it exists: agents treated "no findings" as PASS, so a defect a check cannot see, or a finding a check makes on
// identical pages (which teaches agents to skip the check), costs the same: a route ships with a visible difference.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgsFor,
  routeSlug,
} from "../../skills/bascik-refactor/scripts/lib/checks.mjs";
import {
  diffEffects,
  effectOf,
  matchAnchor,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";
import {
  diffIcons,
  diffPosition,
} from "../../skills/bascik-refactor/scripts/state-capture.mjs";
import { diffInstances } from "../../skills/bascik-refactor/scripts/repeated-sections.mjs";
import { diffSpacing } from "../../skills/bascik-refactor/scripts/spacing-diff.mjs";
import {
  SELECTOR as ALIGN_SELECTOR,
  diffAlignment,
} from "../../skills/bascik-refactor/scripts/alignment-diff.mjs";
import {
  diffOverlaps,
  findOverlaps,
  pairUp,
} from "../../skills/bascik-refactor/scripts/overlap-diff.mjs";
import {
  appendLedger,
  detectDefects,
  ledgerRows,
} from "../../skills/bascik-refactor/scripts/production-defects.mjs";
import { presenceKey } from "../../skills/bascik-refactor/scripts/presence-by-route.mjs";
import {
  locate,
  openingTags,
} from "../../skills/bascik-refactor/scripts/testid-coverage.mjs";
import {
  renderReviewPage,
  reviewFingerprint,
  verifySignOffs,
  writeSignOff,
} from "../../skills/bascik-refactor/scripts/review-page.mjs";
import { formatFindings } from "../../skills/bascik-refactor/scripts/run-checks.mjs";

type Finding = { kind: string; key?: string; [field: string]: unknown };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bascik-parity-misses-unit-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("routeSlug keeps distinct routes in distinct files", () => {
  it("plain routes keep their readable name", () => {
    expect(routeSlug("/")).toBe("index");
    expect(routeSlug("/about")).toBe("about");
    expect(routeSlug("/docs/a/b")).toBe("docs_a_b");
  });

  it("routes that would share a name get a hash suffix", () => {
    const routes = ["/", "/index", "/docs/a/b", "/docs/a_b", "/en/ü", "/en/é"];
    const slugs = routes.map(routeSlug);
    expect(new Set(slugs).size).toBe(routes.length);
    expect(routeSlug("/index")).toMatch(/^index-[0-9a-f]{8}$/);
    expect(routeSlug("/docs/a_b")).toMatch(/^docs_a_b-[0-9a-f]{8}$/);
  });
});

describe("--mask", () => {
  const base = [
    "--prod",
    "https://example.com",
    "--target",
    "http://localhost:8080",
    "--route",
    "/",
  ];

  it("every check takes it", () => {
    expect(
      parseArgsFor([...base, "--mask", '[data-testid="carousel"]']).mask,
    ).toEqual(['[data-testid="carousel"]']);
    expect(parseArgsFor(base).mask).toEqual([]);
  });

  it("a selector the page would ignore is an error, so the region is never compared by accident", () => {
    expect(() => parseArgsFor([...base, "--mask", "["])).toThrow(/--mask/);
    expect(() => parseArgsFor([...base, "--mask", 'a[href="x'])).toThrow(
      /quote/,
    );
    expect(() => parseArgsFor([...base, "--mask", " "])).toThrow(/--mask/);
  });
});

describe("interaction-crawl", () => {
  const anchor = (over = {}) => ({
    tag: "SPAN",
    role: null,
    name: "Warranty",
    text: "Warranty",
    href: null,
    testId: null,
    ...over,
  });

  it("a hover activation only matches a hover activation", () => {
    expect(
      matchAnchor(anchor({ mode: "hover" }), [anchor({ mode: "click" })]),
    ).toBe(-1);
    expect(
      matchAnchor(anchor({ mode: "hover" }), [
        anchor({ mode: "click" }),
        anchor({ mode: "hover" }),
      ]),
    ).toBe(1);
    expect(matchAnchor(anchor(), [anchor({ mode: "click" })])).toBe(0);
  });

  it("effectOf leaves out what changes with no activation at all (a carousel, a ticker, a late banner)", () => {
    const state = (over = {}) => ({
      attrs: {
        "#banner": { hidden: "true" },
        "#menu": { hidden: "true" },
      },
      shown: ["H1:Froth"],
      focused: null,
      scrollY: 0,
      scrollTarget: "H1:Froth",
      hash: "",
      url: "/",
      ...over,
    });
    const before = state();
    const after = state({
      attrs: {
        "#banner": { hidden: "false" },
        "#menu": { hidden: "false" },
      },
      shown: ["H1:Froth", "H3:Red", "P:Free returns", "A:Frothers"],
      scrollY: 900,
      scrollTarget: "H3:Red",
    });
    const volatile = {
      selectors: ["#banner"],
      shown: ["H3:Red", "H3:Green", "P:Free returns"],
    };
    expect(effectOf(before, after, volatile)).toMatchObject({
      changed: ["hidden: true -> false"],
      shown: ["A:Frothers"],
      scrollTarget: null,
    });
    expect(effectOf(before, after).changed).toHaveLength(2);
  });

  it("a production element with no interactive match on the target says so", () => {
    const findings = diffEffects(
      [
        {
          anchor: anchor({ tag: "DIV", name: "See the specs" }),
          effect: {
            scrollDelta: 1400,
            scrollTarget: "H2:Specs",
            hash: "",
            url: "/",
            changed: [],
            shown: [],
            focused: null,
          },
        },
      ],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/See the specs/);
    expect(findings[0].message).toMatch(/scrolls/);
  });
});

describe("state-capture", () => {
  const chevron = {
    kind: "svg",
    src: "svg:path",
    shape: "M4 6l4 4 4-4",
    paint: "stroke rgb(214, 69, 93)",
  };

  it("a swapped inline svg with the same element names is an icon-shape finding", () => {
    const plus = { ...chevron, shape: "M8 3v10M3 8h10" };
    expect(
      diffIcons("BUTTON:Products", [chevron], [plus]).map(
        (f: Finding) => f.kind,
      ),
    ).toEqual(["icon-shape"]);
  });

  it("a recolored icon is an icon-color finding naming both colors", () => {
    const grey = { ...chevron, paint: "stroke rgb(153, 153, 153)" };
    const findings = diffIcons("BUTTON:Products", [chevron], [grey]);
    expect(findings.map((f: Finding) => f.kind)).toEqual(["icon-color"]);
    expect(findings[0].message).toContain("rgb(214, 69, 93)");
    expect(findings[0].message).toContain("rgb(153, 153, 153)");
  });

  it("the open panel's place relative to its trigger is compared within 1 px", () => {
    expect(
      diffPosition("BUTTON:Products", { dx: 0, dy: 40 }, { dx: 1, dy: 40 }),
    ).toEqual([]);
    const findings = diffPosition(
      "BUTTON:Products",
      { dx: 0, dy: 40 },
      { dx: 40, dy: 40 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "position" });
    expect(findings[0].message).toMatch(/40 px/);
  });
});

describe("repeated-sections", () => {
  it("diverging-instance uses production's value as the reference, so the wrong copy is blamed even on the first route", () => {
    const good = { color: "rgb(36, 87, 214)" };
    const bad = { color: "rgb(214, 69, 93)" };
    const findings = diffInstances("SECTION:Why our frother", [
      { route: "/", width: 1280, signature: bad, reference: good },
      { route: "/about", width: 1280, signature: good, reference: good },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      route: "/",
      prod: good.color,
      target: bad.color,
    });
  });
});

describe("spacing-diff", () => {
  it("side-by-side blocks (no vertical gap) do not repeat a gap finding already made in the column next to them", () => {
    const prod = [
      {
        key: "SECTION:Features",
        children: [
          { key: "H3:Steam wand", offset: 0, gap: null },
          { key: "P:Microfoam", offset: 40, gap: 12 },
          { key: "H3:Auto shutoff", offset: 0, gap: null },
          { key: "P:Stops", offset: 40, gap: 12 },
        ],
      },
    ];
    const target = [
      {
        key: "SECTION:Features",
        children: [
          { key: "H3:Steam wand", offset: 0, gap: null },
          { key: "P:Microfoam", offset: 49, gap: 21 },
          { key: "H3:Auto shutoff", offset: 0, gap: null },
          { key: "P:Stops", offset: 40, gap: 12 },
        ],
      },
    ];
    const findings = diffSpacing(prod, target);
    expect(findings.map((f: Finding) => `${f.kind} ${f.key}`)).toEqual([
      "gap P:Microfoam",
    ]);
  });
});

describe("alignment-diff", () => {
  it("measures links, list items, labels and captions too", () => {
    for (const tag of ["a", "li", "label", "figcaption", "td"])
      expect(ALIGN_SELECTOR).toContain(tag);
  });

  it("a shifted container is a page-left or page-right finding when the offsets from the container still match", () => {
    const node = { textAlign: "start", lines: 1, left: 0, right: 400 };
    const findings = diffAlignment(
      [
        {
          width: 1280,
          height: 800,
          nodes: { "H2:Froth": { ...node, pageLeft: 340, pageRight: 740 } },
        },
      ],
      [
        {
          width: 1280,
          height: 800,
          nodes: { "H2:Froth": { ...node, pageLeft: 0, pageRight: 1080 } },
        },
      ],
    );
    expect(findings.map((f: Finding) => f.kind).sort()).toEqual([
      "page-left",
      "page-right",
    ]);
    expect(findings[0].message).toMatch(/page/);
  });

  it("says the text ends, not starts, at its right offset", () => {
    const findings = diffAlignment(
      [
        {
          width: 375,
          height: 800,
          nodes: {
            "P:Hot": {
              textAlign: "start",
              lines: 1,
              left: 0,
              right: 20,
              pageLeft: 16,
              pageRight: 36,
            },
          },
        },
      ],
      [
        {
          width: 375,
          height: 800,
          nodes: {
            "P:Hot": {
              textAlign: "start",
              lines: 1,
              left: 0,
              right: 40,
              pageLeft: 16,
              pageRight: 56,
            },
          },
        },
      ],
    );
    const right = findings.find((f: Finding) => f.kind === "right");
    expect(right?.message).toMatch(/ends 20 px from the right/);
  });
});

describe("overlap-diff", () => {
  const box = (key: string, path: string, x: number, over = {}) => ({
    key,
    path,
    rect: { x, y: 0, width: 24, height: 24 },
    positioned: true,
    media: false,
    layer: null,
    ...over,
  });

  it("a fixed or sticky layer never pairs with the page under it", () => {
    expect(
      findOverlaps([
        box("DIV:We use cookies", "0.9", 0, { layer: "html > body > div" }),
        box("P:Froths in thirty seconds.", "0.2.1", 0),
      ]),
    ).toEqual([]);
    expect(
      findOverlaps([
        box("A:Logo > SVG", "0.1.0", 0, { layer: "header" }),
        box("A:Logo > SPAN", "0.1.1", 4, { layer: "header" }),
      ]),
    ).toHaveLength(1);
  });

  it("pairs with the same keys pair up in document order, so the third icon's 2 px is its own finding", () => {
    const pair = (dx: number) => ({
      a: "DIV:Track > SPAN",
      b: "DIV:Track > SVG",
      dx,
      dy: 0,
      wRatio: 0.5,
      hRatio: 0.5,
    });
    const prod = [pair(0), pair(0), pair(0)];
    const target = [pair(0), pair(0), pair(2)];
    expect(pairUp(prod, target)).toEqual([0, 1, 2]);
    const findings = diffOverlaps(prod, target);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "offset", dx: 2 });
  });
});

describe("production-defects", () => {
  const text = (key: string, path: string, over = {}) => ({
    key,
    selector: path,
    path,
    rect: { x: 0, y: 0, width: 200, height: 20 },
    scrollWidth: 200,
    clientWidth: 200,
    scrollHeight: 20,
    clientHeight: 20,
    overflow: "visible",
    ...over,
  });

  it("text in a fixed, sticky or dialog layer never counts as overlapping the page under it", () => {
    const defects = detectDefects({
      route: "/",
      width: 1280,
      texts: [
        text("P:Froths in thirty seconds.", "0.2.1"),
        text("P:We use cookies", "0.9.0", { layer: true }),
      ],
    });
    expect(defects).toEqual([]);
  });

  it("two overlaps that share one element get two ledger ids, and a new ledger starts with the table header", () => {
    const defects = detectDefects({
      route: "/about",
      width: 400,
      texts: [
        text("P:Contact", "0.3.0"),
        text("DIV:Notice", "0.4.0"),
        text("BUTTON:OK", "0.5.0"),
      ],
    });
    expect(
      defects.filter((d: Finding) => d.kind === "text-overlap"),
    ).toHaveLength(3);
    const ids = ledgerRows(defects).map((r: string) => r.split("|")[1].trim());
    expect(new Set(ids).size).toBe(ids.length);
    const file = join(dir, "ledger", "decisions.md");
    expect(appendLedger(file, defects)).toBe(3);
    const ledger = readFileSync(file, "utf8");
    expect(ledger).toMatch(/^# /);
    expect(ledger).toMatch(/\| id\s+\| route/);
    expect(appendLedger(file, defects)).toBe(0);
  });
});

describe("presence-by-route", () => {
  it("a live region without a name is named by its test id or id, never by the text it rotates through", () => {
    const a = presenceKey({
      tag: "P",
      role: null,
      name: "",
      text: "Now shipping",
      live: true,
      anchor: "ticker",
    });
    const b = presenceKey({
      tag: "P",
      role: null,
      name: "",
      text: "Free returns",
      live: true,
      anchor: "ticker",
    });
    expect(a).toBe(b);
    expect(a).not.toMatch(/shipping/);
  });
});

describe("testid-coverage locate", () => {
  it("names no line when no source tag really matches the rendered element", () => {
    const html = `<main>\n<div class="intro">\n<div data-bascik-slot="heading"><h2>Why teams switch</h2></div>\n</div>\n</main>\n`;
    const tags = openingTags(html);
    const at = locate(
      { tag: "div", attrs: { role: "dialog" }, text: "Cookies OK", name: "" },
      [{ file: "src/pages/about.html", html, tags }],
      "src/pages/about.html",
    );
    expect(at.line).toBeUndefined();
  });
});

describe("review-page", () => {
  const caseShots = () => {
    const prod = join(dir, "shots", "prod-375x800.png");
    const target = join(dir, "shots", "target-375x800.png");
    mkdirSync(join(dir, "shots"), { recursive: true });
    writeFileSync(prod, "prod-bytes");
    writeFileSync(target, "target-bytes");
    return { prod, target };
  };

  it("the diff overlay sits on the target image's own box, and both captions have the same height", () => {
    const { prod, target } = caseShots();
    const html = renderReviewPage({
      route: "/",
      cases: [{ width: 375, height: 800, prod, target }],
      base: dir,
    });
    expect(html).toMatch(/\.stack\s*\{[^}]*display:\s*inline-block/);
    expect(html).toMatch(/\.stack\s*\{[^}]*overflow:\s*hidden/);
    expect(html).not.toMatch(/<figcaption>[^<]*<button/);
    expect(html).not.toMatch(/on the left, the target on the right/);
  });

  it("verify fails when the checks report fails, or when the target changed after the sign-off", () => {
    const { prod, target } = caseShots();
    const compare = join(dir, "compare");
    const checks = join(dir, "checks");
    const review = join(dir, "review-tied");
    mkdirSync(join(compare, "index"), { recursive: true });
    mkdirSync(join(checks, "index"), { recursive: true });
    writeFileSync(
      join(compare, "index", "report.json"),
      JSON.stringify({
        cases: [{ width: 375, height: 800, screenshots: { prod, target } }],
      }),
    );
    const report = (ok: boolean) =>
      writeFileSync(
        join(checks, "index", "report.json"),
        JSON.stringify({
          route: "/",
          ok,
          findings: ok
            ? []
            : [{ check: "spacing-diff", kind: "gap", message: "gap" }],
        }),
      );
    report(true);
    const options = { compare, checks };
    const reviewed = reviewFingerprint("/", options);
    writeSignOff({
      dir: review,
      route: "/",
      reviewer: "Sam Rivera",
      verdict: "pass",
      notes: "",
      date: "2026-10-29",
      reviewed,
    });
    expect(verifySignOffs(review, ["/"], options)).toEqual({
      ok: true,
      problems: [],
    });
    report(false);
    expect(verifySignOffs(review, ["/"], options).problems.join("\n")).toMatch(
      /run-checks/,
    );
    report(true);
    writeFileSync(target, "target-bytes-after-a-fix");
    expect(verifySignOffs(review, ["/"], options).problems.join("\n")).toMatch(
      /changed since/,
    );
  });
});

describe("run-checks output", () => {
  it("one style difference in three states prints as one line", () => {
    const base = {
      check: "text-style-diff",
      kind: "style",
      route: "/",
      width: 400,
      key: "A:About",
      property: "font-weight",
      prod: "600",
      target: "400",
    };
    const lines = formatFindings(
      ["rest", "hover", "focus-visible"].map((state) => ({
        ...base,
        state,
        message: `A:About (${state}): font-weight is "600" in production and "400" on the target`,
      })),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/rest, hover, focus-visible/);
  });
});
