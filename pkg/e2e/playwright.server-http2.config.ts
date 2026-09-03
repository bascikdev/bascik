/**
 * Playwright config for running E2E tests against the Bascik HTTP/2 (TLS) Production Server (`bascik --server`).
 *
 * Runs the full E2E test suite (scoping, slots, CSS, JS, components, DOM, etc.)
 * plus `data-bascik-server` script execution and prod server HTTP/2 tests
 * directly against TLS-enabled `bascik --server`.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.server-http2.config.ts
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(e2eDir, '..');
const baseFixtureDir = join(e2eDir, 'base-fixture');
const prodServerTestIgnore = [
  '**/dev-server-reload.test.ts',
  '**/dist-lifecycle.test.ts',
  // bascik add is a build-time authoring command with no runtime behavior;
  // serving a copied component is identical to serving any other component.
  '**/bascik-add.test.ts',
  '**/bascik-add-dev.test.ts',
];

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'https://localhost:9444',
    ignoreHTTPSErrors: true,
    headless: true,
  },
  projects: [
    { name: 'default', testIgnore: [...prodServerTestIgnore, '**/base-serving.test.ts'] },
    { name: 'base-server-http2', testMatch: '**/base-serving.test.ts', use: { baseURL: 'https://localhost:9553' } },
  ],
  webServer: [{
    command: [
      `BASCIK_SITE_URL=http://localhost:4200 node ${pkgDir}/dist/index.js --build`,
      `BASCIK_ENABLE_TLS=true BASCIK_SERVER_PORT=9444 node ${pkgDir}/dist/index.js --server`,
    ].join(' && '),
    cwd: e2eDir,
    url: 'https://localhost:9444/server-scripts-test',
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    stdout: 'pipe',
    stderr: 'pipe',
  }, {
    command: [
      `BASCIK_SITE_URL=https://localhost:9553 node ${pkgDir}/dist/index.js --build`,
      `BASCIK_ENABLE_TLS=true BASCIK_SERVER_PORT=9553 node ${pkgDir}/dist/index.js --server`,
    ].join(' && '),
    cwd: baseFixtureDir,
    url: 'https://localhost:9553/sub/',
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});
