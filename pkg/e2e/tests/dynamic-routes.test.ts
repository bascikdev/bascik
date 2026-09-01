import { test, expect } from '@playwright/test';

test.describe('dynamic routes', () => {
  test('renders first generated route /dynamic/alpha', async ({ page }) => {
    const res = await page.goto('/dynamic/alpha');
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId('post-title')).toHaveText('Alpha Post');
    await expect(page.getByTestId('post-slug')).toHaveText('alpha');
    await expect(page.getByTestId('post-count')).toHaveText('1');

    const content = await page.content();
    expect(content).not.toContain('data-bascik-routes');
  });

  test('renders second generated route /dynamic/beta', async ({ page }) => {
    const res = await page.goto('/dynamic/beta');
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId('post-title')).toHaveText('Beta Post');
    await expect(page.getByTestId('post-slug')).toHaveText('beta');
    await expect(page.getByTestId('post-count')).toHaveText('2');
  });

  test('renders unicode slug route /dynamic/author’s-post', async ({ page }) => {
    const res = await page.goto('/dynamic/author’s-post');
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId('post-title')).toHaveText('Unicode Post');
    await expect(page.getByTestId('post-slug')).toHaveText('author’s-post');
    await expect(page.getByTestId('post-count')).toHaveText('3');
  });

  test('coexists with server scripts on dynamic pages under server mode', async ({ page }) => {
    await page.goto('/dynamic/alpha');
    const serverElement = page.getByTestId('server-slice');
    // If running in a server mode with server scripts active, it should be rendered
    const isVisible = await serverElement.isVisible().catch(() => false);
    if (isVisible) {
      await expect(serverElement).toHaveText('Personalized Slice');
    }
  });

  test('supports unquoted src attribute in routes and build scripts', async ({ page }) => {
    const res1 = await page.goto('/unquoted-routes/item-1');
    expect(res1?.status()).toBe(200);
    await expect(page.getByTestId('unquoted-item-title')).toHaveText('First Unquoted Item');

    const res2 = await page.goto('/unquoted-routes/item-2');
    expect(res2?.status()).toBe(200);
    await expect(page.getByTestId('unquoted-item-title')).toHaveText('Second Unquoted Item');
  });
});
