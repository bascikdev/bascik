/**
 * e2e tests for `<details name>` in a component: an exclusive accordion.
 *
 * `name` on `<details>` groups every details element in the document with
 * that name. The fixture renders one <accordion-item> per question, so the
 * group spans three component instances: Bascik ships `name` as written
 * (name scoping is opt-in), or each item would be a group of one and opening
 * one would not close the others.
 *
 * Each usage tag carries its own data-testid, which replaces the root's
 * `accordion-item`, so every instance is found by name rather than position.
 */
import { test, expect } from "@playwright/test";

const ITEMS = ["item-shipping", "item-returns", "item-warranty"];

test.describe("details-accordion-test page — <details name> across instances", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/details-accordion-test");
  });

  test("every item keeps the authored name", async ({ page }) => {
    for (const id of ITEMS)
      await expect(page.getByTestId(id)).toHaveAttribute("name", "faq");
  });

  test("each usage tag's data-testid replaces the root's own", async ({
    page,
  }) => {
    for (const id of ITEMS)
      await expect(page.getByTestId(id)).toHaveJSProperty("tagName", "DETAILS");
    await expect(page.getByTestId("accordion-item")).toHaveCount(0);
  });

  test("opening one item closes the open one", async ({ page }) => {
    const [shipping, returns, warranty] = ITEMS.map((id) =>
      page.getByTestId(id),
    );
    await shipping.getByTestId("accordion-question").click();
    await expect(shipping).toHaveAttribute("open", "");
    await warranty.getByTestId("accordion-question").click();
    await expect(warranty).toHaveAttribute("open", "");
    await expect(shipping).not.toHaveAttribute("open", /.*/);
    await expect(returns).not.toHaveAttribute("open", /.*/);
  });
});
