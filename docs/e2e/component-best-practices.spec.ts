/// <reference lib="dom" />

/**
 * /component-best-practices practices what it teaches, and its live demo Previews behave the way the HTML standard
 * defines, because Bascik ships the element and the `name` you wrote.
 *
 * - Its checklist says a page with more than one <nav> names each one, so the demo Previews must not add a landmark
 *   whose name another landmark already has (the docs header is navigation "Main"; a demo <site-nav aria-label="Main" />
 *   made a second one, which a screen reader's landmark list shows as two identical entries).
 * - Two <format-picker> copies, each with its radios in a form of its own, are two radio groups.
 * - Three <faq-question> copies, each one <details name="faq">, are one exclusive accordion.
 */
import { test, expect } from "@playwright/test";

const LANDMARK =
  /^\s*- (banner|navigation|main|contentinfo|complementary|region|form|search)(?: "([^"]*)")?/;

test.describe("/component-best-practices", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/component-best-practices");
  });

  test("every landmark has a name no other landmark of its role shares", async ({
    page,
  }) => {
    const snapshot = await page.locator("body").ariaSnapshot();
    const landmarks = snapshot
      .split("\n")
      .map((line) => LANDMARK.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]} "${m[2] ?? ""}"`);
    expect(landmarks).toContain('navigation "Main"');
    // The good nav demo's Preview is a real navigation landmark, under its own name.
    expect(landmarks).toContain('navigation "Demo site"');
    const repeated = landmarks.filter(
      (name, i) => landmarks.indexOf(name) !== i,
    );
    expect(repeated, snapshot).toEqual([]);
  });

  test("each format-picker copy keeps its own choice", async ({ page }) => {
    const pickers = page.getByTestId("format-picker");
    await expect(pickers).toHaveCount(2);
    const monolith = pickers.nth(0);
    const types = pickers.nth(1);
    await expect(monolith.getByTestId("format-ebook")).toHaveAttribute(
      "name",
      "format",
    );
    await monolith.getByTestId("format-ebook").check();
    await types.getByTestId("format-paperback").check();
    await expect(monolith.getByTestId("format-ebook")).toBeChecked();
    await expect(types.getByTestId("format-paperback")).toBeChecked();
  });

  test("the faq-question copies are one exclusive accordion", async ({
    page,
  }) => {
    const items = page.getByTestId("faq-question");
    const summaries = page.getByTestId("faq-question-summary");
    await expect(items).toHaveCount(3);
    for (let i = 0; i < 3; i++)
      await expect(items.nth(i)).toHaveAttribute("name", "faq");
    await summaries.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute("open", "");
    await summaries.nth(2).click();
    await expect(items.nth(2)).toHaveAttribute("open", "");
    await expect(items.nth(0)).not.toHaveAttribute("open", /.*/);
    await expect(items.nth(1)).not.toHaveAttribute("open", /.*/);
  });
});
