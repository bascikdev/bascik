import { expect, test } from '@playwright/test';

test('structural HTML edge cases compile without corruption or duplication', async ({ page }) => {
  await page.goto('/structural-regex-test');

  await expect(page.getByTestId('closing-tag-text')).toHaveValue('</body>');
  await expect(page.getByTestId('body-tail')).toHaveCount(1);

  const roots = page.getByTestId('structural-root');
  await expect(roots).toHaveCount(3);
  await expect(roots.first()).toHaveAttribute('title', 'greater > lesser');
  await expect(roots.first()).toHaveClass(/inherited-root/);
  await expect(roots.first()).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(roots.first()).toHaveCSS('font-weight', '700');
});