/**
 * Playwright config for running E2E tests against the Bascik Dev Server
 * using a dedicated fixture that exercises exec producer/consumer lifecycle
 * ownership (prompt 109).
 *
 * The dev server is started from `e2e/exec-fixture/` with its own
 * `bascik.config.ts` that wires a watched pre-phase generator to a page whose
 * build script consumes the generated literal `dist/generated.json` path.
 *
 * BASCIK_PARALLEL_GATE=1 holds the fixture's `phase: 'parallel'` producer
 * behind an HTTP gate (prompt 137) so the suite can prove the dev server is
 * live and serving before the parallel entry finishes, and that its output is
 * published once on release.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev-exec.config.ts
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
  grepInvert: /gated/,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:9661',
    headless: true,
  },
  webServer: [{
    command: `BASCIK_SERVER_PORT=9661 BASCIK_PARALLEL_GATE=1 node ${pkgDir}/dist/index.js`,
    cwd: fixtureDir,
    url: 'http://localhost:9661/consumer',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});