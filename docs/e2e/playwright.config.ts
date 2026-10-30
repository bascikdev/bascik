import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseE2ePort } from "./site.ts";

// Recompute every reused scoping result and fail on any difference (scoping-template.ts).
process.env.BASCIK_VERIFY_SCOPING_TEMPLATES ??= "1";

const e2eDir = fileURLToPath(new URL(".", import.meta.url));
const pkgIndex = join(e2eDir, "../../pkg/dist/index.js");
const e2ePort = parseE2ePort(process.env.BASCIK_E2E_PORT);
const baseURL = `http://localhost:${e2ePort}`;
// e2e/bascik.config.ts builds into docs/.e2e/dist (site.ts), so a running `yarn docs:dev` (port 8080, docs/dist)
// and this run never share an output directory, a private .bascik folder, or a port.
const bascik = `node ${pkgIndex} --config e2e/bascik.config.ts`;

export default defineConfig({
  testDir: "./",
  // Runs after the web server is up: pays the server's first-request compression of the search index.
  globalSetup: "./warm-server.ts",
  workers: 4,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: `BASCIK_SITE_URL=https://bascik.dev ${bascik} --build && ${bascik} --server --port ${e2ePort}`,
    cwd: join(e2eDir, ".."),
    url: baseURL,
    // A server already on the port is used only when BASCIK_E2E_PORT names it (one started with `yarn e2e:serve`).
    // Otherwise a taken port fails the run instead of testing whatever answers there.
    reuseExistingServer:
      !process.env.CI && Boolean(process.env.BASCIK_E2E_PORT),
    stdout: "pipe",
    stderr: "pipe",
  },
});
