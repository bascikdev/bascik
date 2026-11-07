import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  use: { baseURL: "http://127.0.0.1:8790", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"], deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: "node scripts/serve-tests.ts",
    url: "http://127.0.0.1:8790",
    reuseExistingServer: false,
  },
});
