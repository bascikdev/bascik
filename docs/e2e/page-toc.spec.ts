import { test, expect } from '@playwright/test';

test.describe('"On this page" table of contents', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lists page headings and links resolve to heading ids', async ({ page }) => {
    await page.goto('/press');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await expect(toc).toBeVisible();

    const hrefs = await toc.getByRole('link').evaluateAll((links) => links.map((a) => String(a.getAttribute('href'))));
    expect(hrefs.length).toBeGreaterThan(2);
    for (const href of hrefs) {
      expect(href.startsWith('#'), href).toBe(true);
      await expect(page.locator(`[id="${href.slice(1)}"]`), href).toHaveCount(1);
    }
  });

  test('clicking a link updates the URL hash and marks it as the current location', async ({ page }) => {
    await page.goto('/press');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    const links = toc.getByRole('link');
    const target = links.nth(1);
    const href = String(await target.getAttribute('href'));

    await target.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(target).toHaveAttribute('aria-current', 'location');
    await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
  });

  test('is hidden on narrow viewports', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/press');
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeHidden();
  });
});
