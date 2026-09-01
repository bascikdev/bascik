import { expect, test } from '@playwright/test';

test('multiple preserved tags keep their own content with inline styles', async ({ page }) => {
  await page.goto('/preserve-order-test');

  await expect(page.getByTestId('preserve-root')).toBeVisible();
  await expect(page.getByTestId('preserve-pre')).toHaveText('PRE ONLY');
  await expect(page.getByTestId('preserve-code')).toHaveText('CODE ONLY');
  await expect(page.getByTestId('pre-content')).toHaveAttribute('class', 'pre-example');
  await expect(page.getByTestId('code-content')).toHaveAttribute('class', 'code-example');
});