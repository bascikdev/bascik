/**
 * e2e tests for form `name` attribute scoping on the form-test fixture page.
 *
 * Two instances of <form-test> are rendered side by side. Tests verify:
 *   - Input/select `name` attributes are scoped per-instance
 *   - `new FormData(form)` entries use the scoped names as keys
 *   - The two instances produce distinct scoped names (different hash segments)
 *   - Clicking a button in one instance does not mutate the other instance's result
 *   - The in-component `getElementById` calls are also rewritten to scoped names
 *
 * The fixture is built with `minify.identifiers: false` so readable scoped
 * names like `bascik__form-test__9c332cac__username` appear in the DOM.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.getByTestId('form-instance-one'),
    b: page.getByTestId('form-instance-two'),
  };
}

const result = (instance: Locator) => instance.getByTestId('result');
const button = (instance: Locator, testId: string) => instance.getByTestId(testId);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('form-test page — name attribute scoping', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/form-test');
  });

  // ── 1. username input has a scoped name attribute ───────────────────────

  test('username input has scoped name attribute', async ({ page }) => {
    const { a } = getInstances(page);
    const usernameInput = a.getByTestId('username-input');
    await expect(usernameInput).toHaveAttribute('name', /bascik__form-test__.+__username/);
  });

  // ── 2. email input has a scoped name attribute ──────────────────────────

  test('email input has scoped name attribute', async ({ page }) => {
    const { a } = getInstances(page);
    const emailInput = a.getByTestId('email-input');
    await expect(emailInput).toHaveAttribute('name', /bascik__form-test__.+__email/);
  });

  // ── 3. role select has a scoped name attribute ──────────────────────────

  test('role select has scoped name attribute', async ({ page }) => {
    const { a } = getInstances(page);
    const roleSelect = a.getByTestId('role-select');
    await expect(roleSelect).toHaveAttribute('name', /bascik__form-test__.+__role/);
  });

  // ── 4. FormData keys contain the scoped name prefix ─────────────────────
  //
  // Clicking "Read FormData" runs `new FormData(form)` inside the component's
  // scoped script, then joins the entry keys into the result div. Because name
  // attributes are scoped, FormData uses the scoped names as keys.

  test('FormData keys use scoped names (contain bascik__form-test__ prefix)', async ({ page }) => {
    const { a } = getInstances(page);
    await button(a, 'submit-btn').click();
    await expect(result(a)).toHaveText(/keys: bascik__form-test__.+__username/);
  });

  // ── 5. FormData has exactly 3 entries ───────────────────────────────────

  test('FormData has exactly 3 entries (username, email, role)', async ({ page }) => {
    const { a } = getInstances(page);
    await button(a, 'check-entries-btn').click();
    await expect(result(a)).toHaveText('count: 3');
  });

  // ── 6. both instances have different name scopes (different hashes) ─────
  //
  // Each instance gets a unique hash segment. The scoped names for instance A
  // and instance B must differ so FormData from both forms doesn't collide.

  test('both instances have different scoped name attributes for username', async ({ page }) => {
    const { a, b } = getInstances(page);
    const nameA = await a.getByTestId('username-input').getAttribute('name');
    const nameB = await b.getByTestId('username-input').getAttribute('name');
    expect(nameA).toMatch(/bascik__form-test__.+__username/);
    expect(nameB).toMatch(/bascik__form-test__.+__username/);
    expect(nameA).not.toBe(nameB);
  });

  // ── 7. clicking submit in A does not affect B's result ──────────────────

  test('clicking submit in instance A does not update instance B result', async ({ page }) => {
    const { a, b } = getInstances(page);
    await button(a, 'submit-btn').click();
    await expect(result(a)).toHaveText(/keys:/);
    await expect(result(b)).toHaveText('No submission yet');
  });

  test('each label focuses the input in its own component instance', async ({ page }) => {
    const { a, b } = getInstances(page);
    await a.getByTestId('username-label').click();
    await expect(a.getByTestId('username-input')).toBeFocused();
    await b.getByTestId('username-label').click();
    await expect(b.getByTestId('username-input')).toBeFocused();
  });

  test('aria-describedby resolves within each component instance', async ({ page }) => {
    for (const instanceId of ['reference-instance-one', 'reference-instance-two']) {
      const instance = page.getByTestId(instanceId);
      const descriptionId = await instance.getByTestId('description').getAttribute('id');
      await expect(instance.getByTestId('described-input')).toHaveAttribute(
        'aria-describedby',
        descriptionId ?? '',
      );
    }
  });

  test('each fragment link targets its own component instance', async ({ page }) => {
    for (const instanceId of ['reference-instance-one', 'reference-instance-two']) {
      const instance = page.getByTestId(instanceId);
      await instance.getByTestId('fragment-link').click();
      await expect.poll(() => instance.evaluate((element) =>
        element.contains(document.querySelector(':target')),
      )).toBe(true);
    }
  });
});
