/**
 * E2E tests for static asset copying, exclusions, and inlined stylesheet handling.
 *
 * Verifies:
 *   1. Non-HTML static assets in pages/ (e.g. static-asset-test.css) ARE copied to dist/ and served
 *   2. TypeScript files (helper.ts) and test files (sample.test.ts) in pages/ ARE NOT copied to dist/
 *   3. Configured inlineStyles (src/css/inlined-global.css) ARE inlined into page <head> blocks
 *   4. Configured inlineStyles ARE NOT copied as standalone static files to dist/
 */
import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SECRET_MARKER = 'BASCIK_E2E_ASSET_LEAK_MARKER';

test.describe('Static Assets & Inlined Styles handling', () => {

  test('serves static assets copied from src/pages/ with HTTP 200 and proper content-type', async ({ request }) => {
    const res = await request.get('/static-asset-test.css');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');

    const text = await res.text();
    expect(text).toContain('.static-asset-box');
  });

  test('does NOT serve TypeScript source files (.ts) from src/pages/', async ({ request }) => {
    const res = await request.get('/helper.ts');
    expect(res.status()).toBe(404);
  });

  test('does NOT serve test files (*.test.ts) from src/pages/', async ({ request }) => {
    const res = await request.get('/sample.test.ts');
    expect(res.status()).toBe(404);
  });

  test('does not ship denied source assets', async ({ request }) => {
    for (const path of ['/.env', '/secret.js.map', '/.bascik/manifest.json', '/.bascik/csp-hashes.json', '/.bascik/server-scripts.json']) {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
    }
  });

  test('serves page assets whose extension is outside MIME_MAP', async ({ request }) => {
    const response = await request.get('/templates/card.hbs');
    expect(response.status()).toBe(200);
    await expect(response.text()).resolves.toContain('unknown extension asset fixture');
  });

  test('does not write the secret marker anywhere in build output', async () => {
    const distDirectory = join(import.meta.dirname, '..', 'dist');
    const entries = await readdir(distDirectory, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const contents = await Promise.all(
      files.map((entry) => readFile(join(entry.parentPath, entry.name)).catch(() => Buffer.alloc(0))),
    );

    expect(contents.some((content) => content.includes(SECRET_MARKER))).toBe(false);
  });

  test('inlines configured inlineStyles into HTML page <head>', async ({ page }) => {
    await page.goto('/scope-test');

    const hasInlinedStyles = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll('head style'));
      return styles.some((s) => s.textContent?.includes('--e2e-inlined-var'));
    });
    expect(hasInlinedStyles).toBe(true);
  });

  test('does NOT copy inlined stylesheets as standalone static files to dist/', async ({ request }) => {
    const res1 = await request.get('/src/css/inlined-global.css');
    expect(res1.status()).toBe(404);

    const res2 = await request.get('/css/inlined-global.css');
    expect(res2.status()).toBe(404);

    const res3 = await request.get('/inlined-global.css');
    expect(res3.status()).toBe(404);
  });

  test('does not leak API handler source code into build output or static assets', async () => {
    const API_MARKER = 'SECRET_SOURCE_CODE_MARKER_API_HANDLER_DO_NOT_LEAK_12345';
    const distDirectory = join(import.meta.dirname, '..', 'dist');
    const entries = await readdir(distDirectory, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const contents = await Promise.all(
      files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')),
    );

    // No emitted file should contain the API handler source code marker
    expect(contents.some((content) => content.includes(API_MARKER))).toBe(false);
    // No .ts file from src/api should be in dist/
    expect(files.some((f) => f.name.endsWith('.ts'))).toBe(false);
  });
});
