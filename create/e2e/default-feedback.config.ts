import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
export default defineConfig({
  testDir: ".",
  testMatch: "default-feedback.spec.ts",
  outputDir: "../dist/default-browser-results",
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:9411" },
  webServer: {
    command: `node "${root}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9411`,
    cwd: resolve(root, "create/dist/default-verification/default"),
    url: "http://127.0.0.1:9411",
    reuseExistingServer: false,
  },
});
