/**
 * The generated Worker in workerd under the settings an authored Wrangler
 * config deploys it with: compatibility date and flags, `html_handling` and
 * `not_found_handling` reach the harness from the generated wrangler.jsonc
 * (cloudflare-harness.test-helper.ts, readHarnessSettings), so a test here
 * runs what `wrangler deploy` would, not the adapter's defaults.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SiteGraph } from "@bascik/bascik/adapter";
import { build } from "./build.ts";
import {
  readHarnessSettings,
  startHarness,
  type Harness,
} from "./cloudflare-harness.test-helper.ts";

interface SiteOptions {
  variant?: "pages" | "workers";
  /** dist-relative file -> body. */
  files?: Record<string, string>;
  /** An authored wrangler.jsonc at the project root. */
  wrangler?: string;
  /** project-relative module file -> source, one API route each. */
  apiRoutes?: Record<string, { path: string; source: string }>;
  csp?: SiteGraph["contentSecurityPolicy"];
  logs?: string[];
}

const roots: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const buildSite = async (options: SiteOptions = {}) => {
  const variant = options.variant ?? "workers";
  const root = await mkdtemp(join(tmpdir(), "bascik-cf-authored-"));
  roots.push(root);
  const distDir = join(root, "dist");
  const outDir = join(distDir, ".bascik", `cloudflare-${variant}`);
  await mkdir(join(outDir, ".staging"), { recursive: true });
  const files = { "index.html": "<p>home</p>", ...options.files };
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(distDir, file)), { recursive: true });
    await writeFile(join(distDir, file), body);
  }
  if (options.wrangler !== undefined)
    await writeFile(join(root, "wrangler.jsonc"), options.wrangler);
  const apiRoutes: SiteGraph["apiRoutes"] = [];
  for (const [file, route] of Object.entries(options.apiRoutes ?? {})) {
    const filePath = join(root, file);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, route.source);
    apiRoutes.push({
      path: route.path,
      filePath,
      paramNames: [],
      isDynamic: false,
    });
  }
  const graph: SiteGraph = {
    base: "/",
    release: "test-rel",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    publicFiles: Object.keys(files),
    pages: {},
    apiRoutes,
    importRoot: root,
    ...(options.csp ? { contentSecurityPolicy: options.csp } : {}),
  };
  const result = await build({
    graph,
    distDir,
    outDir,
    projectRoot: root,
    variant,
    log: (message) => options.logs?.push(message),
    runtimeEntry: "",
  });
  return { root, outDir, result, variant };
};

const serve = async (site: Awaited<ReturnType<typeof buildSite>>) => {
  const harness = await startHarness({
    projectRoot: site.root,
    target: `cloudflare-${site.variant}`,
  });
  harnesses.push(harness);
  return harness;
};

describe("the harness runs the Worker under the generated wrangler.jsonc's settings", () => {
  it("reads an authored compatibility date and flags, html_handling and not_found_handling", async () => {
    const site = await buildSite({
      wrangler: JSON.stringify({
        compatibility_date: "2026-09-01",
        compatibility_flags: ["enable_nodejs_os_module"],
        assets: {
          html_handling: "force-trailing-slash",
          not_found_handling: "none",
        },
      }),
    });
    const settings = await readHarnessSettings(
      await realpath(site.outDir),
      "cloudflare-workers",
    );
    expect(settings.compatibilityDate).toBe("2026-09-01");
    expect(settings.compatibilityFlags).toEqual([
      "enable_nodejs_os_module",
      "nodejs_compat",
    ]);
    expect(settings.assetConfig).toEqual({
      html_handling: "force-trailing-slash",
      not_found_handling: "none",
    });
  }, 60_000);

  it("without an authored config, the adapter's pinned settings and Cloudflare's asset defaults", async () => {
    const site = await buildSite();
    const wrangler = JSON.parse(
      await readFile(join(site.outDir, "wrangler.jsonc"), "utf8"),
    ) as { compatibility_date: string };
    const settings = await readHarnessSettings(
      await realpath(site.outDir),
      "cloudflare-workers",
    );
    expect(settings.compatibilityDate).toBe(wrangler.compatibility_date);
    expect(settings.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(settings.assetConfig).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
    });
  }, 60_000);

  it("an authored html_handling and not_found_handling change what workerd serves, as they would deployed", async () => {
    const site = await buildSite({
      files: { "about.html": "<p>about</p>", "404.html": "<p>lost</p>" },
      wrangler: JSON.stringify({
        assets: {
          html_handling: "force-trailing-slash",
          not_found_handling: "none",
        },
      }),
    });
    const harness = await serve(site);
    const about = await harness.fetch("/about", { redirect: "manual" });
    await about.arrayBuffer();
    expect(about.status).toBe(307);
    expect(about.headers.get("location")).toBe("/about/");
    const missing = await harness.fetch("/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("lost");
  }, 60_000);
});
