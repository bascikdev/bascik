/**
 * e2e tests for JS scope rewriting on the scope-test fixture page.
 *
 * Two instances of <scope-test> are rendered side by side. Every test that
 * clicks a button in Instance A also verifies that Instance B is unaffected,
 * which catches cross-instance scoping failures.
 *
 * The fixture is built with `minify.identifiers: false` so scoped class
 * names are readable: e.g. `bascik__scope-test__active` rather than a hash.
 * Tests match on `/bascik__scope-test__/` patterns so they don't break if the
 * scope-separator format ever changes.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns locators for the two component instances on the page.
 *
 * Bascik replaces <scope-test> tags with the component's HTML content at build
 * time — no shadow DOM, no custom element registry. Each instance's content is
 * wrapped in a div with the scoped wrapper class. We locate by that class.
 */
function getInstances(page: Page) {
  return {
    a: page.locator('.bascik__scope-test__wrapper').nth(0),
    b: page.locator('.bascik__scope-test__wrapper').nth(1),
  };
}

// Use [id$=] (ends-with) so we don't accidentally match e.g. __toggle-box when
// looking for __box. Each element has a unique per-instance hash in its id
// (e.g. bascik__scope-test__c510a2ef__box) but they all share the same suffix.
function box(inst: Locator) { return inst.locator('[id$="__box"]'); }
function toggleBox(inst: Locator) { return inst.locator('[id$="__toggle-box"]'); }
function replaceBox(inst: Locator) { return inst.locator('[id$="__replace-box"]'); }
function field(inst: Locator) { return inst.locator('[id$="__field"]'); }

function btn(inst: Locator, idSuffix: string) {
  return inst.locator(`[id$="__${idSuffix}"]`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('scope-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/scope-test');
  });

  // ── 1. Multi-arg classList.add ──────────────────────────────────────────

  test('classList.add multi-arg: adds both classes to instance A', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'add-btn').click();
    await expect(box(a)).toHaveClass(/bascik__scope-test__active/);
    await expect(box(a)).toHaveClass(/bascik__scope-test__highlighted/);
  });

  test('classList.add multi-arg: does not affect instance B', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(a, 'add-btn').click();
    await expect(box(b)).not.toHaveClass(/active/);
    await expect(box(b)).not.toHaveClass(/highlighted/);
  });

  test('classList.add with parens: adds classes accurately', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'parens-add-btn').click();
    await expect(box(a)).toHaveClass(/bascik__scope-test__active/);
    await expect(box(a)).toHaveClass(/bascik__scope-test__highlighted/);
  });

  // ── 2. Multi-arg classList.remove ──────────────────────────────────────

  test('classList.remove multi-arg: removes both classes from instance A', async ({ page }) => {
    const { a } = getInstances(page);
    // First add them.
    await btn(a, 'add-btn').click();
    await expect(box(a)).toHaveClass(/bascik__scope-test__active/);
    // Then remove.
    await btn(a, 'remove-btn').click();
    await expect(box(a)).not.toHaveClass(/active/);
    await expect(box(a)).not.toHaveClass(/highlighted/);
  });

  test('classList.remove multi-arg: does not affect instance B', async ({ page }) => {
    const { a, b } = getInstances(page);
    // Add to both then remove only from A.
    await btn(a, 'add-btn').click();
    await btn(b, 'add-btn').click();
    await btn(a, 'remove-btn').click();
    await expect(box(b)).toHaveClass(/bascik__scope-test__active/);
  });

  // ── 3. classList.toggle with boolean force arg ──────────────────────────

  test('classList.toggle(cls, true): adds class on instance A', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'toggle-on-btn').click();
    await expect(toggleBox(a)).toHaveClass(/bascik__scope-test__active/);
  });

  test('classList.toggle(cls, false): removes class from instance A', async ({ page }) => {
    const { a } = getInstances(page);
    // Ensure it's on first.
    await btn(a, 'toggle-on-btn').click();
    await expect(toggleBox(a)).toHaveClass(/bascik__scope-test__active/);
    // Now force off.
    await btn(a, 'toggle-off-btn').click();
    await expect(toggleBox(a)).not.toHaveClass(/active/);
  });

  test('classList.toggle: does not affect instance B toggle-box', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(a, 'toggle-on-btn').click();
    await expect(toggleBox(b)).not.toHaveClass(/active/);
  });

  // ── 4. classList.replace ────────────────────────────────────────────────

  test('classList.replace: replaces state-a with state-b on instance A', async ({ page }) => {
    const { a } = getInstances(page);
    // Initial state.
    await expect(replaceBox(a)).toHaveClass(/bascik__scope-test__state-a/);
    await btn(a, 'a-to-b-btn').click();
    await expect(replaceBox(a)).not.toHaveClass(/state-a/);
    await expect(replaceBox(a)).toHaveClass(/bascik__scope-test__state-b/);
  });

  test('classList.replace: replaces state-b with state-a on instance A', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'a-to-b-btn').click();
    await btn(a, 'b-to-a-btn').click();
    await expect(replaceBox(a)).toHaveClass(/bascik__scope-test__state-a/);
    await expect(replaceBox(a)).not.toHaveClass(/state-b/);
  });

  test('classList.replace: does not change instance B replace-box', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(a, 'a-to-b-btn').click();
    await expect(replaceBox(b)).toHaveClass(/bascik__scope-test__state-a/);
    await expect(replaceBox(b)).not.toHaveClass(/state-b/);
  });

  // ── 5. setAttribute("name") ────────────────────────────────────────────
  //
  // Bascik scopes setAttribute("name", value) when the value is a name that
  // appears in the component's static HTML. Both "username" and "email" appear
  // in the HTML (email via the sentinel hidden input), so both are scoped.
  // Scoped names include a per-instance hash:
  //   bascik__scope-test__<hash>__username
  // We match with a loose /bascik__scope-test__/ prefix + suffix pattern.

  test('setAttribute("name"): initial field name is scoped', async ({ page }) => {
    const { a } = getInstances(page);
    await expect(field(a)).toHaveAttribute('name', /bascik__scope-test__.+__username/);
  });

  test('setAttribute("name"): changes field name to scoped email on instance A', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'set-name-btn').click();
    await expect(field(a)).toHaveAttribute('name', /bascik__scope-test__.+__email/);
  });

  test('setAttribute("name"): resets field name to scoped username on instance A', async ({ page }) => {
    const { a } = getInstances(page);
    await btn(a, 'set-name-btn').click();
    await btn(a, 'reset-name-btn').click();
    await expect(field(a)).toHaveAttribute('name', /bascik__scope-test__.+__username/);
  });

  test('setAttribute("name"): does not affect instance B field name', async ({ page }) => {
    const { a, b } = getInstances(page);
    // A gets set to email, B must remain scoped username.
    await btn(a, 'set-name-btn').click();
    await expect(field(b)).toHaveAttribute('name', /bascik__scope-test__.+__username/);
    // A's name must not be the same value as B's (instance isolation).
    const aName = await field(a).getAttribute('name');
    const bName = await field(b).getAttribute('name');
    expect(aName).not.toBe(bName);
  });

  // ── 6. classList.toggle (single arg — no force) ─────────────────────────

  test('classList.toggle single-arg: toggles class ON when not present', async ({ page }) => {
    const { a } = getInstances(page);
    // toggleBox starts without 'active'.
    await expect(toggleBox(a)).not.toHaveClass(/active/);
    await btn(a, 'toggle-plain-btn').click();
    await expect(toggleBox(a)).toHaveClass(/bascik__scope-test__active/);
  });

  test('classList.toggle single-arg: toggles class OFF when present', async ({ page }) => {
    const { a } = getInstances(page);
    // Force it on first using the boolean-true button.
    await btn(a, 'toggle-on-btn').click();
    await expect(toggleBox(a)).toHaveClass(/bascik__scope-test__active/);
    // Plain toggle should flip it back off.
    await btn(a, 'toggle-plain-btn').click();
    await expect(toggleBox(a)).not.toHaveClass(/active/);
  });

  test('classList.toggle single-arg: does not affect instance B', async ({ page }) => {
    const { a, b } = getInstances(page);
    await btn(a, 'toggle-plain-btn').click();
    await expect(toggleBox(b)).not.toHaveClass(/active/);
  });
});
