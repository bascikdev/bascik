/**
 * scaffold.integration.test.ts
 *
 * Real scaffold-to-compiler integration test.
 *
 * Boundary tested:
 * Real filesystem I/O -> `scaffold(projectName, parentDir)` -> Real Bascik CLI child process compilation.
 *
 * Collaborators:
 * - Real filesystem (`mkdtemp`, `scaffold`, `readFile`, `rm`).
 * - Real Bascik compiler invoked via child process (`node <pkg>/bin/bascik.js --build`).
 * - Real asset copying, component expansion, build-script execution, and HTML publication.
 *
 * Contract asserted:
 * 1. Default scaffolded site compiles successfully with exit code 0.
 * 2. Emitted output contains all 4 pages (`index.html`, `about.html`, `contact.html`, `404.html`).
 * 3. Component expansion occurs (e.g. `<header class="header">`, `<footer class="footer">`, `<my-counter>`).
 * 4. Build scripts execute at build time (e.g. copyright year in site footer).
 * 5. Static assets and favicons are preserved and copied to dist/.
 * 6. Scaffolding copied the real agent skills (SKILL.md, references/, scripts/) into `.agents/skills/` and `.claude/skills/`.
 * 7. Negative-control sensitivity: A corrupted scaffolded page (invalid syntax / broken component) is rejected by the compiler.
 * 8. Execution mode parity: Verified across both default and worker build pipelines.
 * 9. The Cloudflare template compiles with the plain `--build` (no adapter installed) and, with the
 *    workspace adapter linked into `node_modules`, with `--build --target cloudflare`.
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR, scaffold } from "./scaffold.ts";

const execFileAsync = promisify(execFile);

// Resolve package CLI binary path and dist entry point
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const PKG_DIST_INDEX = join(REPO_ROOT, "pkg/dist/index.js");
const ADAPTER_DIR = join(REPO_ROOT, "adapters/cloudflare");
const ADAPTER_DIST_INDEX = join(ADAPTER_DIR, "dist/index.js");

/**
 * A scaffolded project has no node_modules, so point the two packages a Cloudflare
 * build resolves from the project root at their workspace directories. The adapter's
 * own dependencies (esbuild, jsonc-parser) resolve from its real path.
 */
async function linkWorkspacePackages(projectDir: string): Promise<void> {
  const scope = join(projectDir, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "dir");
  await symlink(ADAPTER_DIR, join(scope, "adapter-cloudflare"), "dir");
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bascik-scaffold-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

interface BuildResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runBascikBuild(
  projectDir: string,
  extraArgs: string[] = [],
): Promise<BuildResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [PKG_CLI, "--build", ...extraArgs],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          BASCIK_SITE_URL: "https://example.com",
        },
        timeout: 30_000,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
      exitCode: typeof execErr.code === "number" ? execErr.code : 1,
    };
  }
}

describe("scaffold-to-compiler integration", () => {
  beforeAll(() => {
    if (!existsSync(PKG_DIST_INDEX)) {
      throw new Error(
        `[scaffold.integration.test] Required artifact missing: ${PKG_DIST_INDEX}. ` +
          "Run `yarn pkg:build` before running create-bascik integration tests.",
      );
    }
  });

  it("scaffolds and compiles a new project with real compiler and full artifact verification", async () => {
    const parentDir = await createTempDir("default");
    const projectName = "test-site";
    const projectDir = join(parentDir, projectName);

    // 1. Run real scaffold
    await scaffold(projectName, parentDir);

    // Verify the agent skills were copied from real assets, with their scripts
    for (const file of [
      "bascik/SKILL.md",
      "bascik/scripts/verify.mjs",
      "bascik-components/SKILL.md",
      "bascik-config/scripts/audit-config.mjs",
    ]) {
      const agentsCopy = await readFile(
        join(projectDir, ".agents/skills", file),
        "utf8",
      );
      const claudeCopy = await readFile(
        join(projectDir, ".claude/skills", file),
        "utf8",
      );
      const bundled = await readFile(join(SKILLS_DIR, file), "utf8");
      expect(agentsCopy.length, file).toBeGreaterThan(100);
      expect(agentsCopy, file).toBe(bundled);
      expect(claudeCopy, file).toBe(bundled);
    }
    expect(existsSync(join(projectDir, ".agents/skills/README.md"))).toBe(
      false,
    );
    expect(existsSync(join(projectDir, ".github/skills"))).toBe(false);

    // 2. Compile via real Bascik CLI child process
    const buildResult = await runBascikBuild(projectDir);
    expect(
      buildResult.exitCode,
      `Build failed with stderr: ${buildResult.stderr}`,
    ).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");

    const distDir = join(projectDir, "dist");

    // 3. Verify all 4 expected pages are emitted
    const indexHtml = await readFile(join(distDir, "index.html"), "utf8");
    const aboutHtml = await readFile(join(distDir, "about.html"), "utf8");
    const contactHtml = await readFile(join(distDir, "contact.html"), "utf8");
    const notFoundHtml = await readFile(join(distDir, "404.html"), "utf8");

    expect(indexHtml).toMatch(/<!doctype html>/i);
    expect(aboutHtml).toMatch(/<!doctype html>/i);
    expect(contactHtml).toMatch(/<!doctype html>/i);
    expect(notFoundHtml).toMatch(/<!doctype html>/i);

    // 4. Verify component expansion and props
    // site-header expands to <header with brand prop or site name
    expect(indexHtml).toContain("<header");
    expect(indexHtml).toContain("test-site");
    // my-counter expanded to counter button/UI
    expect(indexHtml).toContain('data-testid="counter-inc"');
    expect(indexHtml).toContain('data-testid="counter-dec"');

    // 5. Verify build script executed in site-footer (current year)
    const currentYear = String(new Date().getFullYear());
    expect(indexHtml).toContain(`&copy; ${currentYear}`);
    expect(aboutHtml).toContain(`&copy; ${currentYear}`);
    // Confirm default export handler was scaffolded in site-footer
    const footerHtml = await readFile(
      join(projectDir, "src/components/site-footer/site-footer.html"),
      "utf8",
    );
    expect(footerHtml).toContain(
      "export default () => String(new Date().getFullYear())",
    );

    // 6. Verify representative assets copied to dist
    await expect(access(join(distDir, "favicon.ico"))).resolves.toBeUndefined();
    await expect(
      access(join(distDir, "assets/favicon.svg")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(distDir, "assets/favicon-32x32.png")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(distDir, "assets/apple-touch-icon.png")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(distDir, "css/styles.css")),
    ).resolves.toBeUndefined();
  }, 45_000);

  it("compiles scaffolded project with workers enabled in config", async () => {
    const parentDir = await createTempDir("workers");
    const projectName = "worker-site";
    const projectDir = join(parentDir, projectName);

    await scaffold(projectName, parentDir);

    // Add workers config to bascik.config.js
    await writeFile(
      join(projectDir, "bascik.config.js"),
      `export default {
  pipeline: { workers: true }
};
`,
      "utf8",
    );

    const buildResult = await runBascikBuild(projectDir);
    expect(
      buildResult.exitCode,
      `Worker build failed with stderr: ${buildResult.stderr}`,
    ).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");

    const indexHtml = await readFile(
      join(projectDir, "dist/index.html"),
      "utf8",
    );
    const currentYear = String(new Date().getFullYear());
    expect(indexHtml).toContain("<header");
    expect(indexHtml).toContain(`&copy; ${currentYear}`);
  }, 45_000);

  it("compiles the cloudflare template with the plain --build, no adapter required", async () => {
    const parentDir = await createTempDir("cloudflare-static");
    const projectName = "edge-site";
    const projectDir = join(parentDir, projectName);

    await scaffold(projectName, parentDir, { template: "cloudflare" });

    const buildResult = await runBascikBuild(projectDir);
    expect(
      buildResult.exitCode,
      `Build failed with stderr: ${buildResult.stderr}`,
    ).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");

    const distDir = join(projectDir, "dist");
    const indexHtml = await readFile(join(distDir, "index.html"), "utf8");
    const edgeHtml = await readFile(join(distDir, "edge.html"), "utf8");

    // The index links to the edge page; the edge page compiles with its server
    // script kept for request time (static output never runs it).
    expect(indexHtml).toContain('href="/edge"');
    expect(edgeHtml).toMatch(/<!doctype html>/i);
    expect(edgeHtml).toContain("<header");
    expect(edgeHtml).not.toContain("Hello, visitor");

    // The static build points out the API route it cannot serve rather than failing.
    expect(`${buildResult.stdout}\n${buildResult.stderr}`).toContain(
      "/api/hello",
    );
  }, 45_000);

  it("builds the cloudflare template into a Workers bundle with --target cloudflare", async () => {
    expect(
      existsSync(ADAPTER_DIST_INDEX),
      `Required artifact missing: ${ADAPTER_DIST_INDEX}. Run \`yarn adapter:cf:build\` first.`,
    ).toBe(true);

    const parentDir = await createTempDir("cloudflare-target");
    const projectName = "edge-site";
    const projectDir = join(parentDir, projectName);

    await scaffold(projectName, parentDir, { template: "cloudflare" });
    await linkWorkspacePackages(projectDir);

    const buildResult = await runBascikBuild(projectDir, [
      "--target",
      "cloudflare",
    ]);
    expect(
      buildResult.exitCode,
      `Cloudflare build failed with stderr: ${buildResult.stderr}`,
    ).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");
    expect(buildResult.stdout).toContain("dynamic pages: 1, API routes: 1");

    const targetDir = join(projectDir, "dist/.bascik/cloudflare");
    await expect(access(join(targetDir, "worker.js"))).resolves.toBeUndefined();
    await expect(
      access(join(targetDir, "build-info.json")),
    ).resolves.toBeUndefined();

    const wranglerConfig = await readFile(
      join(targetDir, "wrangler.jsonc"),
      "utf8",
    );
    expect(wranglerConfig).toContain('"main": "worker.js"');
    expect(wranglerConfig).toContain('"/edge"');
    expect(wranglerConfig).toContain('"/api/*"');

    // Static pages go to the CDN tree; the server-rendered page lives only in the Worker.
    const publicDir = join(targetDir, "public");
    await expect(
      access(join(publicDir, "index.html")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(publicDir, "about.html")),
    ).resolves.toBeUndefined();
    expect(existsSync(join(publicDir, "edge.html"))).toBe(false);
  }, 45_000);

  it("negative control: rejects compilation when a required page contains invalid build-script syntax", async () => {
    const parentDir = await createTempDir("negative-control");
    const projectName = "corrupt-site";
    const projectDir = join(parentDir, projectName);

    await scaffold(projectName, parentDir);

    // Inject deliberate build-script syntax error into index.html
    const corruptPage = `<!DOCTYPE html>
<html>
<head><title>Corrupt</title></head>
<body>
  <script data-bascik-build>
    // Deliberate syntax error that fails build-script execution
    const invalid = (;;
  </script>
</body>
</html>`;
    await writeFile(
      join(projectDir, "src/pages/index.html"),
      corruptPage,
      "utf8",
    );

    const buildResult = await runBascikBuild(projectDir);
    expect(buildResult.exitCode).not.toBe(0);
    // Verifier rejected the corrupted page
    const combinedOutput = `${buildResult.stdout}\n${buildResult.stderr}`;
    expect(combinedOutput.toLowerCase()).toMatch(/error|failed|syntaxerror/);
  }, 45_000);

  it("negative control: rejects compilation when a build script relies on legacy stdout console.log", async () => {
    const parentDir = await createTempDir("stdout-control");
    const projectName = "legacy-stdout-site";
    const projectDir = join(parentDir, projectName);

    await scaffold(projectName, parentDir);

    const legacyStdoutPage = `<!DOCTYPE html>
<html>
<head><title>Legacy Stdout</title></head>
<body>
  <script data-bascik-build>
    console.log("<p>legacy</p>");
  </script>
</body>
</html>`;
    await writeFile(
      join(projectDir, "src/pages/index.html"),
      legacyStdoutPage,
      "utf8",
    );

    const buildResult = await runBascikBuild(projectDir);
    expect(buildResult.exitCode).not.toBe(0);
    const combinedOutput = `${buildResult.stdout}\n${buildResult.stderr}`;
    expect(combinedOutput).toContain("missing default export");
  }, 45_000);
});
