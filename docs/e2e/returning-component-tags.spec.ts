/**
 * The "Returning component tags" demo boxes in the browser.
 *
 * - /server-scripts#render-a-card-per-search-result: the Preview shows three product cards, expanded by the docs
 *   site's own static build and styled by the component's scoped CSS; Save toggles one card only; the Source tabs
 *   switch between the page with its server script and the component's HTML, CSS and JS; the Output shows the
 *   request-time HTML (one <style> before the first card, request-time ids) with the same cards as the Preview.
 * - /server-scripts#a-card-with-its-own-server-script: no Preview (the stock line exists only per request), Output
 *   shows the nested script's line.
 * - /stream-scripts#stream-cards-in-batches: three cards in the Preview, one <style> in the Output.
 * - /testing/troubleshooting: the pass-through demo has no Preview and shows the misspelled and escaped tags as sent.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

/** The first demo box after the heading with `id`. */
const boxAfter = (page: Page, id: string): Locator =>
  page.locator(`#${id} ~ *:has([data-testid="demo-pane-code"])`).first();

/** A request-time id (`r` + 7 hex digits, letters only allowed) where Bascik writes one: `bascik__<component>__<id>__`. */
const REQUEST_ID = /(?<=\bbascik__[a-z][a-z0-9-]*__)r[0-9a-f]{7}(?=__)/g;

/** At desktop width the Preview's cards sit side by side: the grid fills the pane and has more than one column. */
const expectMultiColumnGrid = async (preview: Locator) => {
  const layout = await preview
    .getByTestId("product-card")
    .first()
    .evaluate((card) => {
      const grid = card.parentElement!;
      const pane = grid.parentElement!;
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        gridWidth: grid.getBoundingClientRect().width,
        paneWidth: pane.getBoundingClientRect().width,
      };
    });
  expect(layout.columns).toBeGreaterThan(1);
  expect(layout.gridWidth).toBeGreaterThan(layout.paneWidth * 0.9);
};

/** The source text in a pane's language tab (textContent, so it does not depend on which tab is showing). */
const paneText = async (pane: Locator, language: string): Promise<string> =>
  (await pane
    .locator(`[data-language-pane="${language}"]`)
    .first()
    .textContent()) ?? "";

/** Card names in Output HTML text, in order. */
const outputNames = (html: string): string[] =>
  [...html.matchAll(/<h3\b[^>]*>\s*([^<]+?)\s*<\/h3>/g)].map((m) => m[1]);

test.describe("Returning component tags demos", () => {
  test("search demo: Preview renders three scoped cards and Save toggles one", async ({
    page,
  }) => {
    await page.goto("/server-scripts");
    const box = boxAfter(page, "render-a-card-per-search-result");
    await expect(box).toBeVisible();

    const preview = box.getByTestId("demo-pane-preview");
    await expect(preview).toBeVisible();
    const cards = preview.getByTestId("product-card");
    await expect(cards).toHaveCount(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectMultiColumnGrid(preview);
    await expect(cards.nth(0)).toContainText("Milk frother");
    await expect(cards.nth(0)).toContainText("$129");
    await expect(cards.nth(0)).toContainText("Best seller");
    await expect(cards.nth(2)).toContainText("Glass carafe");
    await expect(cards.nth(2)).toContainText("Standard");

    // The component's CSS is applied, through a scoped class.
    const first = cards.nth(0);
    expect(await first.getAttribute("class")).not.toBe("card");
    const style = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopStyle, background: s.backgroundColor };
    });
    expect(
      style.border !== "none" || style.background !== "rgba(0, 0, 0, 0)",
    ).toBe(true);

    // The client script runs per instance: Save in one card leaves the others alone.
    const save = first.getByTestId("product-card-save");
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await save.click();
    await expect(save).toHaveAttribute("aria-pressed", "true");
    await expect(save).toHaveText("Saved");
    await expect(cards.nth(1).getByTestId("product-card-save")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("search demo: Source tabs switch between the page and the component files", async ({
    page,
  }) => {
    await page.goto("/server-scripts");
    const box = boxAfter(page, "render-a-card-per-search-result");
    await box.getByTestId("demo-tab-code").click();
    const code = box.getByTestId("demo-pane-code");
    await expect(code).toBeVisible();

    const visibleLanguage = (language: string) =>
      code.locator(`[data-language-pane="${language}"]`).first();
    await code.locator('[data-language="usage"]').first().click();
    await expect(visibleLanguage("usage")).toBeVisible();
    await expect(visibleLanguage("usage")).toContainText("data-bascik-server");
    await expect(visibleLanguage("usage")).toContainText("products.map");

    await code.locator('[data-language="html"]').first().click();
    await expect(visibleLanguage("html")).toBeVisible();
    await expect(visibleLanguage("html")).toContainText(
      "data-bascik-prop-name",
    );
    await expect(visibleLanguage("usage")).toBeHidden();

    await code.locator('[data-language="css"]').first().click();
    await expect(visibleLanguage("css")).toBeVisible();
    await expect(visibleLanguage("css")).toContainText(".card");

    await code.locator('[data-language="js"]').first().click();
    await expect(visibleLanguage("js")).toBeVisible();
    await expect(visibleLanguage("js")).toContainText('closest(".save")');
  });

  test("search demo: Output shows the request-time HTML with the Preview's cards", async ({
    page,
  }) => {
    await page.goto("/server-scripts");
    const box = boxAfter(page, "render-a-card-per-search-result");
    await box.getByTestId("demo-tab-output").click();
    const output = box.getByTestId("demo-pane-output");
    await expect(output).toBeVisible();
    await expect(output).toContainText("<style>");

    const html = await paneText(output, "html");
    expect(html.indexOf("<style")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("<style")).toBeLessThan(html.indexOf("<article"));
    expect(html).not.toContain("<product-card");
    // The card's script has no scoped id, so no request-time id is sent and
    // the three copies of the script are identical (one CSP hash).
    expect(html.match(REQUEST_ID) ?? []).toEqual([]);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    );
    expect(scripts).toHaveLength(3);
    expect(new Set(scripts).size).toBe(1);

    const previewNames = await box
      .getByTestId("demo-pane-preview")
      .getByTestId("product-card")
      .locator("h3")
      .allTextContents();
    expect(outputNames(html)).toEqual(previewNames.map((n) => n.trim()));
  });

  test("nested script demo: no Preview tab, Output shows the stock line", async ({
    page,
  }) => {
    await page.goto("/server-scripts");
    const box = boxAfter(page, "a-card-with-its-own-server-script");
    await expect(box).toBeVisible();
    await expect(box.getByTestId("demo-tab-preview")).toBeHidden();
    await box.getByTestId("demo-tab-output").click();
    const output = box.getByTestId("demo-pane-output");
    await expect(output).toBeVisible();
    await expect(output).toContainText("In stock");
    expect(await paneText(output, "html")).not.toContain("<stock-line");
  });

  test("stream demo: Preview has three cards, Output has one <style>", async ({
    page,
  }) => {
    await page.goto("/stream-scripts");
    const box = boxAfter(page, "stream-cards-in-batches");
    await expect(box).toBeVisible();
    await expect(
      box.getByTestId("demo-pane-preview").getByTestId("product-card"),
    ).toHaveCount(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectMultiColumnGrid(box.getByTestId("demo-pane-preview"));
    await box.getByTestId("demo-tab-output").click();
    const html = await paneText(box.getByTestId("demo-pane-output"), "html");
    expect(html.match(/<style\b/g) ?? []).toHaveLength(1);
    expect(html.indexOf("<style")).toBeLessThan(html.indexOf("<article"));
  });

  test("pass-through demo: no Preview, Output shows the misspelled and escaped tags as sent", async ({
    page,
  }) => {
    await page.goto("/testing/troubleshooting");
    const box = boxAfter(
      page,
      "a-component-tag-in-script-output-reaches-the-browser-as-written",
    );
    await expect(box).toBeVisible();
    await expect(box.getByTestId("demo-tab-preview")).toBeHidden();
    await box.getByTestId("demo-tab-output").click();
    const output = box.getByTestId("demo-pane-output");
    await expect(output).toBeVisible();
    const html = await paneText(output, "html");
    expect(html).toContain("<prodcut-card");
    expect(html).toContain("&lt;product-card");
    expect(html).not.toContain("<style");
  });
});
