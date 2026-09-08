/**
 * Playwright config for the Cloudflare adapter lane (prompts 134/135).
 *
 * Builds `e2e/cloudflare/` with `--target cloudflare-pages`, then serves the
 * emitted bundle inside local workerd (Miniflare) with the asset layer in
 * front, exactly as Pages advanced mode routes in production. This is the
 * browser half of serverless acceptance; request-level parity lives in
 * `src/lib/serverless-parity.integration.test.ts`.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.cloudflare.config.ts
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(e2eDir, '..');
const fixtureDir = join(e2eDir, 'cloudflare');
const PORT = 9876;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/cloudflare-adapter.test.ts',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  webServer: {
    command: [
      `node ${pkgDir}/dist/index.js --build --target cloudflare-pages`,
      `node ${fixtureDir}/serve.ts ${PORT}`,
    ].join(' && '),
    cwd: fixtureDir,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
