/**
 * Playwright config for running E2E tests against the Bascik HTTP/1.1 Production Server (`bascik --server`).
 *
 * Runs the full E2E test suite (scoping, slots, CSS, JS, components, DOM, etc.)
 * plus `data-bascik-server` script execution and prod server HTTP/1.1 tests
 * directly against cleartext `bascik --server`.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.server.config.ts
 */
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= "1";

// Each main lane builds into its own output directory (pkg/e2e and
// base-fixture read it as directory.out) so the lanes can run at the same
// time without one lane's build or dev-server cleanup erasing another's.
// Set before the webServer commands start, so it reaches them and the workers.
process.env.BASCIK_E2E_OUT ??= "dist-http1";

const e2eDir = fileURLToPath(new URL(".", import.meta.url));
const pkgDir = join(e2eDir, "..");
const baseFixtureDir = join(e2eDir, "base-fixture");
/** Specs that run against base-fixture (base path, opt-in name scoping). */
const BASE_FIXTURE_SPECS = [
  "**/base-serving.test.ts",
  "**/base-name-scoping.test.ts",
];
const prodServerTestIgnore = [
  // Dedicated to the symlink-enabled live-dev fixture.
  "**/static-asset-symlinks.test.ts",
  "**/dev-server-reload.test.ts",
  "**/dist-lifecycle.test.ts",
  // bascik add is a build-time authoring command with no runtime behavior;
  // serving a copied component is identical to serving any other component.
  "**/bascik-add.test.ts",
  "**/bascik-add-dev.test.ts",
  // Dev-exec lifecycle runs against its own exec-fixture config.
  "**/dev-exec-lifecycle.test.ts",
  // Spawns the CLI in temporary projects; runs in its own lane.
  "**/exec-error-policy.test.ts",
];

export default defineConfig({
  testDir: "./tests",
  // Own results dir (pkg/test-results/http1): Playwright clears its outputDir at
  // run start and keeps .last-run.json there, so lanes must not share one.
  outputDir: "../test-results/http1",
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:9443",
    ignoreHTTPSErrors: true,
    headless: true,
  },
  projects: [
    {
      name: "default",
      testIgnore: [...prodServerTestIgnore, ...BASE_FIXTURE_SPECS],
    },
    {
      name: "base-server",
      testMatch: BASE_FIXTURE_SPECS,
      use: { baseURL: "http://localhost:9552" },
    },
  ],
  webServer: [
    {
      command: [
        `BASCIK_SITE_URL=http://localhost:4200 node ${pkgDir}/dist/index.js --build`,
        `BASCIK_ENABLE_TLS=false BASCIK_SERVER_PORT=9443 node ${pkgDir}/dist/index.js --server`,
      ].join(" && "),
      cwd: e2eDir,
      url: "http://localhost:9443/server-scripts-test",
      reuseExistingServer: false,
      ignoreHTTPSErrors: true,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: [
        `BASCIK_SITE_URL=http://localhost:9552 node ${pkgDir}/dist/index.js --build`,
        `BASCIK_ENABLE_TLS=false BASCIK_SERVER_PORT=9552 node ${pkgDir}/dist/index.js --server`,
      ].join(" && "),
      cwd: baseFixtureDir,
      url: "http://localhost:9552/sub/",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
