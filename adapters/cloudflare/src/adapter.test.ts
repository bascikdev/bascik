import { describe, it, expect } from "vitest";
import adapter from "./index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readFile } from "node:fs/promises";
import type { SiteGraph } from "@bascik/bascik/adapter";

describe("cloudflare adapter definition and execution", () => {
  it("default export defines cloudflare adapter", () => {
    expect(adapter.name).toBe("cloudflare");
    expect(typeof adapter.build).toBe("function");
  });

  it("build with variant 'pages' writes public/_worker.js and public/_routes.json", async () => {
    const testDir = join(tmpdir(), `bascik-cf-pages-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-pages");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const graph: SiteGraph = {
      base: "/",
      release: "test-rel",
      scriptTimeoutMs: 1000,
      apiTimeoutMs: 1000,
      onServerScriptError: "error",
      publicFiles: [],
      pages: {},
      apiRoutes: [],
      importRoot: testDir,
    };

    try {
      const result = await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "pages",
        log: () => {},
        runtimeEntry: "",
      });

      expect(result.workerPath).toBe(join(outDir, "public/_worker.js"));
      const routesJson = await readFile(join(outDir, "public/_routes.json"), "utf8");
      expect(JSON.parse(routesJson).version).toBe(1);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("build with variant 'workers' writes worker.js, wrangler.jsonc, public/", async () => {
    const testDir = join(tmpdir(), `bascik-cf-workers-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-workers");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const graph: SiteGraph = {
      base: "/",
      release: "test-rel",
      scriptTimeoutMs: 1000,
      apiTimeoutMs: 1000,
      onServerScriptError: "error",
      publicFiles: [],
      pages: {},
      apiRoutes: [],
      importRoot: testDir,
    };

    try {
      const result = await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });

      expect(result.workerPath).toBe(join(outDir, "worker.js"));
      const wrangler = await readFile(join(outDir, "wrangler.jsonc"), "utf8");
      expect(JSON.parse(wrangler).main).toBe("worker.js");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("throws on unknown variant naming both valid ones", async () => {
    const testDir = join(tmpdir(), `bascik-cf-invalid-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-invalid");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const graph: SiteGraph = {
      base: "/",
      release: "test-rel",
      scriptTimeoutMs: 1000,
      apiTimeoutMs: 1000,
      onServerScriptError: "error",
      publicFiles: [],
      pages: {},
      apiRoutes: [],
      importRoot: testDir,
    };

    try {
      await expect(
        adapter.build({
          graph,
          distDir,
          outDir,
          projectRoot: testDir,
          variant: "invalid",
          log: () => {},
          runtimeEntry: "",
        }),
      ).rejects.toThrow(/unknown variant "invalid". Valid variants are "pages" and "workers"/);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
