import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { emitServerlessArtifacts } from "./serverless-artifacts.ts";
import { resolveAdapterTarget } from "./adapter-resolution.ts";

describe("adapter review regressions", () => {
  it.each(["toString", "__proto__", "constructor"])("treats %s as a package", async (target) => {
    expect(await resolveAdapterTarget(target, process.cwd(), { load: false })).toEqual({ package: target });
  });

  it("CI dependencies refer to existing jobs", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");
    const jobs = new Set([...workflow.matchAll(/^  ([\w-]+):$/gm)].map((match) => match[1]));
    for (const match of workflow.matchAll(/^    needs: \[([^\]]+)\]/gm)) {
      for (const dependency of match[1].split(",").map((name) => name.trim())) expect(jobs.has(dependency), dependency).toBe(true);
    }
  });

  it("core E2E scripts no longer refer to the moved Cloudflare lane", async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"));
    expect(manifest.scripts).not.toHaveProperty("e2e:cloudflare");
    expect(manifest.scripts["e2e:all"]).not.toContain("e2e:cloudflare");
  });

  it.each([
    ["new dist file", 'await writeFile(join(context.distDir, "unexpected.html"), "unexpected"); return { publicDir: context.outDir };', /Adapter modified dist/],
    ["missing publicDir", "return {};", /contract violation/i],
    ["empty publicDir", 'return { publicDir: "" };', /contract violation/i],
    ["null result", "return null;", /contract violation/i],
    ["invalid notes", 'return { publicDir: context.outDir, notes: [42] };', /contract violation/i],
    ["missing public directory", 'return { publicDir: join(context.outDir, "missing") };', /contract violation/i],
  ])("rejects %s", async (_name, body, message) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-adapter-review-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(distDir);
      await writeFile(join(distDir, "index.html"), "home");
      await writeFile(join(root, "adapter.mjs"), `import { writeFile } from "node:fs/promises"; import { join } from "node:path"; export default { name: "probe", async build(context) { ${body} } };`);
      await expect(emitServerlessArtifacts("./adapter.mjs", { version: "1.0.0", projectRoot: root, distDir })).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not skip snapshotting dist directories whose names share a prefix with outDir (sibling prefix)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-sibling-prefix-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(distDir);
      await writeFile(join(distDir, "index.html"), "home");

      // Create a sibling directory in dist/.bascik that shares a prefix with outDir
      // If target is "./adapter.mjs", outDir is dist/.bascik/__adapter_mjs_...
      // Sibling is dist/.bascik/__adapter_mjs_sibling
      const siblingDir = join(distDir, ".bascik", "__adapter_mjs_sibling");
      await mkdir(siblingDir, { recursive: true });
      await writeFile(join(siblingDir, "sibling.txt"), "original");

      // Adapter mutates sibling.txt outside its outDir
      await writeFile(
        join(root, "adapter.mjs"),
        `import { writeFile } from "node:fs/promises"; import { join } from "node:path"; export default { name: "sibling-mutator", async build(context) {
          await writeFile(join(context.distDir, ".bascik", "__adapter_mjs_sibling", "sibling.txt"), "mutated");
          return { publicDir: context.outDir };
        } };`,
      );

      await expect(
        emitServerlessArtifacts("./adapter.mjs", { version: "1.0.0", projectRoot: root, distDir }),
      ).rejects.toThrow(/Adapter modified dist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes custom target names uniquely to avoid collisions between distinct targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-target-collision-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(distDir);
      await writeFile(join(distDir, "index.html"), "home");

      // Two distinct targets that would collide under naive regex replacement
      // e.g. "./custom.adapter.js" vs "./custom/adapter/js" or "./adapter.mjs" vs "./adapter-mjs"
      await mkdir(join(root, "custom"), { recursive: true });
      await writeFile(
        join(root, "custom-adapter.mjs"),
        `export default { name: "t1", async build(context) { return { publicDir: context.outDir, notes: [context.outDir] }; } };`,
      );
      await writeFile(
        join(root, "custom/adapter.mjs"),
        `export default { name: "t2", async build(context) { return { publicDir: context.outDir, notes: [context.outDir] }; } };`,
      );

      const r1 = await emitServerlessArtifacts("./custom-adapter.mjs", { version: "1.0.0", projectRoot: root, distDir });
      const r2 = await emitServerlessArtifacts("./custom/adapter.mjs", { version: "1.0.0", projectRoot: root, distDir });

      expect(r1.outDir).not.toBe(r2.outDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adapter resolution failure does not delete or alter existing target output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-res-failure-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(distDir);
      await writeFile(join(distDir, "index.html"), "home");

      // Create an existing artifact in target's outDir
      const target = "cloudflare-pages";
      const outDir = join(distDir, ".bascik", target);
      await mkdir(outDir, { recursive: true });
      const sentinel = join(outDir, "sentinel.txt");
      await writeFile(sentinel, "preserve-me");

      // Attempt to emit for nonexistent/uninstalled adapter in empty project
      await expect(
        emitServerlessArtifacts(target, { version: "1.0.0", projectRoot: root, distDir }),
      ).rejects.toThrow(/required package "@bascik\/adapter-cloudflare" is not installed/);

      // Sentinel must still exist untouched
      expect(await readFile(sentinel, "utf8")).toBe("preserve-me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles directory symlink cycles within outDir safely during path containment verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-symlink-cycle-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(distDir);
      await writeFile(join(distDir, "index.html"), "home");

      // Adapter creates a directory with a cyclic symlink pointing to parent/self inside outDir
      await writeFile(
        join(root, "adapter.mjs"),
        `import { mkdir, symlink } from "node:fs/promises"; import { join } from "node:path"; export default { name: "cycle", async build(context) {
          const sub = join(context.outDir, "subdir");
          await mkdir(sub, { recursive: true });
          await symlink(context.outDir, join(sub, "parent-link"));
          return { publicDir: context.outDir };
        } };`,
      );

      // Should complete without hanging in infinite recursion
      const res = await emitServerlessArtifacts("./adapter.mjs", { version: "1.0.0", projectRoot: root, distDir });
      expect(res.outDir).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});