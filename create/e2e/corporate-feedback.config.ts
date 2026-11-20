import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
export default defineConfig({
  testDir: ".",
  testMatch: "corporate-feedback.spec.ts",
  outputDir: "../dist/corporate-browser-results",
  reporter: "list",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:9413", trace: "retain-on-failure" },
  webServer: {
    command: `export PATH=/Users/collin/.nvm/versions/node/v26.13.0/bin:$PATH; node "${root}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9413`,
    cwd: resolve(root, "create/dist/corporate-verification/corporate"),
    url: "http://127.0.0.1:9413",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
