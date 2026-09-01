import { expect, test } from '@playwright/test';

test('props stay isolated, preserve child declarations, and escape markup', async ({ page }) => {
  const dialogs: string[] = [];
  const consoleErrors: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/props-correctness');

  await expect(page.getByTestId('prop-title')).toHaveText([
    'First title',
    'Second title',
  ]);
  await expect(page.getByTestId('child-label')).toHaveText([
    'Child label',
    'Child label',
  ]);
  await expect(page.getByTestId('child-content')).toHaveText([
    'Child content',
    'Child content',
  ]);
  await expect(page.getByTestId('raw-slot-markup')).toHaveText([
    'First raw slot',
    'Second raw slot',
  ]);
  await expect(page.getByTestId('nested-slot-value')).toHaveText([
    'First nested slot',
    'Second nested slot',
  ]);
  await expect(page.getByTestId('escaped-payload')).toHaveText([
    '<script>alert(1)</script>',
    '<script>alert(1)</script>',
  ]);
  expect(dialogs).toEqual([]);
  expect(consoleErrors).toEqual([]);
});