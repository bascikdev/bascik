/**
 * e2e tests for opting in to `name` scoping (scoping.attributes.name: true),
 * on the base fixture, whose config turns it on. pkg/e2e itself keeps the
 * default, where `name` ships as written (form-scoping.test.ts).
 *
 * Two copies of <name-form> sit on one page. With the opt-in, each copy's
 * field names, the keys its FormData reads, and a script's
 * setAttribute("name", ...) are all scoped per instance.
 */
import { test, expect } from "@playwright/test";

const SCOPED_USERNAME = /^bascik__name-form__.+__username$/;
const SCOPED_EMAIL = /^bascik__name-form__.+__email$/;

test.describe("name-scoping page — scoping.attributes.name opt-in", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sub/name-scoping");
  });

  test("scopes each copy's field name per instance", async ({ page }) => {
    const first = page.getByTestId("name-form-first").getByTestId("field");
    const second = page.getByTestId("name-form-second").getByTestId("field");
    await expect(first).toHaveAttribute("name", SCOPED_USERNAME);
    await expect(second).toHaveAttribute("name", SCOPED_USERNAME);
    expect(await first.getAttribute("name")).not.toBe(
      await second.getAttribute("name"),
    );
  });

  test("FormData reads the scoped names as keys", async ({ page }) => {
    const keys = page.getByTestId("name-form-first").getByTestId("keys");
    await expect(keys).toHaveText(
      /^bascik__name-form__.+__username, bascik__name-form__.+__email$/,
    );
  });

  test('scopes setAttribute("name", ...) in the component script to its own instance', async ({
    page,
  }) => {
    const first = page.getByTestId("name-form-first");
    const second = page.getByTestId("name-form-second");
    await first.getByTestId("rename").click();
    await expect(first.getByTestId("field")).toHaveAttribute(
      "name",
      SCOPED_EMAIL,
    );
    await expect(second.getByTestId("field")).toHaveAttribute(
      "name",
      SCOPED_USERNAME,
    );
  });
});
