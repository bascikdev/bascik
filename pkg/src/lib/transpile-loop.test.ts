import { describe, it, expect, vi } from "vitest";
import { recursivelyTranspile } from "./processing.ts";
import { expandComponents } from "./component-expansion-core.ts";
import {
  SCAN_BUDGET,
  __scanBudgetStatsForTests,
  withScanBudget,
} from "./component-scan-budget.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import * as componentsModule from "./components.ts";
import type { ComponentList } from "./types.ts";
import {
  isFlatString,
  makeConsString,
  stringFlatnessProbeSkipReason,
  stringFlatnessProbeSupported,
} from "./string-flatness-probe.test-helper.ts";

// WHY: the %StringIsFlat intrinsic exists from V8 13.6 (Node 24.0.0). Node 22.x
// ships V8 12.4, so this block skips there instead of failing to load.
describe.skipIf(!stringFlatnessProbeSupported)(
  `Prompt 85: recursivelyTranspile returns a flat V8 string${stringFlatnessProbeSupported ? "" : ` (skipped: ${stringFlatnessProbeSkipReason})`}`,
  () => {
    it("probe sanity: the splice loop shape used by replaceTag really produces a cons string", () => {
      const cons = makeConsString("<p>x</p>".repeat(2000), 200);
      expect(isFlatString(cons)).toBe(false);
    });

    it("hundreds of sequential and nested substitutions return a flat string, not a cons tree", () => {
      const componentList: ComponentList = {
        "item-card": {
          fileContent: `<div class="card"><inner-badge></inner-badge><p data-bascik-prop-title></p></div>`,
        },
        "inner-badge": {
          fileContent: `<span class="badge">new</span>`,
        },
      };
      const body = Array.from(
        { length: 300 },
        (_, i) => `<item-card title="Item ${i}"></item-card>`,
      ).join("\n");

      const result = recursivelyTranspile(body, componentList);
      expect(result.usedComponents).toHaveLength(600);
      expect(isFlatString(result.transpiledHtmlBody)).toBe(true);
    });
  },
);

describe("Prompt 34: Transpile loop performance & operation count guard", () => {
  it("bounds full-document scanning operations linearly with component instances", () => {
    let maskCallsOnDocument = 0;
    const origMask = componentsModule.maskRawTextContent;
    const maskSpy = vi
      .spyOn(componentsModule, "maskRawTextContent")
      .mockImplementation((str) => {
        if (str.length > 500) {
          maskCallsOnDocument++;
        }
        return origMask(str);
      });

    const componentList: ComponentList = {
      "item-card": {
        fileContent: `<div class="card"><p data-bascik-prop-title></p></div>`,
        cssFileContent: ".card { padding: 1rem; }",
      },
    };

    // Construct a page with 300 instances
    const instanceCount = 300;
    const body = Array.from(
      { length: instanceCount },
      (_, i) => `<item-card title="Item ${i}"></item-card>`,
    ).join("\n");

    const result = recursivelyTranspile(body, componentList);
    expect(result.transpiledHtmlBody).toContain(
      'class="bascik__item-card__card',
    );
    expect(result.usedComponents).toHaveLength(instanceCount);

    // Initial mask on full document = 1 call. Incremental splice avoids 300 full document re-masks.
    expect(maskCallsOnDocument).toBeLessThanOrEqual(5);

    maskSpy.mockRestore();
  });

  it("Prompt 63: component discovery examines a linear number of unchanged-prefix bytes (cursor, not offset zero)", () => {
    const componentList: ComponentList = {
      "item-card": {
        fileContent: `<div class="card"><p data-bascik-prop-title></p></div>`,
      },
    };
    const page = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `<item-card title="Item ${i}"></item-card>`,
      ).join("\n");

    const examined = (n: number): number => {
      componentsModule.__componentScanStatsForTests.reset();
      const result = recursivelyTranspile(page(n), componentList);
      expect(result.usedComponents).toHaveLength(n);
      return componentsModule.__componentScanStatsForTests.prefixBytesExamined;
    };

    const atN = examined(400);
    const at2N = examined(800);
    // Each search that restarts at offset zero re-reads the whole resolved
    // prefix, giving ~4x at 2N. A cursor that resumes at the replacement start
    // reads each byte a bounded number of times, giving ~2x.
    expect(at2N / atN).toBeLessThan(2.5);
  });

  it("attribute-value checks scan a linear number of bytes as instances grow", () => {
    const componentList: ComponentList = {
      "item-card": {
        fileContent: `<div class="card"><p data-bascik-prop-title></p></div>`,
      },
      "outer-card": {
        fileContent: `<section class="outer"><div data-bascik-slot></div></section>`,
      },
    };
    const page = (n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          `<outer-card><item-card title="Item ${i}"></item-card></outer-card>`,
      ).join("\n");

    const scanned = (n: number): number => {
      componentsModule.__componentScanStatsForTests.reset();
      const result = recursivelyTranspile(page(n), componentList);
      expect(result.usedComponents).toHaveLength(2 * n);
      return componentsModule.__componentScanStatsForTests
        .attributeValueBytesScanned;
    };

    const atN = scanned(300);
    const at2N = scanned(600);
    // Restarting each check at offset zero re-reads the resolved prefix: ~4x at 2N.
    expect(at2N / atN).toBeLessThan(2.5);
  });

  it("checks each inserted template for mask closure once, not again as the next sibling's prefix", () => {
    const componentList: ComponentList = {
      "code-card": {
        fileContent: `<div class="card"><script>${"run();".repeat(200)}</script><p>body</p></div>`,
      },
    };
    const body = Array.from(
      { length: 200 },
      () => `<code-card></code-card>`,
    ).join("\n");
    componentsModule.__componentScanStatsForTests.reset();
    const result = recursivelyTranspile(body, componentList);
    expect(result.usedComponents).toHaveLength(200);
    const checked =
      componentsModule.__componentScanStatsForTests.closureBytesChecked;
    // Re-verifying the previous template as the next prefix doubles this.
    expect(checked).toBeLessThan(1.5 * result.transpiledHtmlBody.length);
  });

  it("falsification check: re-masks properly when a component introduces raw text tags (<script>/<style>/comments)", () => {
    const componentList: ComponentList = {
      "code-viewer": {
        fileContent: `<div class="box"><script>const x = '<fake-comp></fake-comp>';</script><p>Text</p></div>`,
      },
      "fake-comp": {
        fileContent: `<span class="fake">Should not be resolved inside script</span>`,
      },
      "item-card": {
        fileContent: `<div class="card"><code-viewer></code-viewer></div>`,
      },
    };

    const body = `<item-card></item-card>`;
    const result = recursivelyTranspile(body, componentList);
    expect(result.transpiledHtmlBody).toContain(
      "const x = '<fake-comp></fake-comp>';",
    );
    expect(result.transpiledHtmlBody).not.toContain(
      "Should not be resolved inside script",
    );
  });
});

describe("an unclosed usage after the last close of its name", () => {
  // The loop knows where the last `</name` of each component name is and
  // moves it with each splice, so an unclosed usage after it skips the walk
  // to the end of the page. A close a later template brings in must still
  // pair the usages before it, as the walk did (outputs as before).
  const componentList: ComponentList = {
    "x-p": { fileContent: `<p class="p">v</p>` },
    "m-card": {
      fileContent: `<div class="m"><div data-bascik-slot></div></div></x-p>`,
    },
    "u-card": { fileContent: `<u>close: </X-P ></u>` },
  };
  const expand = (html: string): string =>
    expandComponents(html, componentList, {
      instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
      mintId: (name, ordinal) => `${name}${ordinal}`,
      scope: (component) => component,
      injectAttrProps: "before-scope",
      numberSourceUrls: false,
      inheritAttributes: false,
      limits: { maxSubstitutions: 100, maxOutputBytes: 1 << 20 },
      onError: (_component, _stage, error) => {
        throw error;
      },
      warn: () => {},
    }).transpiledHtmlBody;

  it.each([
    [
      "<x-p>1<m-card><x-p>2</m-card>3",
      '<p class="p">v</p>1<div class="m"><p class="p">v</p>3',
    ],
    [
      "<x-p>1<u-card></u-card><x-p>2<u-card></u-card>",
      '<p class="p">v</p>1<u>close: </X-P ></u><p class="p">v</p>2<u>close: </X-P ></u>',
    ],
    [
      "<m-card><x-p>a<x-p>b</m-card><x-p>c",
      '<div class="m"><p class="p">v</p>a<p class="p">v</p><p class="p">v</p>c',
    ],
    [
      "<x-p>a<m-card><x-p>b<u-card></u-card></m-card>",
      '<p class="p">v</p>a<div class="m"><p class="p">v</p>',
    ],
  ])("%s", (html, expected) => {
    expect(expand(html)).toBe(expected);
  });
});

describe("close and closer look-alikes keep unclosed usages linear", () => {
  // Text that only looks like a close of the usages (a longer name, a close
  // the mask blanks) or like the closer of a raw-text element opened before
  // them (`</style-box>` after `<style-box>`, `</textareax>`). None ends
  // anything, so none may bring back a walk to the end of the page for each
  // unclosed usage, or a whole re-mask after each splice: both are charged
  // to the request-time scan budget, which these must stay far under.
  const componentList: ComponentList = {
    "my-card": {
      fileName: "my-card.html",
      fileContent: `<div class="c"><div data-bascik-slot>s</div></div>`,
    },
    "x-p": {
      fileName: "x-p.html",
      fileContent: `<p class="p" data-bascik-prop-v>v</p>`,
    },
  };
  const expand = (html: string, list: ComponentList = componentList) =>
    expandComponents(html, list, {
      instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
      mintId: (name, ordinal) => `${name}${ordinal}`,
      scope: (component) => component,
      injectAttrProps: "before-scope",
      numberSourceUrls: false,
      inheritAttributes: false,
      limits: { maxSubstitutions: 2000, maxOutputBytes: 1 << 30 },
      onError: (_component, _stage, error) => {
        throw error;
      },
      warn: () => {},
    }).transpiledHtmlBody;
  /** 999 copies of `unit`, padded with text to `size` characters in all. */
  const fill = (unit: string, size: number): string =>
    (
      unit + "x".repeat(Math.max(0, Math.ceil(size / 999) - unit.length))
    ).repeat(999);
  const shapes: Array<[string, (size: number) => string]> = [
    [
      "<my-card> + fill('<x-p><a ') + </x-pa></my-card>",
      (size) => `<my-card>${fill("<x-p><a ", size)}</x-pa></my-card>`,
    ],
    [
      "fill('<x-p>') + </x-p-list>",
      (size) => `${fill("<x-p>", size)}</x-p-list>`,
    ],
    [
      "fill('<x-p>') + <!-- </x-p> -->",
      (size) => `${fill("<x-p>", size)}<!-- </x-p> -->`,
    ],
    [
      "fill('<x-p>') + <script></x-p></script>",
      (size) => `${fill("<x-p>", size)}<script></x-p></script>`,
    ],
    [
      "<style-box>hi</style-box> + fill('<x-p v=\"a\"></x-p>')",
      (size) => `<style-box>hi</style-box>${fill('<x-p v="a"></x-p>', size)}`,
    ],
    [
      "<script-x></script-x> + fill('<x-p></x-p>')",
      (size) => `<script-x></script-x>${fill("<x-p></x-p>", size)}`,
    ],
    [
      "<textarea-field></textarea-field> + fill('<x-p>')",
      (size) => `<textarea-field></textarea-field>${fill("<x-p>", size)}`,
    ],
    [
      "<style-box>hi</style-box> + fill('<x-p>')",
      (size) => `<style-box>hi</style-box>${fill("<x-p>", size)}`,
    ],
    [
      "<my-card><textarea> + fill('<x-p>') + </textareax></my-card>",
      (size) =>
        `<my-card><textarea>${fill("<x-p>", size)}</textareax></my-card>`,
    ],
  ];
  it.each(
    shapes.flatMap(([label, make]) => [
      [label, "200k", make(200_000), 1500],
      [label, "1M", make(1_000_000), 3000],
    ]),
  )("%s at %s characters", (_label, _size, html, bound) => {
    const budget =
      SCAN_BUDGET.perOutputChar * (html as string).length + SCAN_BUDGET.base;
    const started = performance.now();
    const out = withScanBudget(budget, () => expand(html as string));
    const elapsed = performance.now() - started;
    expect(out.split(">v</p>").length - 1).toBe(999);
    expect(__scanBudgetStatsForTests.lastSpent / budget).toBeLessThan(0.25);
    expect(elapsed).toBeLessThan(bound as number);
  });

  it("a raw-text opener that a later closer ends falls back, but each splice re-reads only the text since the last one", () => {
    // `<textarea a"b>` is no element while no `"` follows to end what its
    // opener reads as a quoted value, but a template with one could make it
    // one, so every splice falls back to a whole re-mask (charged). The
    // masker's state at each splice is kept, so the next one does not re-read
    // the page from the start.
    const list: ComponentList = { "x-q": { fileContent: "<i>v</i>" } };
    const html = `<textarea a"b>${fill("<x-q></x-q>", 200_000)}</textarea>`;
    __componentScanStatsForTests.reset();
    const out = expand(html, list);
    expect(out.split("<i>v</i>").length - 1).toBe(999);
    expect(__componentScanStatsForTests.closureBytesChecked).toBeLessThan(
      4 * html.length,
    );
  });

  it("finds each name's closes once and reads each splice's window once, however many components there are", () => {
    // 300 components, each used once at the start, then three wrappers
    // around 200k characters. The close facts are kept for every name, but
    // found in one pass and moved with one pass over each splice's window.
    const list: ComponentList = { ...componentList };
    let head = "";
    for (let index = 0; index < 300; index++) {
      list[`c-${index}`] = { fileContent: `<b>${index}</b>` };
      head += `<c-${index}></c-${index}>`;
    }
    const html = `${head}<my-card><my-card><my-card>${"z".repeat(200_000)}</my-card></my-card></my-card>`;
    __componentScanStatsForTests.reset();
    const out = expand(html, list);
    expect(out.split('<div class="c">').length - 1).toBe(3);
    expect(__componentScanStatsForTests.closeFactBytesScanned).toBeGreaterThan(
      0,
    );
    expect(__componentScanStatsForTests.closeFactBytesScanned).toBeLessThan(
      8 * html.length,
    );
  });
});

describe("close facts across a white-space run at a splice seam", () => {
  // A close can be `</x-p` and a long run of white space before its `>`, and
  // a splice can complete it: the facts must see it, wherever the run is.
  const componentList: ComponentList = {
    "x-p": { fileContent: `<p class="p">v</p>` },
    "g-t": { fileContent: `<x-p>c</x-p` },
    "c-t": { fileContent: `<i>x</i>` },
  };
  const expand = (html: string): string =>
    expandComponents(html, componentList, {
      instanceState: { ordinalMap: new Map(), issuedIds: new Set() },
      mintId: (name, ordinal) => `${name}${ordinal}`,
      scope: (component) => component,
      injectAttrProps: "before-scope",
      numberSourceUrls: false,
      inheritAttributes: false,
      limits: { maxSubstitutions: 100, maxOutputBytes: 1 << 20 },
      onError: (_component, _stage, error) => {
        throw error;
      },
      warn: () => {},
    }).transpiledHtmlBody;

  it.each([10, 3000, 5000])(
    "a template ending in `</x-p` closes its usage through %i spaces after it",
    (spaces) => {
      const html = `<g-t></g-t>${" ".repeat(spaces)}>after`;
      expect(expand(html)).toBe(`<p class="p">v</p>after`);
    },
  );
});
