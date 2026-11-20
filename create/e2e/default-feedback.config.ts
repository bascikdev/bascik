import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import {
  browserVerificationFixture,
  repositoryRoot,
} from "./verification-fixture.ts";

export const verification = await browserVerificationFixture("default");
export default defineConfig({
  testDir: ".",
  testMatch: "default-feedback.spec.ts",
  outputDir: resolve(verification.root, "browser-results"),
  metadata: { verificationRoot: verification.root },
  globalTeardown: resolve(import.meta.dirname, "verification-teardown.ts"),
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:9411" },
  webServer: {
    command: `"${process.execPath}" "${repositoryRoot}/pkg/bin/bascik.js" --server --host 127.0.0.1 --port 9411`,
    cwd: verification.site,
    url: "http://127.0.0.1:9411",
    reuseExistingServer: false,
  },
});
