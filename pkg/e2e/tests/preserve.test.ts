import { expect, test } from '@playwright/test';

test.describe('preserve directives', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/preserve-test');
  });

  test('keeps a literal widget mount ID available to component scripts', async ({ page }) => {
    await expect(page.getByTestId('widget-mount')).toHaveText('Widget mounted');
  });

  test('keeps preserved form field names unscoped', async ({ page }) => {
    await expect(page.getByTestId('preserved-email')).toHaveAttribute('name', 'email');
  });

  test('keeps unpreserved radio groups independent between instances', async ({ page }) => {
    const first = page.getByTestId('radio-instance-one');
    const second = page.getByTestId('radio-instance-two');
    await first.getByTestId('monthly-plan').check();
    await second.getByTestId('yearly-plan').check();
    await expect(first.getByTestId('monthly-plan')).toBeChecked();
    await expect(second.getByTestId('yearly-plan')).toBeChecked();
  });
});