/**
 * production-defects' corrections against the keys the parity checks write, in a real browser: a defect is keyed by
 * the page helper textKey ("TAG:text", cut after 80 visible characters), and a parity finding on the same element must
 * carry the same key, or applyCorrections never moves it to `corrected` and run-checks fails the route on a difference
 * the decisions ledger already explains.
 *
 * Why: spacing-diff keyed its blocks at 40 characters, so every heading longer than that missed its correction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import { inPage } from "../../skills/bascik-refactor/scripts/lib/dom.mjs";
import {
  applyCorrections,
  detectDefects,
  measureDefects,
  settleAnimations,
} from "../../skills/bascik-refactor/scripts/production-defects.mjs";
import { measureSections } from "../../skills/bascik-refactor/scripts/spacing-diff.mjs";
import { packageDir } from "./refactor-parity-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the project's Playwright, loaded at run time
let browser: any;

beforeAll(async () => {
  const { chromium } = await loadPlaywright({ cwd: packageDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const HEADING =
  "Why teams switch to the Milk frother for their morning routine";

describe("a spacing-diff finding on an element production got wrong", () => {
  it("carries the defect's key when the text is longer than 40 characters, so it is corrected", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      await page.setContent(
        `<main><section><h2>${HEADING}</h2><p>Silky milk in thirty seconds.</p></section></main>`,
      );
      const defectKey: string = await inPage(
        page,
        `function () { return textKey(document.querySelector("h2")); }`,
      );
      expect(defectKey).toBe(`H2:${HEADING}`);
      const sections: Array<{ key: string; children: Array<{ key: string }> }> =
        await inPage(page, measureSections, { masks: [] });
      const keys = sections.flatMap((s) => s.children.map((c) => c.key));
      expect(keys).toContain(defectKey);
      const finding = {
        check: "spacing-diff",
        kind: "height",
        route: "/",
        width: 1280,
        section: sections[0].key,
        key: defectKey,
        message: "taller on the target",
      };
      const { kept, corrected } = applyCorrections(
        [finding],
        [
          {
            check: "production-defects",
            kind: "icon-misaligned",
            route: "/",
            width: 1280,
            key: defectKey,
          },
        ],
      );
      expect(kept).toEqual([]);
      expect(corrected).toEqual([finding]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

/** Measures one page the way production-defects does (animations settled first) and returns its defects. */
async function defectsOf(
  html: string,
  { width = 400, masks = [] as string[], reducedMotion = "no-preference" } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await inPage(page, settleAnimations, { masks });
    const snap = await inPage(page, measureDefects, { masks });
    return detectDefects({ route: "/", width, height: 800, ...snap });
  } finally {
    await context.close();
  }
}

const kindsOf = (defects: Array<{ kind: string; key?: string }>) =>
  defects.map((d) => `${d.kind} ${d.key}`);

describe("production-defects in a real browser: the false positives found in trials", () => {
  it("a two-line logotype at line-height 0.9 is not text overflow", async () => {
    const defects = await defectsOf(
      `<header><div style="display:flex"><span style="font:600 18px sans-serif;line-height:.9">MILK<br>FROTHER</span></div></header>`,
    );
    expect(kindsOf(defects)).toEqual([]);
  }, 60_000);

  it("a display heading whose glyphs pass a tight line-height is not text overflow", async () => {
    const defects = await defectsOf(
      `<main><h2 style="font:30px/26px serif;margin:0;width:300px">Silky milk in thirty seconds</h2></main>`,
    );
    expect(kindsOf(defects)).toEqual([]);
  }, 60_000);

  it("a visually hidden sr-only label is not clipped text", async () => {
    const defects = await defectsOf(
      `<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
       <main><button type="button"><svg width="16" height="16" aria-hidden="true"></svg><span class="sr-only">Toggle theme</span></button><p>Froths in 30 seconds.</p></main>`,
    );
    expect(kindsOf(defects)).toEqual([]);
  }, 60_000);

  it("the back face of a flip card does not overlap its front face", async () => {
    const defects = await defectsOf(
      `<style>.card{position:relative;width:300px;height:120px;transform-style:preserve-3d}
       .face{position:absolute;inset:0;backface-visibility:hidden;text-align:center}.back{transform:rotateY(180deg)}</style>
       <main><div class="card"><div class="face"><p>Froths in 30 seconds</p></div><div class="face back"><p>Wash the jug by hand</p></div></div></main>`,
    );
    expect(kindsOf(defects)).toEqual([]);
  }, 60_000);

  it("a word rising into place on a loop is measured settled, not mid-flight", async () => {
    // A slow rise from far below: unsettled, the paragraph would be over a line taller than its box at any moment.
    const html = `<style>@keyframes rise{from{transform:translateY(60px)}}</style>
      <main><p style="font:30px/40px sans-serif;margin:0;height:40px">We <span style="display:inline-grid;height:40px;vertical-align:middle"><span style="animation:rise 60s infinite">froth</span></span></p></main>`;
    expect(kindsOf(await defectsOf(html))).toEqual([]);
  }, 60_000);

  it("a masked word moved by a script mid-flight never blames its unmasked parent", async () => {
    // A script-driven rise (not a Web Animation, so nothing settles it): the word sits 60 px low when measured.
    const html = `<main><p style="font:30px/40px sans-serif;margin:0;height:40px">We <span class="word" style="display:inline-grid;height:40px;vertical-align:middle"><span style="transform:translateY(60px)">froth</span></span></p></main>`;
    expect(
      (await defectsOf(html)).map((d: { kind: string }) => d.kind),
    ).toEqual(["text-overflow"]);
    expect(kindsOf(await defectsOf(html, { masks: [".word"] }))).toEqual([]);
  }, 60_000);

  it("a masked region does not hide its parent's own overflowing text", async () => {
    const defects = await defectsOf(
      `<main><p style="font:20px/24px sans-serif;margin:0;height:24px;width:200px">Silky milk in thirty seconds, every morning <span class="ticker">live</span></p></main>`,
      { masks: [".ticker"] },
    );
    expect(defects.map((d: { kind: string }) => d.kind)).toEqual([
      "text-overflow",
    ]);
  }, 60_000);

  it("text cut off by overflow hidden is still reported", async () => {
    const defects = await defectsOf(
      `<main><p style="font:20px/24px sans-serif;margin:0;height:24px;width:200px;overflow:hidden">Silky milk in thirty seconds, every morning</p></main>`,
    );
    expect(defects.map((d: { kind: string }) => d.kind)).toEqual([
      "text-clipped",
    ]);
  }, 60_000);
});
