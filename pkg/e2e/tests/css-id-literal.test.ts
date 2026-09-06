import { expect, test } from '@playwright/test';

test('keeps attribute-selector hashes and content strings literal while scoping real url fragments', async ({ page }) => {
  await page.goto('/css-id-literal-test');

  const root = page.getByTestId('id-literal-instance-one');
  await expect(root).toBeVisible();

  // Generated content must be unchanged: the string "url(#local)" is literal,
  // not a real URL reference, and must not be rewritten or corrupted.
  const generated = root.getByTestId('literal-generated');
  await expect(generated).toHaveText('separator');
  const generatedText = await generated.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(generatedText).toContain('url(#local)');

  // Attribute-selector value #tab anchors the a[data-key="#tab"] rule. The
  // hash must survive scoping so the rule still matches the link, turning it
  // green. If it were rewritten to a class reference the rule would break.
  const note = root.getByTestId('literal-link');
  await expect(note).toHaveCSS('color', 'rgb(0, 128, 0)');

  // The data-key="#tab" attribute value is never fragment-rewritten, so it must
  // remain byte-identical after scoping. If Bascik treated the hash in an
  // attribute-selector value as syntax, this would be corrupted.
  await expect(note).toHaveAttribute('data-key', '#tab');

  // The real url(#local) fragment inside the SVG still resolves to the scoped
  // gradient, so the rectangle gets a non-trivial fill.
  const shape = root.getByTestId('literal-shape');
  await expect(shape).toBeVisible();
  const fill = await shape.evaluate((el) => getComputedStyle(el).fill);
  expect(fill).toMatch(/^url\(/);
  expect(fill).not.toBe('none');
  expect(fill).not.toBe('rgb(0, 0, 0)');
});