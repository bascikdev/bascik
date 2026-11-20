import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import {
  browserVerificationFixture,
  repositoryRoot,
} from "./verification-fixture.ts";

export const verification = await browserVerificationFixture("landing");
export default defineConfig({
  testDir: resolve(verification.site, "e2e"),
  testMatch: "app.spec.ts",
  outputDir: resolve(verification.root, "browser-results"),
  metadata: { verificationRoot: verification.root },
  globalTeardown: resolve(import.meta.dirname, "verification-teardown.ts"),
  workers: 1,
  use: { baseURL: "http://127.0.0.1:9412" },
  webServer: {
    command: `"${process.execPath}" "${repositoryRoot}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9412`,
    cwd: verification.site,
    url: "http://127.0.0.1:9412",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
