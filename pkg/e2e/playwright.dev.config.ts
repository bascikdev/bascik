/**
 * Playwright config for running E2E tests against the Bascik Dev Server.
 *
 * Runs the full E2E test suite (scoping, slots, CSS, JS, components, DOM, etc.)
 * plus dev-server live-reload and watch tests directly against the live dev server.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev.config.ts
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(e2eDir, '..');

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/server-scripts.test.ts', '**/prod-server.test.ts', '**/sitemap.test.ts', '**/exec.test.ts'],
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:9443',
    headless: true,
  },
  webServer: {
    command: `BASCIK_SERVE_PORT=9443 node ${pkgDir}/dist/index.js`,
    cwd: e2eDir,
    url: 'http://localhost:9443/scope-test',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
