import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const site = resolve(root, "create/dist/default-verification/default");
export default defineConfig({
  testDir: resolve(site, "e2e"),
  testMatch: "app.spec.ts",
  outputDir: "../dist/default-generated-browser-results",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:9411" },
  webServer: {
    command: `node "${root}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9411`,
    cwd: site,
    url: "http://127.0.0.1:9411",
    reuseExistingServer: false,
  },
});
