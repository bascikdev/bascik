import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/exec-build-lifecycle.test.ts',
  workers: 1,
  timeout: 20_000,
});