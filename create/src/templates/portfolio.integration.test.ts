/**
 * portfolio.integration.test.ts
 *
 * The portfolio template through the real compiler and the generated project's own test runner.
 *
 * Boundary tested:
 * `scaffold()` on the real filesystem -> the Bascik CLI in a child process (`bascik --build`), including the
 * routes script that turns each Markdown project into a page and the build scripts that print content with
 * `html` -> the files in `dist/`. Then the generated project's Vitest suite, run in that project.
 *
 * The template-by-adapter matrix in scaffold.integration.test.ts already builds this template with every
 * adapter and runs `--check` and the audits. This file asserts what only a portfolio has: one page per project,
 * absolute SEO URLs, the sitemap, and the generated project's own unit tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scaffold } from "../scaffold.ts";
import { PORTFOLIO_TEMPLATE } from "./portfolio.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const SITE_URL = "https://example.com";

/** The fictional sample projects, read from the generated Markdown frontmatter. */
const SAMPLE_PROJECTS: { slug: string; title: string }[] =
  PORTFOLIO_TEMPLATE.files({ siteName: "x" })
    .filter(([path]) => /^content\/projects\/[^/]+\.md$/.test(path))
    .map(([, data]) => {
      const source = String(data);
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
      const fields = new Map<string, string>();
      for (const line of frontmatter.split("\n")) {
        const colon = line.indexOf(":");
        if (colon > 0)
          fields.set(
            line.slice(0, colon),
            line
              .slice(colon + 1)
              .trim()
              .replace(/^["']|["']$/g, ""),
          );
      }
      return { slug: fields.get("slug")!, title: fields.get("title")! };
    });

const tempDirs: string[] = [];

// A build that fails on the first script exits while the other pages' build scripts are still finishing, and
// those write to the project's compile cache for a moment longer: retry the removal instead of failing on it.
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
});

/**
 * A scaffolded portfolio in a temporary folder. A scaffolded project has no node_modules, so Bascik and the
 * test runner are linked from the workspace; each resolves its own dependencies from its real path.
 */
async function scaffoldPortfolio(label: string): Promise<string> {
  const parentDir = await mkdtemp(
    join(tmpdir(), `bascik-portfolio-test-${label}-`),
  );
  tempDirs.push(parentDir);
  const projectDir = join(parentDir, "studio-portfolio");
  const { notes } = await scaffold("studio-portfolio", parentDir, {
    template: PORTFOLIO_TEMPLATE,
  });
  expect(notes).toEqual([]);
  const modules = join(projectDir, "node_modules");
  await mkdir(join(modules, "@bascik"), { recursive: true });
  await symlink(
    join(REPO_ROOT, "pkg"),
    join(modules, "@bascik", "bascik"),
    "dir",
  );
  await symlink(
    join(REPO_ROOT, "node_modules", "vitest"),
    join(modules, "vitest"),
    "dir",
  );
  return projectDir;
}

interface RunResult {
  exitCode: number;
  output: string;
}

const run = (
  projectDir: string,
  args: string[],
  timeout: number,
): Promise<RunResult> =>
  execFileAsync(process.execPath, args, {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      BASCIK_SITE_URL: SITE_URL,
    },
    timeout,
  }).then(
    ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({
      exitCode: typeof err.code === "number" ? err.code : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    }),
  );

const build = (projectDir: string): Promise<RunResult> =>
  run(projectDir, [PKG_CLI, "--build"], 90_000);

const dist = (projectDir: string, path: string): Promise<string> =>
  readFile(join(projectDir, "dist", path), "utf8");

describe("creator portfolio through the compiler", () => {
  it("builds every Markdown project route and includes it in the sitemap", async () => {
    const projectDir = await scaffoldPortfolio("creator-build");
    const result = await build(projectDir);
    expect(result.exitCode, result.output).toBe(0);

    const workFiles = (await readdir(join(projectDir, "dist", "work"))).sort();
    expect(workFiles).toEqual(
      SAMPLE_PROJECTS.map((project) => `${project.slug}.html`).sort(),
    );

    const sitemap = await dist(projectDir, "sitemap.xml");
    for (const project of SAMPLE_PROJECTS) {
      expect(sitemap).toContain(`<loc>${SITE_URL}/work/${project.slug}</loc>`);
      const html = await dist(projectDir, `work/${project.slug}.html`);
      expect(html).toMatch(/<h1\b[^>]*>[^<]+<\/h1>/);
      expect(html).toContain(project.title);
      expect(html).toContain('meta property="og:type" content="article"');
    }
  });

  it("passes the generated project's own unit tests", async () => {
    const projectDir = await scaffoldPortfolio("creator-unit");
    const result = await run(
      projectDir,
      [
        join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--reporter=dot",
      ],
      90_000,
    );
    expect(result.exitCode, result.output).toBe(0);
  });
});
