import { test, expect } from '@playwright/test';

test.describe('Press kit', () => {
  test('press resources page renders with a working download and previews', async ({ page, request }) => {
    await page.goto('/press');
    await expect(page.locator('#main-content h1')).toHaveText('Press Resources');

    const download = page.getByTestId('press-download-kit');
    await expect(download).toBeVisible();
    const href = await download.getAttribute('href');
    expect(href).toBe('/assets/press/bascik-press-kit.zip');

    const zip = await request.get(href!);
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toContain('zip');
    const body = await zip.body();
    expect(body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);

    // Every preview image on the page must load successfully
    const previews = page.getByTestId('press-previews').locator('img');
    const count = await previews.count();
    expect(count).toBe(6);
    for (let i = 0; i < count; i++) {
      await expect(previews.nth(i)).toBeVisible();
      const naturalWidth = await previews.nth(i).evaluate((img) => Number((img as unknown as { naturalWidth: number }).naturalWidth));
      expect(naturalWidth).toBeGreaterThan(0);
    }
  });

  test('every kit file linked from the page is served', async ({ page, request }) => {
    await page.goto('/press');
    const hrefs = await page.locator('#main-content a[href^="/assets/press/"]').evaluateAll(
      (links) => links.map((a) => String(a.getAttribute('href'))),
    );
    expect(hrefs.length).toBeGreaterThan(6);
    for (const href of new Set(hrefs)) {
      const response = await request.get(href);
      expect(response.status(), href).toBe(200);
    }
  });

  test('page lists the same social and avatar files the kit contains', async ({ page, request }) => {
    await page.goto('/press');
    const files = await page.locator('#main-content table code').allTextContents();
    const kitFiles = files.filter((text) => /^(social|avatar)\/.+\.png$/.test(text));
    expect(kitFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of kitFiles) {
      const response = await request.get(`/assets/press/${file}`);
      expect(response.status(), file).toBe(200);
    }
  });
});
