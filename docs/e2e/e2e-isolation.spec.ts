// The e2e run builds and serves its own copy of the site, so it can run while `yarn docs:dev` serves port 8080 and
// writes docs/dist. Sharing either one broke both: the e2e build could not clear dist/ while the dev server wrote
// it, the run reused the dev server (no CSP <meta>, unminified), and a dev rebuild overwrote the production files
// the dist specs read.

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import config from "./playwright.config.ts";
import e2eSiteConfig from "./bascik.config.ts";
import { DEV_PORT, E2E_DIST_DIR, parseE2ePort } from "./site.ts";

const docsDir = fileURLToPath(new URL("..", import.meta.url));
const webServer = Array.isArray(config.webServer)
  ? config.webServer[0]
  : config.webServer;

test.describe("e2e runs beside the dev server", () => {
  test("serves on its own port, never the dev server's", () => {
    expect(new URL(String(config.use?.baseURL)).port).not.toBe(
      String(DEV_PORT),
    );
  });

  test("starts its own server unless BASCIK_E2E_PORT names one", () => {
    test.skip(
      Boolean(process.env.BASCIK_E2E_PORT),
      "BASCIK_E2E_PORT asks to reuse a running server",
    );
    expect(webServer?.reuseExistingServer).toBe(false);
  });

  test("builds and serves with the e2e config, into its own output directory", () => {
    const halves = String(webServer?.command).split("&&");
    expect(halves).toHaveLength(2);
    for (const half of halves)
      expect(half).toContain("--config e2e/bascik.config.ts");
    expect(e2eSiteConfig.directory?.out).toBe(E2E_DIST_DIR);
    expect(E2E_DIST_DIR).not.toBe(join(docsDir, "dist"));
    // Bascik keeps private build files in <parent of out>/.bascik/<name of out>, so a different parent keeps the
    // dev server's .bascik/dist apart from the e2e one even though both output folders are named dist.
    expect(dirname(E2E_DIST_DIR)).not.toBe(dirname(join(docsDir, "dist")));
  });

  test("the server answers with the e2e build", async ({ request }) => {
    const [served, built] = await Promise.all([
      request.get("/", { headers: { "accept-encoding": "identity" } }),
      readFile(join(E2E_DIST_DIR, "index.html"), "utf8"),
    ]);
    expect(served.status()).toBe(200);
    expect(await served.text()).toBe(built);
  });
});

test.describe("BASCIK_E2E_PORT", () => {
  test("unset or empty falls back to the e2e default port", () => {
    expect(parseE2ePort(undefined)).toBe(parseE2ePort(""));
    expect(parseE2ePort(undefined)).not.toBe(DEV_PORT);
  });

  test("accepts a port number", () => {
    expect(parseE2ePort("9123")).toBe(9123);
    expect(parseE2ePort(" 9123 ")).toBe(9123);
  });

  for (const value of ["abc", "80a", "0", "65536", "-1", "9.5", "80 80"])
    test(`rejects ${JSON.stringify(value)} with an error that names the variable`, () => {
      expect(() => parseE2ePort(value)).toThrow(
        `BASCIK_E2E_PORT must be a port number from 1 to 65535 (received ${JSON.stringify(value)})`,
      );
    });
});
