import { test, expect } from '@playwright/test';

// The page loads a real npm custom element (@zachleat/heading-anchors) that the
// docs build publishes with a pipeline.exec step. These tests prove the whole path
// works in a browser against the production HTTP server: the file is served, the
// element upgrades, and the links it adds point at the right headings.
test.describe('Third-party web components how-to', () => {
  test('publishes the module and serves it as JavaScript', async ({ request }) => {
    const response = await request.get('/assets/vendor/heading-anchors.js');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type'] ?? '').toMatch(/javascript/);
    expect(await response.text()).toContain('customElements');
  });

  test('upgrades the element and adds working heading links', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/how-to/third-party-web-components');
    const demo = page.getByTestId('heading-anchors-demo');
    await expect(demo).toBeVisible();

    // The element is defined by the module, so this resolves only after it ran.
    await page.waitForFunction("customElements.get('heading-anchors') !== undefined");

    const links = demo.locator('a.ha');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('href', '#install');
    await expect(links.nth(1)).toHaveAttribute('href', '#publish');

    // Each link has an accessible name that names its heading.
    await expect(links.nth(0)).toContainText('Install');
    await expect(links.nth(1)).toContainText('Publish');

    // Following a link moves to the heading it names.
    await links.nth(1).focus();
    await expect(links.nth(1)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#publish$/);

    expect(errors).toEqual([]);
  });

  test('leaves plain headings in place when scripts are disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/how-to/third-party-web-components');
      const demo = page.getByTestId('heading-anchors-demo');
      await expect(demo.getByRole('heading', { name: 'Install' })).toBeVisible();
      await expect(demo.getByRole('heading', { name: 'Publish' })).toBeVisible();
      await expect(demo.locator('a.ha')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
