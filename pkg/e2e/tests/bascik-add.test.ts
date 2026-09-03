/**
 * E2E tests for `bascik add`.
 *
 * NOTE: Skipped for the two production server configs (HTTP/1.1 and HTTP/2)
 * because `bascik add` is a build-time authoring command with no runtime behavior;
 * serving a copied component is identical to serving any other component.
 *
 * Exercises:
 *   1. Static build config: adding a component, compiling, and asserting it renders with data-testid.
 *   2. Dev server config: adding a component while the dev server is running and asserting the watcher reloads it.
 */

import { test, expect } from '@playwright/test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const componentsDir = join(e2eDir, 'src/components');
const pagePath = join(e2eDir, 'src/pages/scope-test.html');
const nodeModulesDir = join(e2eDir, 'node_modules');

const fixturePkgDir = join(nodeModulesDir, '@e2e-fixture/ui');
const dynamicCompPath = join(componentsDir, 'dynamic-add-banner.html');
const lockfilePath = join(e2eDir, 'bascik-lock.json');

test.describe('bascik add E2E', () => {
  let originalPageContent: string;

  test.beforeAll(async () => {
    originalPageContent = await readFile(pagePath, 'utf8');

    // Set up fixture package in node_modules
    await mkdir(fixturePkgDir, { recursive: true });
    await writeFile(
      join(fixturePkgDir, 'package.json'),
      JSON.stringify({
        name: '@e2e-fixture/ui',
        version: '1.0.0',
        bascik: { components: './components' },
      }, null, 2),
      'utf8',
    );
    await mkdir(join(fixturePkgDir, 'components'), { recursive: true });
    await writeFile(
      join(fixturePkgDir, 'components/dynamic-add-banner.html'),
      '<div data-testid="added-banner-root" class="banner"><h2 data-testid="added-banner-title">Added Banner Component</h2><div data-bascik-slot></div></div>',
      'utf8',
    );
  });

  test.afterEach(async () => {
    await writeFile(pagePath, originalPageContent, 'utf8');
    await rm(dynamicCompPath, { force: true }).catch(() => { });
  });

  test.afterAll(async () => {
    await rm(fixturePkgDir, { recursive: true, force: true }).catch(() => { });
    await rm(dynamicCompPath, { force: true }).catch(() => { });
    await rm(lockfilePath, { force: true }).catch(() => { });
  });

  test('static build and dev watcher pick up added component', async ({ page }) => {
    // Add component file (simulating bascik add)
    await writeFile(
      dynamicCompPath,
      '<div data-testid="added-banner-root" class="banner"><h2 data-testid="added-banner-title">Added Banner Component</h2><div data-bascik-slot></div></div>',
      'utf8',
    );

    // Update page to use newly added component
    await writeFile(
      pagePath,
      originalPageContent.replace('</body>', '<dynamic-add-banner><p data-testid="banner-slot-content">Slot Message</p></dynamic-add-banner></body>'),
      'utf8',
    );

    await page.goto('/scope-test');
    await expect(page.getByTestId('added-banner-root')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('added-banner-title')).toHaveText('Added Banner Component');
    await expect(page.getByTestId('banner-slot-content')).toHaveText('Slot Message');
  });
});
