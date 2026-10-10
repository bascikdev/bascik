/**
 * Real-process lane for `pipeline.onExecError`: spawns the CLI in temporary
 * projects and checks exit codes, output, and the live dev server. It needs no
 * shared web server, so it has its own config and is excluded from the lanes
 * that serve a fixture.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.exec-policy.config.ts
 */
import { defineConfig } from '@playwright/test';

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= '1';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/exec-error-policy.test.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
});
