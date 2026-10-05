/**
 * e2e tests for a component with no .css file on the no-css-test fixture page.
 *
 * Two instances of <no-css-comp> are rendered. Tests verify:
 *   - The component renders correctly without a paired CSS file
 *   - Its classes stay literal, because only classes a component's own stylesheet
 *     defines are scoped, and a component with no stylesheet defines none
 *   - A class from the site's global stylesheet therefore styles it
 *   - No component-specific <style> rule is injected for no-css-comp
 *   - The inline JS counter works: starts at 0, increments on click
 *   - Multiple clicks accumulate correctly
 *   - The two instances have independent counter state
 */
import { test, expect, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// These are compiler assertions: they target the literal class names the component
// authored, which stay unscoped because the component has no stylesheet.
function getInstance(page: Page, n: number): Locator {
  return page.locator('.bare-wrapper').nth(n);
}

function counter(inst: Locator): Locator {
  return inst.locator('.bare-counter');
}

function incBtn(inst: Locator): Locator {
  return inst.locator('[id$="__inc-btn"]');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('no-css-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/no-css-test');
  });

  // ── 1. Component renders ─────────────────────────────────────────────────

  test('component renders without CSS file', async ({ page }) => {
    await expect(getInstance(page, 0)).toBeVisible();
    await expect(getInstance(page, 1)).toBeVisible();
    await expect(page.getByTestId('bare-text').first()).toHaveText(
      'This component has no CSS file.'
    );
  });

  // ── 1b. Classes are literal, so global stylesheet rules apply ────────────

  test('a class with no definition in the component stays literal and the global rule applies', async ({ page }) => {
    const text = page.getByTestId('bare-text').first();
    await expect(text).toHaveAttribute('class', 'bare-text no-css-global-probe');
    // src/css/inlined-global.css sets this color; scoping the class would break the match.
    await expect(text).toHaveCSS('color', 'rgb(12, 34, 56)');
  });

  // ── 2. Counter starts at 0 ────────────────────────────────────────────────

  test('counter starts at 0', async ({ page }) => {
    const a = getInstance(page, 0);
    await expect(counter(a)).toHaveText('0');
  });

  // ── 3. JS works: counter increments on click ─────────────────────────────

  test('JS works: counter increments on click', async ({ page }) => {
    const a = getInstance(page, 0);
    await incBtn(a).click();
    await expect(counter(a)).toHaveText('1');
  });

  // ── 4. Multiple clicks accumulate ─────────────────────────────────────────

  test('multiple clicks increment correctly', async ({ page }) => {
    const a = getInstance(page, 0);
    await incBtn(a).click();
    await incBtn(a).click();
    await incBtn(a).click();
    await expect(counter(a)).toHaveText('3');
  });

  // ── 5. Instance isolation: each instance has its own counter ─────────────

  test('instance A counter is independent from instance B', async ({ page }) => {
    const a = getInstance(page, 0);
    const b = getInstance(page, 1);

    // Click A three times
    await incBtn(a).click();
    await incBtn(a).click();
    await incBtn(a).click();

    // Click B once
    await incBtn(b).click();

    await expect(counter(a)).toHaveText('3');
    await expect(counter(b)).toHaveText('1');
  });

  // ── 6. No style block contains no-css-comp rules ─────────────────────────
  //
  // When a component has no .css file, bascik must not inject any CSS rules
  // for it. Any <style> block on the page must not contain class selectors
  // or custom property names scoped to this component.

  test('no style tag injected for no-css-comp', async ({ page }) => {
    const styleContents = await page.evaluate(() => {
      return [...document.querySelectorAll('style')]
        .map(s => s.textContent ?? '')
        .join('\n');
    });
    expect(styleContents).not.toContain('bascik__no-css-comp');
  });
});
