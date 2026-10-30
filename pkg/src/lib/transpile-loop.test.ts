import { describe, it, expect, vi } from "vitest";
import { recursivelyTranspile } from "./processing.ts";
import { expandComponents } from "./component-expansion-core.ts";
import { __scanBudgetStatsForTests } from "./component-scan-budget.ts";
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
