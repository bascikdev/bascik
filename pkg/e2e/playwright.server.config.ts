/**
 * Playwright config for running E2E tests against the Bascik HTTP/1.1 Production Server (`bascik --server`).
 *
 * Runs the full E2E test suite (scoping, slots, CSS, JS, components, DOM, etc.)
 * plus `data-bascik-server` script execution and prod server HTTP/1.1 tests
 * directly against cleartext `bascik --server`.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.server.config.ts
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(e2eDir, '..');
const baseFixtureDir = join(e2eDir, 'base-fixture');

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/dev-server-reload.test.ts', '**/dist-lifecycle.test.ts'],
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:9443',
    ignoreHTTPSErrors: true,
    headless: true,
  },
  projects: [
    { name: 'default', testIgnore: '**/base-serving.test.ts' },
    { name: 'base-server', testMatch: '**/base-serving.test.ts', use: { baseURL: 'http://localhost:9552' } },
  ],
  webServer: [{
    command: [
      `BASCIK_SITE_URL=http://localhost:4200 node ${pkgDir}/dist/index.js --build`,
      `BASCIK_ENABLE_TLS=false BASCIK_SERVER_PORT=9443 node ${pkgDir}/dist/index.js --server`,
    ].join(' && '),
    cwd: e2eDir,
    url: 'http://localhost:9443/server-scripts-test',
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    stdout: 'pipe',
    stderr: 'pipe',
  }, {
    command: [
      `BASCIK_SITE_URL=http://localhost:9552 node ${pkgDir}/dist/index.js --build`,
      `BASCIK_ENABLE_TLS=false BASCIK_SERVER_PORT=9552 node ${pkgDir}/dist/index.js --server`,
    ].join(' && '),
    cwd: baseFixtureDir,
    url: 'http://localhost:9552/sub/',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});
