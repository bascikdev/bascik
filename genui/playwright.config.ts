import { defineConfig } from "@playwright/test";

const PORT = 4477;
const MODEL_PORT = 4479;

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
  webServer: [
    {
      // A stand-in for a local model server, so the selector has one to list.
      command: `node e2e/fake-model-server.ts ${MODEL_PORT}`,
      url: `http://127.0.0.1:${MODEL_PORT}/v1/models`,
      reuseExistingServer: false,
    },
    {
      command: `cd demo && bascik --build && bascik --server --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        // Only the stand-in: never whatever runs on the developer's machine.
        GENUI_LOCAL_MODELS: "0",
        OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
        OPENAI_LABEL: "Test server",
      },
    },
  ],
});
