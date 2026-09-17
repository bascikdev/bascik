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
 * 6. Scaffolding copied the real SKILL.md asset into `.github/skills/bascik/SKILL.md` and `.claude/skills/bascik/SKILL.md`.
 * 7. Negative-control sensitivity: A corrupted scaffolded page (invalid syntax / broken component) is rejected by the compiler.
 * 8. Execution mode parity: Verified across both default and worker build pipelines.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scaffold } from "./scaffold.ts";

const execFileAsync = promisify(execFile);

// Resolve package CLI binary path
const PKG_CLI = resolve(
  fileURLToPath(import.meta.url),
  "../../../pkg/bin/bascik.js",
);

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

async function runBascikBuild(projectDir: string, extraArgs: string[] = []): Promise<BuildResult> {
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
  it("scaffolds and compiles a new project with real compiler and full artifact verification", async () => {
    const parentDir = await createTempDir("default");
    const projectName = "test-site";
    const projectDir = join(parentDir, projectName);

    // 1. Run real scaffold
    await scaffold(projectName, parentDir);

    // Verify SKILL.md was copied from real assets
    const githubSkill = await readFile(join(projectDir, ".github/skills/bascik/SKILL.md"), "utf8");
    const claudeSkill = await readFile(join(projectDir, ".claude/skills/bascik/SKILL.md"), "utf8");
    expect(githubSkill.length).toBeGreaterThan(100);
    expect(claudeSkill).toBe(githubSkill);

    // 2. Compile via real Bascik CLI child process
    const buildResult = await runBascikBuild(projectDir);
    expect(buildResult.exitCode, `Build failed with stderr: ${buildResult.stderr}`).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");

    const distDir = join(projectDir, "dist");

    // 3. Verify all 4 expected pages are emitted
    const indexHtml = await readFile(join(distDir, "index.html"), "utf8");
    const aboutHtml = await readFile(join(distDir, "about.html"), "utf8");
    const contactHtml = await readFile(join(distDir, "contact.html"), "utf8");
    const notFoundHtml = await readFile(join(distDir, "404.html"), "utf8");

    expect(indexHtml).toContain("<!DOCTYPE html>");
    expect(aboutHtml).toContain("<!DOCTYPE html>");
    expect(contactHtml).toContain("<!DOCTYPE html>");
    expect(notFoundHtml).toContain("<!DOCTYPE html>");

    // 4. Verify component expansion and props
    // site-header expands to <header with brand prop or site name
    expect(indexHtml).toContain("<header");
    expect(indexHtml).toContain("test-site");
    // my-counter expanded to counter button/UI
    expect(indexHtml).toContain("data-testid=\"counter-inc\"");
    expect(indexHtml).toContain("data-testid=\"counter-dec\"");

    // 5. Verify build script executed in site-footer (current year)
    const currentYear = String(new Date().getFullYear());
    expect(indexHtml).toContain(`&copy; ${currentYear}`);
    expect(aboutHtml).toContain(`&copy; ${currentYear}`);

    // 6. Verify representative assets copied to dist
    await expect(access(join(distDir, "favicon.ico"))).resolves.toBeUndefined();
    await expect(access(join(distDir, "assets/favicon.svg"))).resolves.toBeUndefined();
    await expect(access(join(distDir, "assets/favicon-32x32.png"))).resolves.toBeUndefined();
    await expect(access(join(distDir, "assets/apple-touch-icon.png"))).resolves.toBeUndefined();
    await expect(access(join(distDir, "css/styles.css"))).resolves.toBeUndefined();
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
    expect(buildResult.exitCode, `Worker build failed with stderr: ${buildResult.stderr}`).toBe(0);
    expect(buildResult.stdout).toContain("Build complete");

    const indexHtml = await readFile(join(projectDir, "dist/index.html"), "utf8");
    const currentYear = String(new Date().getFullYear());
    expect(indexHtml).toContain("<header");
    expect(indexHtml).toContain(`&copy; ${currentYear}`);
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
    await writeFile(join(projectDir, "src/pages/index.html"), corruptPage, "utf8");

    const buildResult = await runBascikBuild(projectDir);
    expect(buildResult.exitCode).not.toBe(0);
    // Verifier rejected the corrupted page
    const combinedOutput = `${buildResult.stdout}\n${buildResult.stderr}`;
    expect(combinedOutput.toLowerCase()).toMatch(/error|failed|syntaxerror/);
  }, 45_000);
});
