import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "adapter-dev.test.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  use: { headless: true },
});
