/**
 * e2e tests for `<details name>` in a component: an exclusive accordion.
 *
 * `name` on `<details>` groups every details element in the document with
 * that name. The fixture renders one <accordion-item> per question, so the
 * group spans three component instances: Bascik ships `name` as written
 * (name scoping is opt-in), or each item would be a group of one and opening
 * one would not close the others.
 */
import { test, expect } from "@playwright/test";

test.describe("details-accordion-test page — <details name> across instances", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/details-accordion-test");
  });

  test("every item keeps the authored name", async ({ page }) => {
    const items = page.getByTestId("accordion-item");
    await expect(items).toHaveCount(3);
    for (let i = 0; i < 3; i++)
      await expect(items.nth(i)).toHaveAttribute("name", "faq");
  });

  test("opening one item closes the open one", async ({ page }) => {
    const items = page.getByTestId("accordion-item");
    const questions = page.getByTestId("accordion-question");
    await questions.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute("open", "");
    await questions.nth(2).click();
    await expect(items.nth(2)).toHaveAttribute("open", "");
    await expect(items.nth(0)).not.toHaveAttribute("open", /.*/);
    await expect(items.nth(1)).not.toHaveAttribute("open", /.*/);
  });
});
