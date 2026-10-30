import { describe, it, expect } from "vitest";
import { expandComponents } from "./component-expansion-core.ts";
import {
  SCAN_BUDGET,
  __scanBudgetStatsForTests,
  withScanBudget,
} from "./component-scan-budget.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
} from "./linear-time.test-helper.ts";
import type { ComponentList } from "./types.ts";

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
    // `<a ` with no `>` before the next `<x-p>` would make every later
    // `<x-p>` part of that tag's attributes, as a browser reads it (one
    // usage, not 999): each `<a>` here is a whole tag.
    [
      "<my-card> + fill('<x-p><a>') + </x-pa></my-card>",
      (size) => `<my-card>${fill("<x-p><a>", size)}</x-pa></my-card>`,
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
  const budgetFor = (html: string): number =>
    SCAN_BUDGET.perOutputChar * html.length + SCAN_BUDGET.base;
  const expandWithin = (html: string): string =>
    withScanBudget(budgetFor(html), () => expand(html));

  it.each(shapes)(
    "%s renders every usage within a quarter of the scan budget, in linear time",
    (label, make) => {
      const html = make(1_000_000);
      const out = expandWithin(html);
      expect(out.split(">v</p>").length - 1).toBe(999);
      expect(
        __scanBudgetStatsForTests.lastSpent / budgetFor(html),
      ).toBeLessThan(0.25);
      // Fixed millisecond bounds here (1500 ms at 200k, 3000 ms at 1M) flaked
      // on shared CI runners under coverage. Every size renders the same 999
      // usages, so their cost is measured as a baseline (no padding) and the
      // growth is taken over it: the re-mask per usage this guards against
      // grows with the padding and reads about 16.
      // The scan budget above bounds the work on any machine; the default
      // 2 s ceiling on a 1M-character run is a machine bound, which CI's
      // Linux runner under coverage passed at 2.26 s.
      expectLinearTime(make, 1_000_000, expandWithin, {
        label,
        baseline: make(0),
        ceilingMs: 10_000,
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "a raw-text opener that a later closer ends falls back, but each splice re-reads only the text since the last one",
    () => {
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
    },
    // Byte counts, not time, but a 200k-character page under coverage on a
    // loaded runner passed the 5 s default (Collin's coverage:all, 2026-10-30).
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "finds each name's closes once and reads each splice's window once, however many components there are",
    () => {
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
      expect(
        __componentScanStatsForTests.closeFactBytesScanned,
      ).toBeGreaterThan(0);
      expect(__componentScanStatsForTests.closeFactBytesScanned).toBeLessThan(
        8 * html.length,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
