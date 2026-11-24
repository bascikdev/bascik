import { defineConfig } from "@playwright/test";

const PORT = 4477;

export default defineConfig({
  testDir: "./e2e",
  reporter: "line",
  // One conversation store on disk: keep the specs in one worker.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The chat must work with no client JavaScript at all.
    javaScriptEnabled: false,
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: `cd demo && bascik --build && bascik --server --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
  },
});
