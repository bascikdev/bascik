import { test, expect } from '@playwright/test';

test.describe('canonical page routing', () => {
  test('serves a nested directory index at its trailing-slash URL', async ({ page }) => {
    await page.goto('/nested/');
    await expect(page.getByTestId('nested-index-marker')).toHaveText('nested-index');
  });

  test('serves a percent-encoded filename at its decoded page path', async ({ page }) => {
    await page.goto('/nested/r%C3%A9sum%C3%A9%20%23100%25');
    await expect(page.getByTestId('encoded-path-marker')).toHaveText('encoded-path');
  });
});