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
const baseFixtureDir = join(e2eDir, 'base-fixture');
const devServerTestIgnore = [
  '**/server-scripts.test.ts',
  '**/prod-server.test.ts',
  '**/sitemap.test.ts',
  '**/exec.test.ts',
  '**/dist-lifecycle.test.ts',
  '**/preserve-server-form.test.ts',
];

export default defineConfig({
  testDir: './tests',
  testIgnore: devServerTestIgnore,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:9443',
    headless: true,
  },
  projects: [
    { name: 'default', testIgnore: [...devServerTestIgnore, '**/base-serving.test.ts'] },
    { name: 'base-dev', testMatch: '**/base-serving.test.ts', use: { baseURL: 'http://localhost:9551' } },
  ],
  webServer: [{
    // BASCIK_SITE_URL matches the value the build-time configs use so the
    // build-script env assertions behave identically in dev mode.
    command: `BASCIK_SERVER_PORT=9443 BASCIK_SITE_URL=http://localhost:4200 node ${pkgDir}/dist/index.js`,
    cwd: e2eDir,
    url: 'http://localhost:9443/scope-test',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }, {
    command: `BASCIK_SERVER_PORT=9551 BASCIK_SITE_URL=http://localhost:9551 node ${pkgDir}/dist/index.js`,
    cwd: baseFixtureDir,
    url: 'http://localhost:9551/sub/',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});
