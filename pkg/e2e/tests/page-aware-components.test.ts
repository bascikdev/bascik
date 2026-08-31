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
});
