import { defineConfig } from '@playwright/test';

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= '1';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/exec-build-lifecycle.test.ts',
  workers: 1,
  timeout: 20_000,
});