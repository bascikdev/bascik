/**
 * E2E tests for `directory.components: string | string[]` (prompt 80).
 *
 * Fixtures:
 *   - e2e/bascik.config.ts               components: ['src/components', 'shared-components']
 *   - e2e/shared-components/shared-badge/  subfolder layout in the SECOND root with a
 *                                          companion shared-badge.ts (matched by folder)
 *   - e2e/linked-components/linked-badge/  outside every root; reached only via the
 *                                          committed symlink src/components/linked-badge
 *   - e2e/src/pages/multi-component-roots-test.html  uses all three
 *
 * Applies to every config. The dev-watcher cases only run against
 * playwright.dev.config.ts and prove (a) the second root is watched and
 * (b) the components watcher follows symlinks.
 */
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const sharedBadgePath = join(e2eDir, 'shared-components/shared-badge/shared-badge.html');
// Edited through its REAL path, not the link, so a rebuild proves the watcher
// followed the symlink rather than merely watching the link entry.
const linkedBadgeRealPath = join(e2eDir, 'linked-components/linked-badge/linked-badge.html');

const isDevServer = async (request: import('@playwright/test').APIRequestContext): Promise<boolean> => {
  const html = await (await request.get('/multi-component-roots-test')).text();
  return html.includes('bascik-live-reload');
};

test.describe('multiple component roots', () => {
  test('renders a component from the first root', async ({ page }) => {
    await page.goto('/multi-component-roots-test');
    await expect(page.getByTestId('first-root-card')).toContainText('From src/components');
  });

  test('renders a component from the second root and runs its companion script', async ({ page }) => {
    await page.goto('/multi-component-roots-test');
    await expect(page.getByTestId('shared-badge')).toBeVisible();
    await expect(page.getByTestId('shared-badge-label')).toHaveText('shared-badge-v1');
    // Only the subfolder rule attaches shared-badge.ts; the flat-layout
    // basename rule would leave this at "pending".
    await expect(page.getByTestId('shared-badge-script-ran')).toHaveText('companion-script-ran');
  });

  test('renders a component reached through a symlinked directory inside a root', async ({ page }) => {
    await page.goto('/multi-component-roots-test');
    await expect(page.getByTestId('linked-badge')).toHaveText('linked-badge-v1');
  });
});

test.describe('multiple component roots: dev watcher', () => {
  let originalShared: string;
  let originalLinked: string;

  test.beforeAll(async () => {
    originalShared = await readFile(sharedBadgePath, 'utf8');
    originalLinked = await readFile(linkedBadgeRealPath, 'utf8');
  });

  test.afterEach(async () => {
    if ((await readFile(sharedBadgePath, 'utf8')) !== originalShared) {
      await writeFile(sharedBadgePath, originalShared, 'utf8');
    }
    if ((await readFile(linkedBadgeRealPath, 'utf8')) !== originalLinked) {
      await writeFile(linkedBadgeRealPath, originalLinked, 'utf8');
    }
  });

  test('editing a component in the second root rebuilds the page', async ({ page, request }) => {
    test.skip(!(await isDevServer(request)), 'watch behavior only exists on the dev server');
    await page.goto('/multi-component-roots-test');
    await expect(page.getByTestId('shared-badge-label')).toHaveText('shared-badge-v1');

    const marker = `shared-badge-updated-${Date.now()}`;
    await writeFile(sharedBadgePath, originalShared.replace('shared-badge-v1', marker), 'utf8');

    await expect(page.getByTestId('shared-badge-label')).toHaveText(marker, { timeout: 15000 });
  });

  test('editing a symlinked component through its real path rebuilds the page', async ({ page, request }) => {
    test.skip(!(await isDevServer(request)), 'watch behavior only exists on the dev server');
    await page.goto('/multi-component-roots-test');
    await expect(page.getByTestId('linked-badge')).toHaveText('linked-badge-v1');

    const marker = `linked-badge-updated-${Date.now()}`;
    await writeFile(linkedBadgeRealPath, originalLinked.replace('linked-badge-v1', marker), 'utf8');

    await expect(page.getByTestId('linked-badge')).toHaveText(marker, { timeout: 15000 });
  });
});
