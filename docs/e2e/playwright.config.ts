import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= '1';

const e2eDir = fileURLToPath(new URL('.', import.meta.url));
const pkgIndex = join(e2eDir, '../../pkg/dist/index.js');
const e2ePort = process.env.BASCIK_E2E_PORT ?? '8080';
const baseURL = `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: './',
  workers: 4,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: `BASCIK_SITE_URL=https://bascik.dev node ${pkgIndex} --build && node ${pkgIndex} --server --port ${e2ePort}`,
    cwd: join(e2eDir, '..'),
    url: baseURL,
    reuseExistingServer: !process.env.CI && !process.env.BASCIK_E2E_PORT,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
