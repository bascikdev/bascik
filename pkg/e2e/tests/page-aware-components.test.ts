import { test, expect } from '@playwright/test';

test.describe('Page-aware component build scripts', () => {
  test('renders current page path on page 1', async ({ page }) => {
    await page.goto('/page-aware-1-test');
    const badge = page.getByTestId('page-aware-badge');
    await expect(badge.getByTestId('current-page-path')).toHaveText('/page-aware-1-test');
  });

  test('renders current page path on page 2', async ({ page }) => {
    await page.goto('/page-aware-2-test');
    const badge = page.getByTestId('page-aware-badge');
    await expect(badge.getByTestId('current-page-path')).toHaveText('/page-aware-2-test');
  });

  // Markup returned by an imported helper inside a page-aware script is scoped
  // like the component template, so the component's own CSS styles it.
  test('scopes markup returned by an imported helper', async ({ page }) => {
    await page.goto('/page-aware-1-test');
    const label = page.getByTestId('page-aware-label');
    await expect(label).toHaveText('/page-aware-1-test');
    await expect(label).toHaveClass(/bascik__page-aware-badge__badge-label/);
    await expect(label).toHaveCSS('color', 'rgb(0, 128, 0)');
    const em = page.getByTestId('page-aware-em');
    await expect(em).toHaveClass(/bascik__page-aware-badge__el__em/);
    await expect(em).toHaveCSS('font-weight', '700');
    expect(await page.content()).not.toContain('data-bascik-output-scope');
  });
});
