import { expect, test } from '@playwright/test';

test('normalizes class whitespace without corrupting scripts or longer tags', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/class-token-boundary');

  await expect(page.getByTestId('class-token-card')).toHaveCSS(
    'color',
    'rgb(17, 34, 51)',
  );
  await expect(page.getByTestId('class-token-status')).toHaveText('ready');
  await expect(page.getByTestId('literal-card-header')).toHaveText('Literal heading');
  await expect(page.getByTestId('registered-card')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});