/**
 * e2e tests for advanced CSS scoping on the css-advanced-test fixture page.
 *
 * Two instances of <css-advanced> are rendered. Tests verify:
 *   - CSS custom properties are scoped (--accent → --bascik__css-advanced__accent)
 *   - CSS #id selectors are converted to class selectors (.bascik__css-advanced__id__special)
 *   - @keyframes names are scoped (fadeIn → bascik__css-advanced__keyframe__fadeIn)
 *   - Animation class toggle on instance A does not affect instance B
 *   - Both instances share the same custom property value (per-component, not per-instance)
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstances(page: Page) {
  return {
    a: page.locator('.bascik__css-advanced__wrapper').nth(0),
    b: page.locator('.bascik__css-advanced__wrapper').nth(1),
  };
}

function accentBox(inst: Locator) {
  return inst.locator('.bascik__css-advanced__accent-box');
}

/** #special in CSS becomes .bascik__css-advanced__id__special on the element */
function specialBox(inst: Locator) {
  return inst.locator('.bascik__css-advanced__id__special');
}

function animBtn(inst: Locator) {
  return inst.locator('[id$="__anim-trigger-btn"]');
}

function animatedBox(inst: Locator) {
  return inst.locator('[id$="__animated-box"]');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('css-advanced-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/css-advanced-test');
  });

  test('CSS custom property is applied: accent-box has the scoped --accent color', async ({ page }) => {
    const { a } = getInstances(page);
    const bg = await accentBox(a).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(74, 222, 128)');
  });

  test('CSS #id selector is applied via scoped class: special-box has yellow border', async ({ page }) => {
    const { a } = getInstances(page);
    const borderColor = await specialBox(a).evaluate(el => getComputedStyle(el).borderColor);
    expect(borderColor).toBe('rgb(250, 204, 21)');
  });

  test('percentage keyframe stops reach the browser unchanged', async ({ page }) => {
    // An invalid stop selector is dropped by the CSS parser, so count the stops
    // the browser actually kept for the scoped wobble animation.
    const keyText = await page.evaluate(() => {
      for (const sheet of [...document.styleSheets]) {
        for (const rule of [...sheet.cssRules]) {
          if (rule instanceof CSSKeyframesRule && rule.name.endsWith('__keyframe__wobble')) {
            return [...rule.cssRules].map((stop) => (stop as CSSKeyframeRule).keyText);
          }
        }
      }
      return null;
    });
    expect(keyText).toEqual(['40%', '80%', '0%, 100%']);
  });

  test('keyframe animation plays when toggle button is clicked', async ({ page }) => {
    const { a } = getInstances(page);
    await animBtn(a).click();
    await expect(animatedBox(a)).toHaveClass(/bascik__css-advanced__playing/);
  });

  test('instance isolation: both instances accent-boxes share the same custom property color', async ({ page }) => {
    const { a, b } = getInstances(page);
    const bgA = await accentBox(a).evaluate(el => getComputedStyle(el).backgroundColor);
    const bgB = await accentBox(b).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bgA).toBe('rgb(74, 222, 128)');
    expect(bgB).toBe('rgb(74, 222, 128)');
  });

  test('instance A toggle does not affect instance B animated-box', async ({ page }) => {
    const { a, b } = getInstances(page);
    await animBtn(a).click();
    await expect(animatedBox(a)).toHaveClass(/bascik__css-advanced__playing/);
    await expect(animatedBox(b)).not.toHaveClass(/playing/);
  });
});
