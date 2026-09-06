import { expect, test } from '@playwright/test';

test('preserves page-level style raw text (CDO/CDC) through HTML minification', async ({ page }) => {
  await page.goto('/min-style-test');

  // The <style><!-- ... --></style> CDO/CDC block must survive minify.html so the
  // rule actually applies. If the HTML minifier stripped `<!-- ... -->` as an
  // ordinary comment, the color would fall back to black.
  const cdoStyled = page.getByTestId('min-style-cdo');
  await expect(cdoStyled).toHaveCSS('color', 'rgb(200, 30, 60)');

  // Plain page-level style still applies.
  const plain = page.getByTestId('min-style-plain');
  await expect(plain).toHaveCSS('font-weight', '700');

  // A CSS string containing HTML-comment-looking text must stay intact and not
  // be stripped as if it were an HTML comment.
  const withString = page.getByTestId('min-style-string');
  await expect(withString).toHaveCSS('color', 'rgb(0, 0, 0)');
  const pseudo = await withString.evaluate((el) => getComputedStyle(el, '::after').content);
  expect(pseudo).toContain('<!-- not a comment -->');
});
