/**
 * e2e tests for form `name` attributes on the form-test fixture page.
 *
 * Two instances of <form-test> are rendered side by side. `name` ships as
 * written (scoping.attributes.name is off by default; the opt-in is covered
 * on the base fixture). Tests verify:
 *   - Input/select `name` attributes keep the authored names
 *   - `new FormData(form)` entries use the authored names as keys
 *   - Each instance's form submits only its own fields
 *   - Clicking a button in one instance does not mutate the other instance's result
 *   - The in-component `getElementById` calls are rewritten to scoped ids
 */
import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.getByTestId("form-instance-one"),
    b: page.getByTestId("form-instance-two"),
  };
}

const result = (instance: Locator) => instance.getByTestId("result");
const button = (instance: Locator, testId: string) =>
  instance.getByTestId(testId);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("form-test page — name attribute", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/form-test");
  });

  // ── 1. username input keeps its authored name ───────────────────────────

  test("username input keeps its authored name", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(a.getByTestId("username-input")).toHaveAttribute(
      "name",
      "username",
    );
  });

  // ── 2. email input keeps its authored name ──────────────────────────────

  test("email input keeps its authored name", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(a.getByTestId("email-input")).toHaveAttribute("name", "email");
  });

  // ── 3. role select keeps its authored name ──────────────────────────────

  test("role select keeps its authored name", async ({ page }) => {
    const { a } = getInstances(page);
    await expect(a.getByTestId("role-select")).toHaveAttribute("name", "role");
  });

  // ── 4. FormData keys are the authored names ─────────────────────────────
  //
  // Clicking "Read FormData" runs `new FormData(form)` inside the component's
  // script, then joins the entry keys into the result div: the keys a server
  // receives on submit.

  test("FormData keys are the authored names", async ({ page }) => {
    const { a } = getInstances(page);
    await button(a, "submit-btn").click();
    await expect(result(a)).toHaveText("keys: username, email, role");
  });

  // ── 5. FormData has exactly 3 entries ───────────────────────────────────

  test("FormData has exactly 3 entries (username, email, role)", async ({
    page,
  }) => {
    const { a } = getInstances(page);
    await button(a, "check-entries-btn").click();
    await expect(result(a)).toHaveText("count: 3");
  });

  // ── 6. both instances share the authored name ───────────────────────────
  //
  // Each copy has its own <form>, so the shared name never collides: each
  // form's FormData holds only its own three fields.

  test("both instances keep the same authored name for username", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await expect(a.getByTestId("username-input")).toHaveAttribute(
      "name",
      "username",
    );
    await expect(b.getByTestId("username-input")).toHaveAttribute(
      "name",
      "username",
    );
    await button(b, "check-entries-btn").click();
    await expect(result(b)).toHaveText("count: 3");
  });

  // ── 7. clicking submit in A does not affect B's result ──────────────────

  test("clicking submit in instance A does not update instance B result", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await button(a, "submit-btn").click();
    await expect(result(a)).toHaveText(/keys:/);
    await expect(result(b)).toHaveText("No submission yet");
  });

  test("each label focuses the input in its own component instance", async ({
    page,
  }) => {
    const { a, b } = getInstances(page);
    await a.getByTestId("username-label").click();
    await expect(a.getByTestId("username-input")).toBeFocused();
    await b.getByTestId("username-label").click();
    await expect(b.getByTestId("username-input")).toBeFocused();
  });

  test("aria-describedby resolves within each component instance", async ({
    page,
  }) => {
    for (const instanceId of [
      "reference-instance-one",
      "reference-instance-two",
    ]) {
      const instance = page.getByTestId(instanceId);
      const descriptionId = await instance
        .getByTestId("description")
        .getAttribute("id");
      await expect(instance.getByTestId("described-input")).toHaveAttribute(
        "aria-describedby",
        descriptionId ?? "",
      );
    }
  });

  test("each fragment link targets its own component instance", async ({
    page,
  }) => {
    for (const instanceId of [
      "reference-instance-one",
      "reference-instance-two",
    ]) {
      const instance = page.getByTestId(instanceId);
      await instance.getByTestId("fragment-link").click();
      await expect
        .poll(() =>
          instance.evaluate((element) =>
            element.contains(document.querySelector(":target")),
          ),
        )
        .toBe(true);
    }
  });
});
