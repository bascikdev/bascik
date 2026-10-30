/// <reference lib="dom" />

/**
 * /component-best-practices practices what it teaches, and its live demo Previews behave the way the HTML standard
 * defines, because Bascik ships the element and the `name` you wrote.
 *
 * - Its checklist says a page with more than one <nav> names each one, so the demo Previews must not add a landmark
 *   whose name another landmark already has (the docs header is navigation "Main"; a demo <site-nav aria-label="Main" />
 *   made a second one, which a screen reader's landmark list shows as two identical entries).
 * - Two <froth-picker> copies, each with its radios in a form of its own, are two radio groups.
 * - Three <frother-question> copies, each one <details name="faq">, are one exclusive accordion.
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

  test("each froth-picker copy keeps its own choice", async ({ page }) => {
    const pickers = page.getByTestId("froth-picker");
    await expect(pickers).toHaveCount(2);
    const morning = pickers.nth(0);
    const evening = pickers.nth(1);
    await expect(morning.getByTestId("froth-light")).toHaveAttribute(
      "name",
      "froth",
    );
    await morning.getByTestId("froth-light").check();
    await evening.getByTestId("froth-thick").check();
    await expect(morning.getByTestId("froth-light")).toBeChecked();
    await expect(evening.getByTestId("froth-thick")).toBeChecked();
  });

  test("the frother-question copies are one exclusive accordion", async ({
    page,
  }) => {
    const items = page.getByTestId("frother-question");
    const summaries = page.getByTestId("frother-question-summary");
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
