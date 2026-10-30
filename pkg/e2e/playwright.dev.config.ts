/**
 * Playwright config for running E2E tests against the Bascik Dev Server.
 *
 * Runs the full E2E test suite (scoping, slots, CSS, JS, components, DOM, etc.)
 * plus dev-server live-reload and watch tests directly against the live dev server.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev.config.ts
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
process.env.BASCIK_E2E_OUT ??= "dist-dev";

const e2eDir = fileURLToPath(new URL(".", import.meta.url));
const pkgDir = join(e2eDir, "..");
const baseFixtureDir = join(e2eDir, "base-fixture");
/** Specs that run against base-fixture (base path, opt-in name scoping). */
const BASE_FIXTURE_SPECS = [
  "**/base-serving.test.ts",
  "**/base-name-scoping.test.ts",
];
const symlinkFixtureDir = join(e2eDir, "symlink-fixture");
const devServerTestIgnore = [
  // server-scripts.test.ts and server-scripts-stream.test.ts run here on
  // purpose (prompt 68): the dev server shares createRequestHandler with
  // production and re-stores the server-script plan on every transpile.
  "**/prod-server.test.ts",
  "**/sitemap.test.ts",
  "**/exec.test.ts",
  "**/dist-lifecycle.test.ts",
  "**/preserve-server-form.test.ts",
  // http.httpCache defaults to false in dev, so ETags/304s are intentionally
  // absent. This suite only runs against playwright.server*.config.ts.
  "**/caching-layer.test.ts",
  // Dev-exec lifecycle runs against its own exec-fixture config.
  "**/dev-exec-lifecycle.test.ts",
  // Spawns the CLI in temporary projects; runs in its own lane.
  "**/exec-error-policy.test.ts",
];

// Specs that edit files the dev server watches (pages, components, content,
// API routes) or start extra dev servers in this fixture. They run one at a
// time in `dev-mutating`, after every read-only spec has finished in
// `dev-readonly`, so a reload or rebuild never lands on a read-only test.
// A new spec that writes under src/ or shared-components/ belongs here
// (run-lanes.test.ts fails if one is missing).
export const devSourceEditingSpecs = [
  "**/dev-server-reload.test.ts",
  "**/bascik-add-dev.test.ts",
  "**/multi-component-roots.test.ts",
  "**/import-root.test.ts",
  "**/server-scripts-stream.test.ts",
];

export default defineConfig({
  testDir: "./tests",
  // Own results dir (pkg/test-results/dev): Playwright clears its outputDir at
  // run start and keeps .last-run.json there, so lanes must not share one.
  outputDir: "../test-results/dev",
  // Ports dev-server-reload.test.ts binds for its own short-lived dev
  // servers (cold start, recovery). Read by scripts/run-lanes.ts, which
  // refuses to start if one is already bound, and by its port-collision test.
  metadata: { childServerPorts: [9989, 9992, 9993] },
  // Upper bound across projects; each project sets its own limit below.
  workers: 4,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:9445",
    headless: true,
  },
  projects: [
    {
      name: "dev-readonly",
      testIgnore: [
        ...devServerTestIgnore,
        ...devSourceEditingSpecs,
        ...BASE_FIXTURE_SPECS,
        "**/static-asset-symlinks.test.ts",
      ],
      fullyParallel: true,
      workers: 4,
    },
    {
      // Same dev server as dev-readonly, started only after it has finished.
      name: "dev-mutating",
      testMatch: devSourceEditingSpecs,
      dependencies: ["dev-readonly"],
      workers: 1,
    },
    {
      name: "base-dev",
      testMatch: BASE_FIXTURE_SPECS,
      use: { baseURL: "http://localhost:9551" },
      workers: 1,
    },
    {
      name: "asset-symlink-dev",
      testMatch: "**/static-asset-symlinks.test.ts",
      use: { baseURL: "http://localhost:9663" },
      workers: 1,
    },
  ],
  webServer: [
    {
      // Port 9445, not the prod http1 lane's 9443, so both lanes can run at
      // once. BASCIK_SITE_URL matches the value the build-time configs use so
      // the build-script env assertions behave identically in dev mode.
      command: `BASCIK_SERVER_PORT=9445 BASCIK_SITE_URL=http://localhost:4200 node ${pkgDir}/dist/index.js`,
      cwd: e2eDir,
      url: "http://localhost:9445/scope-test",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `BASCIK_SERVER_PORT=9551 BASCIK_SITE_URL=http://localhost:9551 node ${pkgDir}/dist/index.js`,
      cwd: baseFixtureDir,
      url: "http://localhost:9551/sub/",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `BASCIK_SERVER_PORT=9663 BASCIK_SITE_URL=http://localhost:9663 node ${pkgDir}/dist/index.js --config ${symlinkFixtureDir}/bascik.config.ts`,
      cwd: symlinkFixtureDir,
      url: "http://localhost:9663/",
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
