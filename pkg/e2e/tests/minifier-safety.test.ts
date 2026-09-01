import { expect, test } from '@playwright/test';

test('preserves raw script content, nesting, and empty external script bodies', async ({ page }) => {
  await page.goto('/minifier-safety');

  await expect(page.getByTestId('document-tail')).toHaveText('Content after data script');
  await expect(page.getByTestId('json-ld')).toHaveJSProperty(
    'textContent',
    '{"description":"<!-- remains data"}',
  );
  const nestedScript = page.getByTestId('script-sample').getByTestId('nested-script');
  await expect(nestedScript).toHaveCount(1);
  await expect(page.getByTestId('external-script')).toHaveJSProperty('textContent', '');
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, 'minifierExternalLoaded'))).toBe(true);
});