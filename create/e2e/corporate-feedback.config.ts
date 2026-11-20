import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import {
  browserVerificationFixture,
  repositoryRoot,
} from "./verification-fixture.ts";

export const verification = await browserVerificationFixture("corporate");
export default defineConfig({
  testDir: ".",
  testMatch: "corporate-feedback.spec.ts",
  outputDir: resolve(verification.root, "browser-results"),
  metadata: { verificationRoot: verification.root },
  globalTeardown: resolve(import.meta.dirname, "verification-teardown.ts"),
  reporter: "list",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:9413", trace: "retain-on-failure" },
  webServer: {
    command: `"${process.execPath}" "${repositoryRoot}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9413`,
    cwd: verification.site,
    url: "http://127.0.0.1:9413",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
