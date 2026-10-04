import { test, expect, type Page } from '@playwright/test';

/** How many pixels the page is wider than the window. Zero means no sideways scrolling. */
async function pageWidth(page: Page): Promise<number> {
  return page.locator('html').evaluate((root) => root.scrollWidth - root.clientWidth);
}

test.describe('Use Cases and Template Catalog', () => {
  test('top navigation links to Use Cases and marks it current on those pages only', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/use-cases/blog');
    const main = page.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link', { name: 'Use Cases' })).toHaveAttribute('aria-current', 'page');
    await expect(main.getByRole('link', { name: 'Docs' })).not.toHaveAttribute('aria-current', 'page');

    await page.goto('/components');
    await expect(main.getByRole('link', { name: 'Use Cases' })).not.toHaveAttribute('aria-current', 'page');
    await expect(main.getByRole('link', { name: 'Docs' })).toHaveAttribute('aria-current', 'page');
  });

  test('sidebar lists the Use Cases section, and pagination connects it to its neighbors', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/use-cases');
    const sidebar = page.getByRole('complementary', { name: 'Documentation navigation' });
    for (const name of ['Overview', 'Blog', 'Template Catalog']) {
      await expect(sidebar.getByRole('link', { name, exact: true }).first()).toBeVisible();
    }
    const pagination = page.getByRole('navigation', { name: 'Page navigation' });
    await expect(pagination.getByRole('link', { name: /Getting Started/ })).toBeVisible();
    await expect(pagination.getByRole('link', { name: /Blog/ })).toBeVisible();
  });

  test('footer sitemap includes the Use Cases pages', async ({ page }) => {
    await page.goto('/use-cases');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Template Catalog' })).toHaveAttribute('href', '/use-cases/templates');
  });

  test('mobile menu lists the Use Cases pages', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/use-cases');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(page.getByRole('link', { name: 'Template Catalog' }).first()).toBeVisible();
  });

  test('catalog screenshots load with their real size and the page does not scroll sideways', async ({ page }) => {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/use-cases/templates');
      const images = page.locator('#main-content img');
      await expect(images).toHaveCount(2);
      for (const image of await images.all()) {
        await image.scrollIntoViewIfNeeded();
        await expect(image).toHaveAttribute('width', /^\d+$/);
        await expect(image).toHaveAttribute('height', /^\d+$/);
        await expect(image).not.toHaveAttribute('alt', '');
        await expect.poll(() => image.evaluate((node) => { const picture = node as unknown as { complete: boolean; naturalWidth: number }; return picture.complete && picture.naturalWidth > 0; })).toBe(true);
        const box = await image.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
      expect(await pageWidth(page)).toBeLessThanOrEqual(0);
    }
  });

  test('catalog tables and install command are usable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/use-cases/templates');
    await expect(page.getByRole('cell', { name: 'npm create bascik@latest my-blog -- --example blog' })).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(0);
  });

  test('every page has exactly one h1 and the blog guide links resolve', async ({ page }) => {
    for (const path of ['/use-cases', '/use-cases/blog', '/use-cases/templates']) {
      await page.goto(path);
      await expect(page.locator('#main-content h1')).toHaveCount(1);
    }
    await page.goto('/use-cases/blog');
    const links = await page.locator('#main-content a[href^="/"]').evaluateAll((anchors) => [...new Set(anchors.map((a) => a.getAttribute('href')!.split('#')[0]))]);
    for (const href of links) {
      const response = await page.request.get(href);
      expect(response.status(), href).toBe(200);
    }
  });
});
