import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// The port plan and README name for local workerd; `yarn ai:cf:dev` uses it
// too, so stop a dev server before running these specs.
const PORT = 9879;
/**
 * A fresh folder for the Durable Objects' data on every run. Playwright
 * loads this file again in each worker process, which inherits the
 * variable, so only the first load picks (and empties) the folder; the
 * specs read it to check what was stored.
 */
if (!process.env.BASCIK_AI_CF_E2E_PERSIST) {
  process.env.BASCIK_AI_CF_E2E_PERSIST = join(
    tmpdir(),
    `bascik-ai-cf-e2e-${process.pid}`,
  );
  rmSync(process.env.BASCIK_AI_CF_E2E_PERSIST, {
    recursive: true,
    force: true,
  });
}
const PERSIST_DIR = process.env.BASCIK_AI_CF_E2E_PERSIST;

export default defineConfig({
  testDir: "./e2e",
  reporter: "line",
  // A reply streams for seconds: give each spec room on a slow machine.
  timeout: 60_000,
  // A whole reply at this pace takes about eight seconds.
  expect: { timeout: 20_000 },
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: {
    // Local workerd through `wrangler dev`, never a deploy.
    command: "yarn build && node scripts/dev.ts",
    url: `http://127.0.0.1:${PORT}/style.css`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      PERSIST_DIR,
      // Slow enough that Stop, a reload and a second tab land mid-reply.
      DEMO_MODEL_DELAY_MS: "60",
      // Every spec sends from 127.0.0.1.
      GENUI_IP_SENDS: "10000",
    },
  },
});
