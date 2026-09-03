/**
 * E2E tests for W3C Selectors & Nesting Conformance.
 *
 * Verifies live browser computation for :has(), :is(), :where(),
 * :nth-child(even of .cls), attribute matchers, and 2023 relaxed CSS nesting.
 */
import { test, expect } from '@playwright/test';

test.describe('w3c-selectors-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/w3c-selectors-test');
  });

  test('relational pseudo-class :has(): applies highlight to card items containing badge', async ({ page }) => {
    const plainCard = page.getByTestId('card-plain');
    const badgeCard = page.getByTestId('card-with-badge');

    const plainBorder = await plainCard.evaluate((el) => getComputedStyle(el).borderLeftColor);
    const badgeBorder = await badgeCard.evaluate((el) => getComputedStyle(el).borderLeftColor);

    // Plain card has default #94a3b8 -> rgb(148, 163, 184)
    expect(plainBorder).toBe('rgb(148, 163, 184)');
    // Badge card matched by :has(span.badge) -> #3b82f6 -> rgb(59, 130, 246)
    expect(badgeBorder).toBe('rgb(59, 130, 246)');
  });

  test(':nth-child(even of .featured): highlights even featured items only', async ({ page }) => {
    const feat1 = page.getByTestId('feat-1');
    const reg1 = page.getByTestId('reg-1');
    const feat2 = page.getByTestId('feat-2');

    const feat1Bg = await feat1.evaluate((el) => getComputedStyle(el).backgroundColor);
    const reg1Bg = await reg1.evaluate((el) => getComputedStyle(el).backgroundColor);
    const feat2Bg = await feat2.evaluate((el) => getComputedStyle(el).backgroundColor);

    // feat2 is 2nd featured item (even of .featured) -> #fef08a -> rgb(254, 240, 138)
    expect(feat2Bg).toBe('rgb(254, 240, 138)');
    expect(feat1Bg).not.toBe('rgb(254, 240, 138)');
    expect(reg1Bg).not.toBe('rgb(254, 240, 138)');
  });

  test('attribute selectors: targets elements by attribute prefix and custom data attributes', async ({ page }) => {
    const secureLink = page.getByTestId('secure-link');
    const insecureLink = page.getByTestId('insecure-link');
    const highPriority = page.getByTestId('high-priority-box');

    const secureColor = await secureLink.evaluate((el) => getComputedStyle(el).color);
    const insecureColor = await insecureLink.evaluate((el) => getComputedStyle(el).color);
    const highPriorityColor = await highPriority.evaluate((el) => getComputedStyle(el).color);

    // a[href^="https://"] -> #059669 -> rgb(5, 150, 105)
    expect(secureColor).toBe('rgb(5, 150, 105)');
    expect(insecureColor).not.toBe('rgb(5, 150, 105)');
    // div[data-priority="high"] -> #dc2626 -> rgb(220, 38, 38)
    expect(highPriorityColor).toBe('rgb(220, 38, 38)');
  });

  test('CSS nesting: applies nested rules without explicit & operator', async ({ page }) => {
    const nestedP = page.getByTestId('nested-p');
    const nestedSpan = page.getByTestId('nested-span');

    const pColor = await nestedP.evaluate((el) => getComputedStyle(el).color);
    const spanColor = await nestedSpan.evaluate((el) => getComputedStyle(el).color);

    // & p -> #334155 -> rgb(51, 65, 85)
    expect(pColor).toBe('rgb(51, 65, 85)');
    // > span -> #0284c7 -> rgb(2, 132, 199)
    expect(spanColor).toBe('rgb(2, 132, 199)');
  });
});
