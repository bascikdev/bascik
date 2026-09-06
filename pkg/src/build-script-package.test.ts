import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cleanupFixture,
  createPackageFixtureDirs,
  packageFixtureRoot,
  readDistHtml,
  runRealPackageBuild,
  writeFixtureFile,
  writeInstalledPackage,
  writePackageBuildConfig,
} from "./lib/build-script-package.fixtures.ts";

const execFileAsync = promisify(execFile);

/** Run a shell command inside the fixture root (creates directory symlinks). */
async function runInFixtureShell(root: string, command: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
    cwd: root,
    encoding: "utf8",
  });
  if (stderr) throw new Error(stderr);
  void stdout;
}

/**
 * Prompt 104 P1 regression anchor. A build script imports an installed package.
 * Upgrade the package (preserving script text + disk cache), and a FRESH CLI
 * build must invalidate the output cache and emit the new package's generated
 * content. Pre-fix, `computeScriptCacheKey` included the script text and local
 * file deps but never the resolved package graph, so the old output was replayed.
 *
 * Every test here is a REAL fresh-process `bascik --build` against an isolated
 * fixture with a real `node_modules` + real on-disk script cache. An in-memory
 * mock of a changing cache key cannot prove package resolution parity.
 */
describe("build-script package dependency identity (real fresh-process CLI builds)", () => {
  for (const workers of [false, true]) {
    it(`invalidates the output when a bare installed package is upgraded (workers=${workers})`, async () => {
      const root = packageFixtureRoot(`upgrade-${workers}`);
      try {
        await createPackageFixtureDirs(root);
        await writePackageBuildConfig(root, workers);
        await writeInstalledPackage(root, "audit-dependency", "audit-dependency", "1.0.0", "dependency-version-one");
        await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
<script data-bascik-build>
import { value } from 'audit-dependency';
console.log('<span data-testid="pkg">' + value + '</span>');
</script>
</body></html>`);

        // COLD, actual source CLI full build emits value one.
        await runRealPackageBuild(root);
        expect(await readDistHtml(root, "index.html")).toContain('data-testid="pkg">dependency-version-one</span>');

        // Upgrade the package in place; script text and cache are preserved.
        await writeInstalledPackage(root, "audit-dependency", "audit-dependency", "2.0.0", "dependency-version-two");

        // Fresh --build --only must NOT replay the cached value one.
        await runRealPackageBuild(root, ["--only", "index.html"]);
        const html = await readDistHtml(root, "index.html");
        expect(html).toContain('data-testid="pkg">dependency-version-two</span>');
        expect(html).not.toContain("dependency-version-one");
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  }

  for (const workers of [false, true]) {
    it(`invalidates when a same-version user-linked package content changes (workers=${workers})`, async () => {
      const root = packageFixtureRoot(`linked-${workers}`);
      try {
        await createPackageFixtureDirs(root);
        await writePackageBuildConfig(root, workers);

        // The "package" lives OUTSIDE node_modules (like a workspace / file: dep)
        // and is user-linked into node_modules via a directory symlink.
        await writeFixtureFile(root, "vendor/renderer/package.json",
          JSON.stringify({ name: "renderer", version: "1.0.0", type: "module", main: "index.mjs" }, null, 2));
        await writeFixtureFile(root, "vendor/renderer/index.mjs",
          `export const value = "linked-version-one";`);
        await writeFixtureFile(root, "vendor/renderer/another.mjs",
          `export const other = "renderer::linked-version-one";`);
        // Directory symlink node_modules/renderer -> ../vendor/renderer
        await runInFixtureShell(root, "ln -s ../vendor/renderer node_modules/renderer");

        await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html lang="en"><head><title>l</title></head><body>
<script data-bascik-build>
import { value } from 'renderer';
console.log('<span data-testid="pkg">' + value + '</span>');
</script>
</body></html>`);

        await runRealPackageBuild(root);
        expect(await readDistHtml(root, "index.html")).toContain('data-testid="pkg">linked-version-one</span>');

        // Same version, content change only (in-place linked workspace edit).
        await writeFixtureFile(root, "vendor/renderer/index.mjs",
          `export const value = "linked-version-two";`);

        await runRealPackageBuild(root, ["--only", "index.html"]);
        const html = await readDistHtml(root, "index.html");
        expect(html).toContain('data-testid="pkg">linked-version-two</span>');
        expect(html).not.toContain("linked-version-one");
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  }

  for (const workers of [false, true]) {
    it(`tracks subpath exports and a package that imports another package (workers=${workers})`, async () => {
      const root = packageFixtureRoot(`subgraph-${workers}`);
      try {
        await createPackageFixtureDirs(root);
        await writePackageBuildConfig(root, workers);

        // Base dependency (imported by the middle package's own subpath file).
        await writeFixtureFile(root, "node_modules/dep-base/package.json",
          JSON.stringify({ name: "dep-base", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }, null, 2));
        await writeFixtureFile(root, "node_modules/dep-base/index.mjs", `export const value = "base-A";`);

        // Middle package: top-level + ./sub subpath, and its subpath file imports dep-base.
        await writeFixtureFile(root, "node_modules/audit-lib/package.json",
          JSON.stringify({ name: "audit-lib", version: "1.0.0", type: "module",
            exports: { ".": "./index.mjs", "./sub": "./sub.mjs" } }, null, 2));
        await writeFixtureFile(root, "node_modules/audit-lib/index.mjs", `export const top = "lib-top-A";`);
        await writeFixtureFile(root, "node_modules/audit-lib/sub.mjs",
          `import { value } from 'dep-base';\nexport const sub = "lib-sub:" + value;`);

        await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html lang="en"><head><title>s</title></head><body>
<script data-bascik-build>
import { top } from 'audit-lib';
import { sub } from 'audit-lib/sub';
console.log('<span data-testid="pkg">' + top + '|' + sub + '</span>');
</script>
</body></html>`);

        await runRealPackageBuild(root);
        expect(await readDistHtml(root, "index.html")).toContain('data-testid="pkg">lib-top-A|lib-sub:base-A</span>');

        // Change dep-base (a transitive package input) in place.
        await writeFixtureFile(root, "node_modules/dep-base/index.mjs", `export const value = "base-B";`);

        await runRealPackageBuild(root, ["--only", "index.html"]);
        const html = await readDistHtml(root, "index.html");
        expect(html).toContain('data-testid="pkg">lib-top-A|lib-sub:base-B</span>');
        expect(html).not.toContain("base-A");
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  }

  describe("cache-hit guarantees", () => {
    it("keeps emitting identical output for an unchanged package (worker and serial)", async () => {
      // Run the same fixture twice per mode without touching the package.
      for (const workers of [false, true]) {
        const root = packageFixtureRoot(`unchanged-${workers}`);
        try {
          await createPackageFixtureDirs(root);
          await writePackageBuildConfig(root, workers);
          await writeInstalledPackage(root, "stable-pkg", "stable-pkg", "1.0.0", "stable-value");
          await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html lang="en"><head><title>u</title></head><body>
<script data-bascik-build>
import { value } from 'stable-pkg';
console.log('<span data-testid="pkg">' + value + '</span>');
</script>
</body></html>`);

          await runRealPackageBuild(root);
          const first = await readDistHtml(root, "index.html");
          expect(first).toContain("stable-value");

          // Unchanged inputs: identical artifact bytes across a fresh process.
          await runRealPackageBuild(root);
          const second = await readDistHtml(root, "index.html");
          expect(second).toEqual(first);
          expect(second).toContain("stable-value");
        } finally {
          await cleanupFixture(root);
        }
      }
    }, 120000);

    it("preserves a missing-package marker so resolution failure stays a cache miss, not a stale replay", async () => {
      const root = packageFixtureRoot("missing");
      try {
        await createPackageFixtureDirs(root);
        await writePackageBuildConfig(root, false);
        await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html lang="en"><head><title>m</title></head><body>
<script data-bascik-build>
import { value } from 'not-installed-pkg';
console.log('<span data-testid="pkg">' + value + '</span>');
</script>
</body></html>`);

        // Fresh process: resolution fails at execute time; build error surfaced
        // and the CLI exits non-zero. Capture stderr rather than letting the
        // helper throw.
        let failureStderr = "";
        try {
          await runRealPackageBuild(root);
        } catch (err) {
          failureStderr = String((err as { stderr?: string })?.stderr ?? err);
        }
        expect(failureStderr).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find|not-installed-pkg/);

        // Install it, then a fresh build resolves and emits content (no stale replay).
        await writeInstalledPackage(root, "not-installed-pkg", "not-installed-pkg", "1.0.0", "now-installed");
        await runRealPackageBuild(root);
        const html = await readDistHtml(root, "index.html");
        expect(html).toContain('data-testid="pkg">now-installed</span>');
      } finally {
        await cleanupFixture(root);
      }
    }, 90000);
  });
});