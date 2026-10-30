/**
 * /name-attribute: the live Preview of each demo behaves the way the HTML standard defines `name`, because Bascik
 * ships `name` as written.
 *
 * - Two <froth-picker> copies, each with its radios in a form of its own, are two radio groups.
 * - Three <frother-question> copies, each one <details name="faq">, are one exclusive accordion.
 */
import { test, expect } from "@playwright/test";

test.describe("/name-attribute demos", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/name-attribute");
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
