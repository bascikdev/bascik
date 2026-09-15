import { describe, it, expect } from "vitest";
import adapter from "./index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import type { SiteGraph } from "@bascik/bascik/adapter";

describe("cloudflare adapter definition and execution", () => {
  it("default export defines cloudflare adapter", () => {
    expect(adapter.name).toBe("cloudflare");
    expect(typeof adapter.build).toBe("function");
  });

  it("build without explicit variant defaults to 'workers' writing worker.js, wrangler.jsonc, public/", async () => {
    const testDir = join(tmpdir(), `bascik-cf-default-${Date.now()}`);
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
        log: () => {},
        runtimeEntry: "",
      });

      expect(result.workerPath).toBe(join(outDir, "worker.js"));
      const wrangler = await readFile(join(outDir, "wrangler.jsonc"), "utf8");
      const parsed = JSON.parse(wrangler);
      expect(parsed.main).toBe("worker.js");
      expect(parsed.assets).toEqual({
        directory: "./public",
        binding: "ASSETS",
        not_found_handling: "404-page",
        run_worker_first: ["/_routes.json", "/_worker.js"],
      });
      expect(parsed.compatibility_date).toBeDefined();
      expect(Array.isArray(parsed.compatibility_flags)).toBe(true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
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

  it("derives worker name from wrangler config, package.json, or environment variable", async () => {
    const testDir = join(tmpdir(), `bascik-cf-worker-name-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-workers");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    await writeFile(
      join(testDir, "package.json"),
      JSON.stringify({ name: "@my-org/custom-worker-app" }),
      "utf8",
    );

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
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });

      const wrangler = JSON.parse(await readFile(join(outDir, "wrangler.jsonc"), "utf8"));
      expect(wrangler.name).toBe("custom-worker-app");

      // Test root wrangler.jsonc takes precedence over package.json
      await writeFile(
        join(testDir, "wrangler.jsonc"),
        JSON.stringify({ name: "authored-wrangler-name" }),
        "utf8",
      );
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });
      const authoredWrangler = JSON.parse(await readFile(join(outDir, "wrangler.jsonc"), "utf8"));
      expect(authoredWrangler.name).toBe("authored-wrangler-name");
      await rm(join(testDir, "wrangler.jsonc"), { force: true });

      // Test CLOUDFLARE_WORKER_NAME override
      process.env.CLOUDFLARE_WORKER_NAME = "env-worker-override";
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });
      const overridden = JSON.parse(await readFile(join(outDir, "wrangler.jsonc"), "utf8"));
      expect(overridden.name).toBe("env-worker-override");
      delete process.env.CLOUDFLARE_WORKER_NAME;
    } finally {
      delete process.env.CLOUDFLARE_WORKER_NAME;
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("preserves authored configuration without overwriting it across repeated builds", async () => {
    const testDir = join(tmpdir(), `bascik-cf-authored-preserve-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-workers");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const authoredConfigContent = `// Authored config
{
  "name": "my-custom-authored-worker",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "custom_flag"],
  "vars": {
    "SECRET_API": "dummy-token",
  },
}
`;
    await writeFile(join(testDir, "wrangler.jsonc"), authoredConfigContent, "utf8");

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
      // Build once
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });

      // Confirm root wrangler.jsonc was not overwritten or touched
      const rootConfigAfterFirstBuild = await readFile(join(testDir, "wrangler.jsonc"), "utf8");
      expect(rootConfigAfterFirstBuild).toBe(authoredConfigContent);

      // Confirm generated wrangler.jsonc in outDir has derived settings
      const generated1 = JSON.parse(await readFile(join(outDir, "wrangler.jsonc"), "utf8"));
      expect(generated1.name).toBe("my-custom-authored-worker");
      expect(generated1.compatibility_flags).toContain("custom_flag");
      expect(generated1.compatibility_flags).toContain("nodejs_compat");

      // Build a second time
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });

      // Still unchanged in root
      const rootConfigAfterSecondBuild = await readFile(join(testDir, "wrangler.jsonc"), "utf8");
      expect(rootConfigAfterSecondBuild).toBe(authoredConfigContent);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("preserves and merges compatibility flags from authored wrangler.toml", async () => {
    const testDir = join(tmpdir(), `bascik-cf-authored-toml-${Date.now()}`);
    const distDir = join(testDir, "dist");
    const outDir = join(distDir, ".bascik/cloudflare-workers");
    await mkdir(distDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const authoredTomlContent = `
    name = "authored-toml-worker"
    compatibility_date = "2026-09-01"
    compatibility_flags = [
      "custom_toml_flag",
    ]

    [vars]
    KEY = "val"
    `;
    await writeFile(join(testDir, "wrangler.toml"), authoredTomlContent, "utf8");

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
      await adapter.build({
        graph,
        distDir,
        outDir,
        projectRoot: testDir,
        variant: "workers",
        log: () => {},
        runtimeEntry: "",
      });

      const rootTomlAfterBuild = await readFile(join(testDir, "wrangler.toml"), "utf8");
      expect(rootTomlAfterBuild).toBe(authoredTomlContent);

      const generated = JSON.parse(await readFile(join(outDir, "wrangler.jsonc"), "utf8"));
      expect(generated.name).toBe("authored-toml-worker");
      expect(generated.compatibility_date).toBe("2026-09-01");
      expect(generated.compatibility_flags).toContain("custom_toml_flag");
      expect(generated.compatibility_flags).toContain("nodejs_compat");
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
