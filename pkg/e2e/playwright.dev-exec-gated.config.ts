/**
 * Gated variant of the source-owned exec lifecycle E2E.
 *
 * Starts the same exec-fixture dev server with BASCIK_GENERATOR_GATE=1 so the
 * script writes an unwatched dist artifact, then holds behind an HTTP gate.
 * The associated page must wait for pre to exit and compile only once.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev-exec-gated.config.ts
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(e2eDir, '..');
const fixtureDir = join(e2eDir, 'exec-fixture');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/dev-exec-lifecycle.test.ts',
  grep: /gated/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:9661',
    headless: true,
  },
  webServer: [{
    // See playwright.dev-exec.config.ts for why the wrapper replaces `| tee`.
    command: `node scripts/run-dev-logged.mjs ${pkgDir}/dist/index.js`,
    env: { BASCIK_SERVER_PORT: '9661', BASCIK_GENERATOR_GATE: '1' },
    cwd: fixtureDir,
    url: 'http://localhost:9661/consumer',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});