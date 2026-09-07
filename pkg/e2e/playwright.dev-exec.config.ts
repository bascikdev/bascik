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
 * live and serving before the parallel entry finishes, and that completion
 * does not recompile pages.
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
    // `run-dev-logged.mjs` resets the generator's persistent counter and gate
    // marker (runtime state from a previous run) so "startup runs exactly
    // once" asserts against this boot, then spawns the dev server and mirrors
    // its output to `.dev-server.log` so the suite can collect the lines
    // between two markers and assert which watched edits recompiled pages.
    // Unlike a `| tee` pipeline, the wrapper
    // propagates the server's exit code and signals, so a crashed or killed
    // server is never hidden behind tee's exit status or left orphaned.
    command: `node scripts/run-dev-logged.mjs ${pkgDir}/dist/index.js`,
    env: { BASCIK_SERVER_PORT: '9661', BASCIK_PARALLEL_GATE: '1' },
    cwd: fixtureDir,
    url: 'http://localhost:9661/consumer',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  }],
});