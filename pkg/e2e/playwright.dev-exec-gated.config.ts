/**
 * Gated variant of the exec producer/consumer dev E2E (prompt 109).
 *
 * Starts the same exec-fixture dev server with BASCIK_GENERATOR_GATE=1 so the
 * producer holds each completion behind an HTTP release server, letting a test
 * observe the served page keep last-known-good while the producer is in flight
 * and then update exactly once on release.
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