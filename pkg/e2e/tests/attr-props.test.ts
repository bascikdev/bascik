/**
 * e2e tests for repeated prop keys in the attr-props fixture page.
 *
 * NOTE: Bascik props inject plain text into element *content* only.
 * Attribute-level prop injection (e.g. setting href, src, placeholder via a prop)
 * is NOT supported — props always replace inner text, never attribute values.
 *
 * This test suite focuses on a distinct scenario not covered by props.test.ts:
 * the same prop key used in multiple elements within a single component template.
 * The `attr-props` component uses `data-bascik-prop-title` on three separate
 * elements (h2.ap-heading, span.ap-inline, span.ap-badge), verifying that a
 * single prop value fans out to every matching placeholder.
 *
 * Three instances of <attr-props> are rendered:
 *   - Usage 1: both `title` and `subtitle` provided
 *   - Usage 2: only `subtitle` provided; `title` uses the fallback in all 3 spots
 *   - Usage 3: no props at all; all elements use fallback content
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstance(page: Page, n: number) {
  return page.locator('.bascik__attr-props__ap-card').nth(n);
}

function heading(inst: Locator) {
  return inst.locator('.bascik__attr-props__ap-heading');
}

function inline(inst: Locator) {
  return inst.locator('.bascik__attr-props__ap-inline');
}

function badge(inst: Locator) {
  return inst.locator('.bascik__attr-props__ap-badge');
}

function sub(inst: Locator) {
  return inst.locator('.bascik__attr-props__ap-sub');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('attr-props-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/attr-props-test');
  });

  // -------------------------------------------------------------------------
  // Usage 1 — both props provided
  // -------------------------------------------------------------------------

  test('usage 1: title prop is injected into heading', async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(heading(inst)).toHaveText('Custom Title');
  });

  test('usage 1: title prop is injected into inline span', async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(inline(inst)).toHaveText('Custom Title');
  });

  test('usage 1: title prop is injected into badge', async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(badge(inst)).toHaveText('Custom Title');
  });

  test('usage 1: subtitle prop is injected', async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(sub(inst)).toHaveText('Custom Subtitle');
  });

  // -------------------------------------------------------------------------
  // Usage 2 — only subtitle provided; title falls back in all three spots
  // -------------------------------------------------------------------------

  test('usage 2: title heading falls back to default', async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(heading(inst)).toHaveText('Default Title');
  });

  test('usage 2: title inline span falls back to default', async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(inline(inst)).toHaveText('Default Title');
  });

  test('usage 2: title badge falls back to default', async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(badge(inst)).toHaveText('Default Title');
  });

  test('usage 2: subtitle prop is injected', async ({ page }) => {
    const inst = getInstance(page, 1);
    await expect(sub(inst)).toHaveText('Only Subtitle');
  });

  // -------------------------------------------------------------------------
  // Usage 3 — no props; all elements use fallback content
  // -------------------------------------------------------------------------

  test('usage 3: title heading falls back to default', async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(heading(inst)).toHaveText('Default Title');
  });

  test('usage 3: title inline span falls back to default', async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(inline(inst)).toHaveText('Default Title');
  });

  test('usage 3: title badge falls back to default', async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(badge(inst)).toHaveText('Default Title');
  });

  test('usage 3: subtitle falls back to default', async ({ page }) => {
    const inst = getInstance(page, 2);
    await expect(sub(inst)).toHaveText('Default Subtitle');
  });

  // -------------------------------------------------------------------------
  // Usage 4 — class prop bug simulation
  // -------------------------------------------------------------------------

  test('usage 4: nested class attribute strings do not mangle properties', async ({ page }) => {
    // This tests the replaceSafeAttr function inside javascript.ts/styles.ts
    // The component wrapper element should have the `real` class but NOT `bascik__...__fake`
    const inst = getInstance(page, 3);
    await expect(heading(inst)).toHaveText('Data Foo Title');
    await expect(sub(inst)).toHaveText('Default Subtitle');

    await expect(inst).toHaveClass(/bascik__attr-props__ap-card/);
  });

  // -------------------------------------------------------------------------
  // Instance isolation — verify instances are independent
  // -------------------------------------------------------------------------

  test('usage 1 title is not the default fallback', async ({ page }) => {
    const inst = getInstance(page, 0);
    await expect(heading(inst)).not.toHaveText('Default Title');
  });

  test('usage 1 and usage 3 have distinct title headings', async ({ page }) => {
    const inst1 = getInstance(page, 0);
    const inst3 = getInstance(page, 2);
    await expect(heading(inst1)).toHaveText('Custom Title');
    await expect(heading(inst3)).toHaveText('Default Title');
  });

  test('usage 1 and usage 2 have distinct subtitles', async ({ page }) => {
    const inst1 = getInstance(page, 0);
    const inst2 = getInstance(page, 1);
    await expect(sub(inst1)).toHaveText('Custom Subtitle');
    await expect(sub(inst2)).toHaveText('Only Subtitle');
  });
});
