// Unit tests for the pure halves of the second round of fixes to the bascik-refactor parity checks: one block per gap
// a reviewer found after run-checks.mjs reported "no findings" on a defect, or a finding on identical pages. The
// browser half is in refactor-parity-misses2.integration.test.ts.
//
// Why it exists: agents treated "no findings" as PASS, so a defect a check cannot see ships, and a finding on identical
// pages teaches agents to mask or skip the check. Each test names the defect it stands for, and the misuse cases (a
// wrong flag value, a project without components, a crash that is not a timeout) name the error a person sees.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTLE_MS,
  parseArgsFor,
  settleOf,
} from "../../skills/bascik-refactor/scripts/lib/checks.mjs";
import { findOverlaps } from "../../skills/bascik-refactor/scripts/overlap-diff.mjs";
import { diffSpacing } from "../../skills/bascik-refactor/scripts/spacing-diff.mjs";
import {
  componentUsage,
  decodeEntities,
  sectionFingerprint,
} from "../../skills/bascik-refactor/scripts/repeated-sections.mjs";
import {
  diffEffects,
  effectOf,
  matchAnchor,
  opensLayer,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";
import {
  diffDim,
  diffItemStates,
  diffStateStyles,
} from "../../skills/bascik-refactor/scripts/state-capture.mjs";
import { detectDefects } from "../../skills/bascik-refactor/scripts/production-defects.mjs";
import { diffPresence } from "../../skills/bascik-refactor/scripts/presence-by-route.mjs";
import {
  collectSourceHooks,
  diffHooks,
  diffSourceHooks,
} from "../../skills/bascik-refactor/scripts/testid-carryover.mjs";
import {
  auditTemplates,
  components,
} from "../../skills/bascik-refactor/scripts/testid-coverage.mjs";
import {
  isTransient,
  parseCliArgs as parseRunChecks,
  runOne,
} from "../../skills/bascik-refactor/scripts/run-checks.mjs";

type Finding = { kind: string; message: string; [field: string]: unknown };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bascik-parity-misses2-unit-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

describe("overlap-diff: an icon nested in its dot, and painted blocks pulled over each other", () => {
  const box = (
    key: string,
    path: string,
    r: ReturnType<typeof rect>,
    over = {},
  ) => ({
    key,
    path,
    rect: r,
    positioned: false,
    media: false,
    paints: false,
    nest: null,
    layer: null,
    ...over,
  });

  it("pairs a check mark with the dot it is absolutely positioned in (a child, not a sibling)", () => {
    const dot = box("LI:Press once > SPAN", "0.1.0", rect(0, 0, 24, 24), {
      positioned: true,
    });
    const check = box("LI:Press once > SVG", "0.1.0.0", rect(8, 6, 12, 12), {
      positioned: true,
      media: true,
      nest: "0.1.0",
    });
    const [pair] = findOverlaps([dot, check]);
    expect(pair).toMatchObject({ a: dot.key, b: check.key, dx: 2, dy: 0 });
  });

  it("never pairs a descendant with an ancestor it does not name as its nest (a hero and its headline)", () => {
    const hero = box("SECTION:Froth", "0.1", rect(0, 0, 1280, 520), {
      positioned: true,
    });
    const h1 = box("H1:Froth", "0.1.0", rect(100, 100, 600, 60), {
      positioned: true,
    });
    expect(findOverlaps([hero, h1])).toEqual([]);
  });

  it("pairs two painted blocks that overlap by design (a card pulled up over the hero), not boxes that only touch", () => {
    const hero = box("SECTION:Intro", "0.1", rect(0, 64, 1280, 300), {
      paints: true,
    });
    const card = box("DIV:Order today", "0.2.0.0", rect(360, 284, 560, 120), {
      paints: true,
    });
    expect(findOverlaps([hero, card])).toHaveLength(1);
    const touching = box("DIV:Care", "0.3", rect(0, 364.1, 1280, 100), {
      paints: true,
    });
    expect(findOverlaps([hero, touching])).toEqual([]);
    const plain = box("P:Text", "0.2.0.1", rect(360, 284, 560, 40));
    expect(findOverlaps([hero, plain])).toEqual([]);
  });
});

describe("spacing-diff: block heights and the space between sections", () => {
  const section = (key: string, over = {}, children: unknown[] = []) => ({
    key,
    children,
    height: 300,
    gap: 0,
    previous: "SECTION:Before",
    within: ["MAIN:"],
    ...over,
  });

  it("a button 16 px taller is a height finding, named once", () => {
    const child = (height: number) => [
      { key: "BUTTON:Add to cart", offset: 100, gap: 12, height },
      { key: "P:Ships today", offset: 100 + height + 12, gap: 12, height: 20 },
    ];
    const findings = diffSpacing(
      [section("SECTION:Buy", {}, child(44))],
      [section("SECTION:Buy", { height: 316 }, child(60))],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["height"]);
    expect(findings[0].message).toMatch(/Add to cart.*44 px.*60 px/);
  });

  it("margins that stop collapsing double the space between sections: one section-gap finding", () => {
    const findings = diffSpacing(
      [section("SECTION:Steps", { gap: 64 })],
      [section("SECTION:Steps", { gap: 128 })],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["section-gap"]);
    expect(findings[0].message).toMatch(/64 px in production and 128 px/);
  });

  it("a halved bottom padding is a section-height finding on that section, not on the main around it", () => {
    const findings = diffSpacing(
      [
        section("MAIN:", { within: [], gap: null }),
        section("SECTION:Intro", { height: 300 }),
      ],
      [
        section("MAIN:", { within: [], gap: null, height: 252 }),
        section("SECTION:Intro", { height: 252 }),
      ],
    ) as Finding[];
    expect(findings.map((f) => [f.kind, f.section])).toEqual([
      ["section-height", "SECTION:Intro"],
    ]);
  });

  it("a section whose height a block finding inside it explains is not reported again", () => {
    const blocks = (height: number) => [
      { key: "BUTTON:Add to cart", offset: 0, gap: null, height },
    ];
    const findings = diffSpacing(
      [section("SECTION:Buy", {}, blocks(44))],
      [section("SECTION:Buy", { height: 316 }, blocks(60))],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["height"]);
  });

  it("older measurements without heights or section geometry still compare", () => {
    expect(
      diffSpacing(
        [{ key: "BODY", children: [{ key: "P:A", offset: 0, gap: null }] }],
        [{ key: "BODY", children: [{ key: "P:A", offset: 0, gap: null }] }],
      ),
    ).toEqual([]);
  });
});

describe("repeated-sections: small bands and character references", () => {
  const band = (label: string) => ({
    label,
    tree: {
      tag: "SECTION",
      children: [
        { tag: "H2", children: [] },
        { tag: "P", children: [] },
        { tag: "A", children: [] },
      ],
    },
  });

  it("a small band with a heading and a link repeats only with the same heading", () => {
    const a = sectionFingerprint(band("Ready to froth?"));
    expect(a).toBeTruthy();
    expect(sectionFingerprint(band("Ready to froth?"))).toBe(a);
    expect(sectionFingerprint(band("Meet the team"))).not.toBe(a);
  });

  it("a small block without a link or button, or without a heading, is still too generic", () => {
    expect(
      sectionFingerprint({
        label: "Note",
        tree: {
          tag: "DIV",
          children: [
            { tag: "H2", children: [] },
            { tag: "P", children: [] },
          ],
        },
      }),
    ).toBeNull();
    expect(
      sectionFingerprint({
        label: "",
        tree: band("x").tree,
      }),
    ).toBeNull();
  });

  it("decodes the references an author writes, so &amp; in a source matches the rendered &", () => {
    expect(decodeEntities("Froth, steam &amp; pour")).toBe(
      "Froth, steam & pour",
    );
    expect(decodeEntities("Don&rsquo;t &#8212; &#x2014; &nbsp;")).toBe(
      "Don’t — —  ",
    );
    expect(decodeEntities("&unknown; stays")).toBe("&unknown; stays");
  });

  it("a component in a feature folder is named by its filename, as Bascik names it", () => {
    const root = join(dir, "usage");
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    mkdirSync(join(root, "src", "components", "marketing"), {
      recursive: true,
    });
    mkdirSync(join(root, "src", "components", "alert-box"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "src", "components", "marketing", "promo-card.html"),
      "<article></article>",
    );
    writeFileSync(
      join(root, "src", "components", "alert-box", "alert-box.html"),
      "<div></div>",
    );
    writeFileSync(
      join(root, "src", "pages", "index.html"),
      "<promo-card></promo-card><alert-box></alert-box>",
    );
    const usage = componentUsage(root);
    expect(usage.components.sort()).toEqual(["alert-box", "promo-card"]);
    expect(usage.pages["src/pages/index.html"]).toEqual([
      "alert-box",
      "promo-card",
    ]);
    expect(components(root).map((c: { name: string }) => c.name)).toEqual([
      "alert-box",
      "promo-card",
    ]);
  });

  it("testid-coverage: a project with pages and no components folder has no components; a wrong folder is an error", () => {
    const root = join(dir, "no-components");
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    expect(components(root)).toEqual([]);
    expect(() => components(join(dir, "nowhere"))).toThrow(/--target-src/);
  });
});

describe("interaction-crawl: values, moving content, landing, controls inside what opens", () => {
  const state = (over = {}) => ({
    attrs: {},
    shown: [],
    focused: null,
    scrollY: 0,
    scrollTarget: null,
    landing: null,
    hash: "",
    url: "/",
    ...over,
  });

  it("a stepper that changes an input's value has an effect; a dead one has none", () => {
    const before = state({ attrs: { "#qty": { value: "1" } } });
    expect(
      effectOf(before, state({ attrs: { "#qty": { value: "2" } } })).changed,
    ).toEqual(['value: "1" -> "2"']);
    expect(effectOf(before, before).changed).toEqual([]);
  });

  it("a carousel track translated by a click moves content, by direction only (another slide width still matches)", () => {
    const before = state({ attrs: { "#track": { shift: "0,0" } } });
    const after = (x: number) =>
      state({ attrs: { "#track": { shift: `${x},0` } } });
    expect(effectOf(before, after(-928)).changed).toEqual([
      "content of a clipped region moves left",
    ]);
    expect(effectOf(before, after(-900)).changed).toEqual(
      effectOf(before, after(-928)).changed,
    );
    expect(effectOf(before, after(1)).changed).toEqual([]);
  });

  it("a timed change the page makes on its own is not a control's effect", () => {
    const before = state({ attrs: { "#track": { shift: "0,0" } } });
    const after = state({ attrs: { "#track": { shift: "-500,0" } } });
    expect(
      effectOf(before, after, { selectors: ["#track"], shown: [] }).changed,
    ).toEqual([]);
  });

  const effect = (over = {}) => ({
    scrollDelta: 900,
    scrollTarget: "H2:Specs",
    landing: { top: 120, covered: false },
    hash: "#specs",
    url: "/",
    changed: [],
    shown: [],
    focused: null,
    ...over,
  });
  const anchor = {
    tag: "A",
    role: "link",
    name: "Specs",
    text: "Specs",
    href: "#specs",
    testId: null,
  };

  it("a heading that lands under the sticky header is a different effect, even with the same target and direction", () => {
    const findings = diffEffects(
      [{ anchor, effect: effect() }],
      [
        {
          anchor,
          effect: effect({
            scrollDelta: 972,
            landing: { top: 48, covered: true },
          }),
        },
      ],
    ) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/120 px.*48 px.*covers it/);
  });

  it("a landing a few pixels off (a sticky header that shrinks while scrolling) is no finding", () => {
    expect(
      diffEffects(
        [{ anchor, effect: effect() }],
        [{ anchor, effect: effect({ landing: { top: 134, covered: false } }) }],
      ),
    ).toEqual([]);
  });

  it("only a control that opens something is opened again for the controls inside it", () => {
    expect(opensLayer({ changed: ["open: false -> true"] })).toBe(true);
    expect(opensLayer({ changed: ["aria-expanded: false -> true"] })).toBe(
      true,
    );
    expect(opensLayer({ changed: ["aria-expanded: true -> false"] })).toBe(
      false,
    );
    expect(opensLayer(null)).toBe(false);
  });

  it("a Close inside a dialog matches only the Close inside the same opener's dialog", () => {
    const close = {
      tag: "BUTTON",
      role: "button",
      name: "Close",
      text: "Close",
      href: null,
      testId: null,
    };
    const inside = { ...close, via: "BUTTON:Watch the demo" };
    expect(matchAnchor(inside, [close])).toBe(-1);
    expect(matchAnchor(inside, [close, inside])).toBe(1);
    expect(matchAnchor(close, [inside])).toBe(-1);
  });
});

describe("state-capture: the trigger, the items' hover, and the page around the panel", () => {
  it("a chevron that no longer turns is a trigger-style finding", () => {
    const findings = diffStateStyles(
      "BUTTON:Does it heat milk?",
      { "icon 1 transform": "matrix(-1, 0, 0, -1, 0, 0) none" },
      { "icon 1 transform": "none none" },
      { kind: "trigger-style", what: "the trigger's " },
    ) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("trigger-style");
    expect(findings[0].message).toMatch(/the trigger's icon 1 transform/);
  });

  it("an item that lost its hover highlight is an item-style finding naming the state", () => {
    const states = (bg: string) => ({
      "A:Pitchers": {
        hover: { "background-color": bg },
        "focus-visible": { "background-color": "rgba(0, 0, 0, 0)" },
      },
    });
    const findings = diffItemStates(
      "BUTTON:Shop",
      states("rgb(238, 242, 251)"),
      states("rgba(0, 0, 0, 0)"),
    ) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/A:Pitchers \(hover\)/);
    expect(diffItemStates("x", states("a"), null)).toEqual([]);
  });

  it("a missing scrim is a viewport finding; a small brightness change is not", () => {
    expect(diffDim("BUTTON:Products", 0.58, 1)).toHaveLength(1);
    expect((diffDim("BUTTON:Products", 0.58, 1)[0] as Finding).message).toMatch(
      /58%.*100%.*production dims it/,
    );
    expect(diffDim("BUTTON:Products", 0.97, 1)).toEqual([]);
    expect(diffDim("BUTTON:Products", null, 1)).toEqual([]);
  });
});

describe("production-defects: icon rows beside text labels, and stretched inline svg", () => {
  const snapshot = (over = {}) => ({
    route: "/",
    width: 1280,
    height: 800,
    images: [],
    iconRows: [],
    texts: [],
    page: { scrollWidth: 1280, clientWidth: 1280 },
    ...over,
  });

  it("an icon 10 px off its paragraph's center is misaligned", () => {
    const defects = detectDefects(
      snapshot({
        iconRows: [
          {
            key: "P:Spare whisk",
            selector: "li",
            icon: rect(0, 24, 20, 20),
            label: rect(30, 10, 200, 28),
            line: rect(30, 10, 200, 28),
          },
        ],
      }),
    ) as Finding[];
    expect(defects.map((d) => d.kind)).toEqual(["icon-misaligned"]);
    expect(defects[0].message).toMatch(/10 px/);
  });

  it("an icon aligned with the first line of a label that wraps is fine", () => {
    expect(
      detectDefects(
        snapshot({
          iconRows: [
            {
              key: "P:A long feature description",
              selector: "li",
              icon: rect(0, 14, 20, 20),
              label: rect(30, 10, 200, 56),
              line: rect(30, 10, 200, 28),
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("an inline svg with preserveAspectRatio none drawn off its viewBox ratio is squished, and says why", () => {
    const [d] = detectDefects(
      snapshot({
        images: [
          {
            key: "SVG:Milk frother logo",
            selector: "svg",
            natural: { width: 120, height: 40 },
            rendered: { width: 240, height: 40 },
            objectFit: "fill",
            source: "viewBox",
          },
        ],
      }),
    ) as Finding[];
    expect(d.kind).toBe("squished");
    expect(d.message).toMatch(/viewBox is 3:1.*preserveAspectRatio is none/);
  });
});

describe("presence-by-route: placement and a dismissal that does not survive a new tab", () => {
  const snap = (state: string, items: unknown[], route = "/") => ({
    route,
    width: 1280,
    state,
    items,
  });
  const banner = (dock: string) => ({
    key: "dialog:Cookie preferences",
    reasons: ["fixed", "dialog"],
    dock,
  });

  it("a banner docked at the top instead of the bottom is a placement finding, once", () => {
    const findings = diffPresence(
      [snap("fresh", [banner("bottom-center")])],
      [snap("fresh", [banner("top-center")])],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["placement"]);
    expect(findings[0].message).toMatch(/bottom-center.*top-center/);
  });

  it("a banner that comes back in a new tab on the target only names sessionStorage", () => {
    const findings = diffPresence(
      [
        snap("fresh", [banner("bottom-center")]),
        snap("dismissed", []),
        snap("new-tab", []),
      ],
      [
        snap("fresh", [banner("bottom-center")]),
        snap("dismissed", []),
        snap("new-tab", [banner("bottom-center")]),
      ],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["trigger"]);
    expect(findings[0].message).toMatch(/new tab.*sessionStorage/);
  });

  it("an older inventory without a new-tab state is an error that names the state, never a pass", () => {
    expect(() =>
      diffPresence([snap("new-tab", [])], [snap("fresh", [])]),
    ).toThrow(/"new-tab" inventory/);
  });
});

describe("testid-carryover: duplicated hooks and hooks on the wrong element", () => {
  const hook = (tag: string, text: string, index = 0) => ({
    attr: "data-testid",
    value: "newsletter-email",
    anchor: { tag, role: null, name: text, text, index },
  });

  it("a hook on two elements on the target, one in production, is duplicated", () => {
    const findings = diffHooks(
      [hook("INPUT", "")],
      [hook("LABEL", "Email"), hook("INPUT", "")],
    ) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["duplicated"]);
    expect(findings[0].message).toMatch(/2 elements.*strict/);
  });

  it("records the element a source hook sits on, as written", () => {
    const [h] = collectSourceHooks(
      '<button data-testid="video-modal-close" onClick={onClose}>Close</button>',
      "src/VideoModal.jsx",
    );
    expect(h).toMatchObject({ tag: "button", text: "Close" });
    const [c] = collectSourceHooks(
      '<Button data-testid="buy">Buy</Button>',
      "src/Buy.jsx",
    );
    expect(c.tag).toBe("Button");
  });

  it("a legacy hook that renders only on demand, on another kind of element on the target, is wrong-element", () => {
    const legacy = collectSourceHooks(
      '<button data-testid="video-modal-close">Close</button>',
      "src/VideoModal.jsx",
    );
    const target = collectSourceHooks(
      '<h2 data-testid="video-modal-close">Demo</h2>',
      "src/pages/index.html",
    );
    const findings = diffSourceHooks(legacy, target) as Finding[];
    expect(findings.map((f) => f.kind)).toEqual(["wrong-element"]);
    expect(findings[0].message).toMatch(
      /<button> \("Close"\).*<h2> \("Demo"\)/,
    );
    expect(
      diffSourceHooks(
        legacy,
        collectSourceHooks(
          '<button data-testid="video-modal-close">Close</button>',
          "x.html",
        ),
      ),
    ).toEqual([]);
  });

  it("a legacy component tag (Button) is not compared with the HTML the target renders", () => {
    const legacy = collectSourceHooks(
      '<Button data-testid="buy">Buy</Button>',
      "src/Buy.jsx",
    );
    const target = collectSourceHooks(
      '<a data-testid="buy">Buy</a>',
      "src/pages/index.html",
    );
    expect(diffSourceHooks(legacy, target)).toEqual([]);
  });
});

describe("testid-coverage: controls in a page <template>", () => {
  it("names each control without a data-testid, with its file, line and text", () => {
    const html = `<main>
<button data-testid="share-open">Share</button>
</main>
<template id="share-tpl"><div role="dialog" aria-label="Share" data-testid="share-dialog">
<button type="button" class="copy">Copy link</button>
<button type="button" data-testid="share-close">Close</button>
<span role="switch" aria-checked="false"></span>
</div></template>`;
    const findings = auditTemplates(html, "src/pages/index.html") as Finding[];
    expect(findings.map((f) => f.message)).toEqual([
      'src/pages/index.html:5: <button> "Copy link" in a <template> needs a data-testid (a script renders it later, so the rendered page never shows it)',
      "src/pages/index.html:7: <span> in a <template> needs a data-testid (a script renders it later, so the rendered page never shows it)",
    ]);
  });

  it("a page without templates has nothing to audit here", () => {
    expect(auditTemplates("<button>Buy</button>", "x.html")).toEqual([]);
  });
});

describe("settle time and crash retries", () => {
  const base = [
    "--prod",
    "https://example.com",
    "--target",
    "http://localhost:8080",
    "--route",
    "/",
  ];

  it("every check waits 5 s after navigation by default, and --settle-ms changes it", () => {
    expect(DEFAULT_SETTLE_MS).toBe(5000);
    expect(parseArgsFor(base).settleMs).toBe(5000);
    expect(parseArgsFor([...base, "--settle-ms", "0"]).settleMs).toBe(0);
    expect(settleOf({})).toBe(5000);
    expect(settleOf({ settleMs: 8000 })).toBe(8000);
    expect(settleOf({ settleMs: -1 })).toBe(5000);
  });

  it("a settle time that is not a number of milliseconds is an error naming the flag", () => {
    expect(() => parseArgsFor([...base, "--settle-ms", "5s"])).toThrow(
      /--settle-ms must be a number of milliseconds/,
    );
    expect(() =>
      parseRunChecks([...base, "--legacy-src", "x", "--settle-ms", "-1"]),
    ).toThrow(/--settle-ms/);
    expect(
      parseRunChecks([...base, "--legacy-src", "x", "--settle-ms", "7000"])
        .settleMs,
    ).toBe(7000);
  });

  it("a navigation timeout is transient; a bug in a check is not", () => {
    expect(isTransient(new Error("page.goto: Timeout 30000ms exceeded."))).toBe(
      true,
    );
    expect(isTransient(new Error("net::ERR_CONNECTION_RESET at /"))).toBe(true);
    expect(isTransient(new TypeError("x is not a function"))).toBe(false);
  });

  const flaky = (errors: Error[]) => {
    let calls = 0;
    return {
      CHECK: "spacing-diff",
      calls: () => calls,
      runCheck: async () => {
        calls++;
        const e = errors.shift();
        if (e) throw e;
        return { check: "spacing-diff", ok: true, findings: [] };
      },
    };
  };

  it("one transient crash is retried and the result says so", async () => {
    const mod = flaky([new Error("page.goto: Timeout 30000ms exceeded.")]);
    const r = await runOne("spacing-diff", null, {}, [mod]);
    expect(mod.calls()).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.retried).toMatch(/crashed once and was run again.*Timeout/);
  });

  it("a second crash, or a crash that is not transient, is the error", async () => {
    const twice = flaky([
      new Error("page.goto: Timeout 30000ms exceeded."),
      new Error("page.goto: Timeout 30000ms exceeded."),
    ]);
    const r = await runOne("spacing-diff", null, {}, [twice]);
    expect(twice.calls()).toBe(2);
    expect(r.error).toMatch(/spacing-diff crashed: page.goto: Timeout/);
    const bug = flaky([new TypeError("x is not a function")]);
    const b = await runOne("spacing-diff", null, {}, [bug]);
    expect(bug.calls()).toBe(1);
    expect(b.error).toMatch(/x is not a function/);
    expect(b.retried).toBeUndefined();
  });
});
