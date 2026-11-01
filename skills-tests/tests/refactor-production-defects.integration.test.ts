/**
 * production-defects' corrections against the keys the parity checks write, in a real browser: a defect is keyed by
 * the page helper textKey ("TAG:text", 70 characters), and a parity finding on the same element must carry the same
 * key, or applyCorrections never moves it to `corrected` and run-checks fails the route on a difference the
 * decisions ledger already explains.
 *
 * Why: spacing-diff keyed its blocks at 40 characters, so every heading longer than that missed its correction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPlaywright } from "../../skills/bascik-refactor/scripts/lib/project-deps.mjs";
import { inPage } from "../../skills/bascik-refactor/scripts/lib/dom.mjs";
import { applyCorrections } from "../../skills/bascik-refactor/scripts/production-defects.mjs";
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
