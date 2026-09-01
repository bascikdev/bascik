import { expect, test } from '@playwright/test';

test('applies CSS gradient fragments to both component instances', async ({ page }) => {
  await page.goto('/css-id-reference-test');

  for (const instanceId of ['gradient-instance-one', 'gradient-instance-two']) {
    const shape = page.getByTestId(instanceId).getByTestId('gradient-shape');
    await expect(shape).toBeVisible();
    const fill = await shape.evaluate((element) => getComputedStyle(element).fill);
    expect(fill).toMatch(/^url\(/);
    expect(fill).not.toBe('none');
    expect(fill).not.toBe('rgb(0, 0, 0)');
  }
});