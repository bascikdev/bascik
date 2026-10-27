import { defineConfig } from "@playwright/test";

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= "1";

export default defineConfig({
  testDir: "./tests",
  // Own results dir (pkg/test-results/exec-build): Playwright clears its outputDir at
  // run start and keeps .last-run.json there, so lanes must not share one.
  outputDir: "../test-results/exec-build",
  testMatch: "**/exec-build-lifecycle.test.ts",
  workers: 1,
  timeout: 20_000,
});
