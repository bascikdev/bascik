import { expect, test } from "@playwright/test";

test.describe("preserve directives", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/preserve-test");
  });

  test("keeps a literal widget mount ID available to component scripts", async ({
    page,
  }) => {
    await expect(page.getByTestId("widget-mount")).toHaveText("Widget mounted");
  });

  test("keeps preserved form field names unscoped", async ({ page }) => {
    await expect(page.getByTestId("preserved-email")).toHaveAttribute(
      "name",
      "email",
    );
  });

  // `name` ships as written (scoping.attributes.name is off by default), so a
  // radio group is decided the way the HTML spec decides it: same name, same
  // form owner, or no form owner in the same tree.
  test("keeps each instance's radio group independent when the component has its own form", async ({
    page,
  }) => {
    const first = page.getByTestId("radio-instance-one");
    const second = page.getByTestId("radio-instance-two");
    await expect(first.getByTestId("monthly-plan")).toHaveAttribute(
      "name",
      "plan",
    );
    await first.getByTestId("monthly-plan").check();
    await second.getByTestId("yearly-plan").check();
    await expect(first.getByTestId("monthly-plan")).toBeChecked();
    await expect(second.getByTestId("yearly-plan")).toBeChecked();
  });

  test("makes the copies one radio group when the component has no form of its own", async ({
    page,
  }) => {
    const first = page.getByTestId("shared-instance-one");
    const second = page.getByTestId("shared-instance-two");
    await first.getByTestId("size-small").check();
    await second.getByTestId("size-large").check();
    await expect(second.getByTestId("size-large")).toBeChecked();
    await expect(first.getByTestId("size-small")).not.toBeChecked();
  });

  test("keeps radio groups independent when each copy gets its name through a prop", async ({
    page,
  }) => {
    const first = page.getByTestId("prop-instance-one");
    const second = page.getByTestId("prop-instance-two");
    await expect(first.getByTestId("color-red")).toHaveAttribute(
      "name",
      "front-color",
    );
    await expect(second.getByTestId("color-red")).toHaveAttribute(
      "name",
      "back-color",
    );
    await first.getByTestId("color-red").check();
    await second.getByTestId("color-blue").check();
    await expect(first.getByTestId("color-red")).toBeChecked();
    await expect(second.getByTestId("color-blue")).toBeChecked();
  });
});
