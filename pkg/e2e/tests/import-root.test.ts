/**
 * E2E tests for the `@/` and `/` import-root aliases in build, server, and
 * `src=` scripts (see `scripts.importRoot`, default `src`).
 *
 * Fixtures:
 *   - src/lib/import-root-helper.ts        exports a marker string
 *   - src/lib/import-root-src-entry.ts     loaded via src="@/lib/…"
 *   - src/components/import-root-badge/    imports the helper via @/ and /
 *   - src/pages/import-root-test.html      depth 1, uses the component
 *   - src/pages/nested/import-root-test.html  depth 2, same component unchanged
 *   - src/pages/import-root-server-test.html  data-bascik-server with @/ import
 *
 * Applies to every config:
 *   - static build (playwright.config.ts): build-script fixtures
 *   - dev server (playwright.dev.config.ts): build-script fixtures plus the
 *     watch case (edit the helper, page updates)
 *   - HTTP/1.1 and HTTP/2 production servers: the server-script fixture
 */
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const helperPath = join(e2eDir, 'src/lib/import-root-helper.ts');
const MARKER = 'import-root-helper-v1';

type ServerMode = 'static' | 'dev' | 'prod';

// The dev server and the HTTP/1.1 production server share a port, so the mode
// is detected from observable behavior rather than baseURL: only the dev
// server injects the live-reload client, and only the static harness leaves
// server-script tags in the page (it cannot execute them).
const detectMode = async (request: import('@playwright/test').APIRequestContext): Promise<ServerMode> => {
  const response = await request.get('/import-root-server-test');
  const html = await response.text();
  if (html.includes('bascik-live-reload')) return 'dev';
  // The static build leaves an inert `type="text/bascik-server"` placeholder;
  // the production server replaces it with the executed output.
  if (html.includes('text/bascik-server')) return 'static';
  return 'prod';
};

test.describe('import-root aliases (@/ and /) in build scripts', () => {
  for (const route of ['/import-root-test', '/nested/import-root-test']) {
    test(`${route}: @/ and / imports resolve against the import root`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByTestId('import-root-alias')).toHaveText(MARKER);
      await expect(page.getByTestId('import-root-slash')).toHaveText(MARKER);
    });

    test(`${route}: src="@/…" loads from the import root and re-bases its relative imports`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByTestId('import-root-src')).toHaveText(MARKER);
    });
  }
});

test.describe('import-root aliases in server scripts', () => {
  test('data-bascik-server resolves @/ against the import root', async ({ page, request }) => {
    test.skip((await detectMode(request)) === 'static', 'the static harness cannot execute server scripts');
    await page.goto('/import-root-server-test');
    await expect(page.getByTestId('import-root-server')).toHaveText(MARKER);
  });
});

test.describe('import-root aliases: dev watcher', () => {
  let originalHelper: string;

  test.beforeAll(async () => {
    originalHelper = await readFile(helperPath, 'utf8');
  });

  test.afterEach(async () => {
    const current = await readFile(helperPath, 'utf8').catch(() => null);
    if (current !== originalHelper) {
      await writeFile(helperPath, originalHelper, 'utf8');
    }
  });

  test('editing an alias-imported helper rebuilds and live-reloads the page', async ({ page, request }) => {
    test.skip((await detectMode(request)) !== 'dev', 'watch behavior only exists on the dev server');
    await page.goto('/nested/import-root-test');
    await expect(page.getByTestId('import-root-alias')).toHaveText(MARKER);

    const updatedMarker = `import-root-helper-updated-${Date.now()}`;
    await writeFile(helperPath, originalHelper.replace(MARKER, updatedMarker), 'utf8');

    await expect(page.getByTestId('import-root-alias')).toHaveText(updatedMarker, { timeout: 15000 });
    await expect(page.getByTestId('import-root-slash')).toHaveText(updatedMarker);
    await expect(page.getByTestId('import-root-src')).toHaveText(updatedMarker);
  });
});
