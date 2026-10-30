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
 * 6. Scaffolding wrote AGENTS.md and a CLAUDE.md that imports it, and left the agent skills to the skills CLI
 *    (create-cli.integration.test.ts runs that install).
 * 7. Negative-control sensitivity: A corrupted scaffolded page (invalid syntax / broken component) is rejected by the compiler.
 * 8. Execution mode parity: Verified across both default and worker build pipelines.
 * 9. The Cloudflare template compiles with the plain `--build` (no adapter installed) and, with the
 *    workspace adapter linked into `node_modules`, with `--build --target cloudflare`; the emitted
 *    Worker, run in Miniflare, renders the `<feat-card>` the edge page's server script returns.
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
  realpath,
  symlink,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CLAUDE_MD, agentsMd } from "./agent-setup.ts";
import { scaffold } from "./scaffold.ts";

const execFileAsync = promisify(execFile);

// Resolve package CLI binary path and dist entry point
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const PKG_DIST_INDEX = join(REPO_ROOT, "pkg/dist/index.js");
const ADAPTER_DIR = join(REPO_ROOT, "adapters/cloudflare");
const ADAPTER_DIST_INDEX = join(ADAPTER_DIR, "dist/index.js");

/**
 * Built artifacts this file runs, and the root script that builds each. The
 * suite's beforeAll fails up front naming every missing one, and the CI check
 * at the end of this file requires every job that runs the suite to build
 * them first, so CI and a local `yarn create:unit` share one explicit list.
 */
const PREREQUISITES = [
  { artifact: PKG_DIST_INDEX, script: "pkg:build" },
  { artifact: ADAPTER_DIST_INDEX, script: "adapter:cf:build" },
] as const;

/** The message for missing prerequisites, or undefined when all are built. */
function missingPrerequisites(
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const missing = PREREQUISITES.filter(({ artifact }) => !exists(artifact));
  if (missing.length === 0) return undefined;
  return (
    `[scaffold.integration.test] Required artifact missing: ${missing
      .map(({ artifact }) => artifact)
      .join(", ")}. Run \`${missing
      .map(({ script }) => `yarn ${script}`)
      .join(" && ")}\` from the repository root before running ` +
    "create-bascik tests (CI builds the same artifacts first)."
  );
}

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

/**
 * Request `path` from the emitted Worker in Miniflare (the workerd binary
 * Wrangler uses), configured from the emitted wrangler.jsonc, and return the
 * body. Miniflare is the Cloudflare adapter's test dependency, resolved from
 * the workspace root.
 */
async function fetchFromWorker(
  targetDir: string,
  path: string,
): Promise<string> {
  const { Miniflare } = await import("miniflare");
  // workerd rejects a symlinked prefix such as macOS /var/folders.
  const dir = await realpath(targetDir);
  const wrangler = JSON.parse(
    await readFile(join(dir, "wrangler.jsonc"), "utf8"),
  ) as {
    compatibility_date: string;
    compatibility_flags: string[];
    assets: { run_worker_first: string[] };
  };
  const mf = new Miniflare({
    modules: true,
    modulesRoot: dir,
    scriptPath: join(dir, "worker.js"),
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    // The asset layer answers first, and the Worker runs for the routes the
    // generated config lists, as on Cloudflare.
    assets: {
      directory: join(dir, "public"),
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        static_routing: { user_worker: wrangler.assets.run_worker_first },
      },
    },
  });
  try {
    const response = await mf.dispatchFetch(`http://localhost${path}`);
    expect(response.status).toBe(200);
    return await response.text();
  } finally {
    await mf.dispose();
  }
}

/**
 * The scoped class names of <feat-card>'s header and footer wrappers, read
 * from the stylesheet the page carries (the build hashes them under
 * minify.identifiers), and whether `slotText` sits directly inside an element
 * that carries each one. The template's wrappers are the elements its CSS
 * styles (.fcard-header: uppercase accent label; .fcard-footer: a top
 * border), so a card whose slot content lost them is unstyled.
 */
function featCardWrappers(html: string): { header: string; footer: string } {
  const header =
    /\.([\w-]+)\{[^}]*text-transform:uppercase;letter-spacing:\.1em;color:var\(--accent\)/.exec(
      html,
    )?.[1];
  const footer =
    /\.([\w-]+)\{padding-top:12px;border-top:1px solid var\(--border\)/.exec(
      html,
    )?.[1];
  expect(
    header,
    "the .fcard-header rule in the page's stylesheet",
  ).toBeDefined();
  expect(
    footer,
    "the .fcard-footer rule in the page's stylesheet",
  ).toBeDefined();
  return { header: header!, footer: footer! };
}

/** `html` has an element with class `className` whose content starts with `content`. */
function wrapsContent(
  html: string,
  className: string,
  content: string,
): boolean {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<[a-z][\\w-]*[^>]*\\sclass="(?:[^"]*\\s)?${escape(className)}(?:\\s[^"]*)?"[^>]*>\\s*${escape(content)}`,
  ).test(html);
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
    const missing = missingPrerequisites();
    if (missing) throw new Error(missing);
  });

  it("scaffolds and compiles a new project with real compiler and full artifact verification", async () => {
    const parentDir = await createTempDir("default");
    const projectName = "test-site";
    const projectDir = join(parentDir, projectName);

    // 1. Run real scaffold
    await scaffold(projectName, parentDir);

    // The coding-assistant files are written; the skills are the skills CLI's job
    expect(await readFile(join(projectDir, "AGENTS.md"), "utf8")).toBe(
      agentsMd(),
    );
    expect(await readFile(join(projectDir, "CLAUDE.md"), "utf8")).toBe(
      CLAUDE_MD,
    );
    expect(existsSync(join(projectDir, ".agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
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

    // `name` ships as written: the contact form posts the keys it names.
    for (const key of ["name", "email", "message"])
      expect(contactHtml).toContain(`name="${key}"`);
    expect(contactHtml).not.toMatch(/name="bascik__/);

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
      "export default (): string => String(new Date().getFullYear())",
    );
    // The starter's browser scripts are TypeScript; the browser gets JavaScript.
    expect(indexHtml).not.toMatch(
      /: number|as HTMLSpanElement|text\/typescript/,
    );
    expect(contactHtml).toContain('data-testid="contact-form"');
    expect(contactHtml).not.toMatch(/: SubmitEvent|text\/typescript/);

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

  it.each(["default", "cloudflare"] as const)(
    "misuse: the %s template's <feat-card> header and footer slot content is wrapped in the styled .fcard-header and .fcard-footer elements after --build",
    async (template) => {
      const parentDir = await createTempDir(`feat-card-${template}`);
      const projectName = "slot-site";
      const projectDir = join(parentDir, projectName);
      await scaffold(projectName, parentDir, { template });

      const buildResult = await runBascikBuild(projectDir);
      expect(
        buildResult.exitCode,
        `Build failed with stderr: ${buildResult.stderr}`,
      ).toBe(0);
      const html = await readFile(join(projectDir, "dist/index.html"), "utf8");
      const { header, footer } = featCardWrappers(html);
      // A named slot's content replaces its marker element, so a class on
      // the marker never reaches the page; the styled wrapper must survive.
      expect(
        wrapsContent(html, header, "Zero runtime"),
        `"Zero runtime" inside an element with the header class ${header}`,
      ).toBe(true);
      expect(
        wrapsContent(
          html,
          footer,
          '<a href="/about" class="btn btn-ghost">Learn more',
        ),
        `the footer link inside an element with the footer class ${footer}`,
      ).toBe(true);
      // The body's title and text rules match the slot content: the h2 or h3 and
      // p arrive as plain tags inside the body wrapper, so each rule is the
      // wrapper class followed by an element name the build left as written.
      const body =
        /\.([\w-]+) :is\(h2, ?h3\)\{margin:0 0 6px;font-size:1rem;color:var\(--text\)/.exec(
          html,
        )?.[1];
      expect(
        body,
        "the .fcard-body :is(h2, h3) rule in the page's stylesheet",
      ).toBeDefined();
      expect(html).toMatch(
        new RegExp(`\\.${body} :is\\(p\\)\\{margin:0;font-size:0\\.88rem`),
      );
      expect(
        wrapsContent(html, body!, "<h3>No framework overhead</h3>"),
        `the slot's <h3>, without a class, inside the body class ${body}`,
      ).toBe(true);
      expect(html).toContain(
        "<p>Components compile at build time. Nothing extra ships to the browser.</p>",
      );
    },
    45_000,
  );

  it("builds the cloudflare template into a Workers bundle with --target cloudflare", async () => {
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

    // The edge page's server script returns a <feat-card>, so the build
    // records the starter's components for request-time rendering and the
    // adapter bundles them: no "not rendered on this host" warning.
    const output = `${buildResult.stdout}\n${buildResult.stderr}`;
    expect(output).not.toContain("does not declare components: true");
    expect(output).toMatch(/component manifest: \d+ bytes \(\d+ components\)/);
    const manifest = JSON.parse(
      await readFile(join(projectDir, ".bascik/dist/components.json"), "utf8"),
    ) as {
      components: Record<string, { template: unknown; unsupported?: unknown }>;
    };
    expect(manifest.components["feat-card"]).toBeDefined();
    expect(manifest.components["feat-card"].unsupported).toBeUndefined();

    // Run the emitted Worker in workerd and request the edge page: the card
    // arrives rendered, with its scoped stylesheet, around the greeting.
    const html = await fetchFromWorker(targetDir, "/edge?name=Ada");
    expect(html).toContain("Hello, Ada");
    expect(html).not.toContain("<feat-card");
    expect(html).not.toContain("data-bascik-slot");
    // The component's stylesheet is emitted once, in the body, right before
    // the card; the card's root carries the scoped class and the usage's
    // data-testid, with the greeting in its default slot.
    const card =
      /<style>([^<]*flex-direction:column[^<]*)<\/style><article class="([^"]+)" data-testid="edge-card">[^]*?Hello, Ada[^]*?<\/article>/.exec(
        html,
      );
    expect(card, "the rendered card and its stylesheet").not.toBeNull();
    expect(card![1]).toContain(`.${card![2]}{`);
    expect(html.split(card![1]).length - 1).toBe(1);
    // The slot wrappers are styled at request time exactly as at build time.
    const { header, footer } = featCardWrappers(html);
    expect(
      wrapsContent(html, header, "Server script"),
      `"Server script" inside an element with the header class ${header}`,
    ).toBe(true);
    expect(
      wrapsContent(
        html,
        footer,
        '<a href="/edge" class="btn btn-ghost">Reload',
      ),
      `the reload link inside an element with the footer class ${footer}`,
    ).toBe(true);
  }, 60_000);

  it.each(["default", "cloudflare"] as const)(
    "a fresh %s scaffold passes bascik --check with no site URL set, which warns and names the fix, while --build still fails",
    async (template) => {
      const parentDir = await createTempDir(`check-${template}`);
      const projectDir = join(parentDir, "check-site");
      await scaffold("check-site", parentDir, { template });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      };
      delete env.BASCIK_SITE_URL;

      const check = await execFileAsync(
        process.execPath,
        [PKG_CLI, "--check"],
        {
          cwd: projectDir,
          encoding: "utf8",
          env,
          timeout: 60_000,
        },
      );
      expect(check.stdout).toContain("0 errors");
      expect(check.stdout).toContain("BASCIK_SITE_URL is not set");
      expect(check.stdout).toContain("--site-url");
      // No production URL is invented for the project.
      expect(existsSync(join(projectDir, ".env"))).toBe(false);

      const build = await execFileAsync(
        process.execPath,
        [PKG_CLI, "--build"],
        {
          cwd: projectDir,
          encoding: "utf8",
          env,
          timeout: 60_000,
        },
      ).then(
        () => ({ code: 0, output: "" }),
        (err: { code?: number; stdout?: string; stderr?: string }) => ({
          code: err.code ?? 1,
          output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
        }),
      );
      expect(build.code).not.toBe(0);
      expect(build.output).toContain("BASCIK_SITE_URL is not set");
    },
    90_000,
  );

  it("the scaffolded default and cloudflare starters pass the bascik skill's semantic HTML audit", async () => {
    const audit = join(REPO_ROOT, "skills/bascik/scripts/audit-components.mjs");
    const semantic = new Set([
      "clickable-element",
      "generic-root",
      "skipped-heading",
      "missing-alt",
      "unlabeled-control",
      "missing-main",
    ]);
    for (const template of ["default", "cloudflare"] as const) {
      const parentDir = await createTempDir(`audit-${template}`);
      await scaffold("audit-site", parentDir, { template });
      const run = await execFileAsync(
        process.execPath,
        [audit, "--json", "--root", join(parentDir, "audit-site")],
        { encoding: "utf8" },
      ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
      const { findings } = JSON.parse(run.stdout) as {
        findings: { rule: string; file: string; line: number }[];
      };
      expect(
        findings
          .filter((f) => semantic.has(f.rule))
          .map((f) => `${f.rule} ${f.file}:${f.line}`),
        template,
      ).toEqual([]);
    }
  });

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

/** The `run:` commands of each job in a workflow, in step order. */
function jobRunCommands(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let current: string[] | undefined;
  let blockIndent: number | undefined;
  for (const line of workflow.replace(/\r\n/g, "\n").split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      current = undefined;
      continue;
    }
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      current = [];
      jobs.set(job[1], current);
      blockIndent = undefined;
      continue;
    }
    if (!current) continue;
    // A `run: |` block: its lines are commands until the indent drops back.
    if (blockIndent !== undefined) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > blockIndent) {
        if (line.trim()) current.push(line.trim());
        continue;
      }
      blockIndent = undefined;
    }
    const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!run) continue;
    if (run[2] === "|" || run[2] === ">") blockIndent = run[1].length;
    else current.push(run[2].trim());
  }
  return jobs;
}

/** Whether a command runs the named root script (`yarn <script>`, not a longer name). */
const runsScript = (command: string, script: string): boolean =>
  new RegExp(`(?:^|[;&|]\\s*)yarn ${script}(?=$|[\\s;&|])`).test(command);

describe("create-bascik test prerequisites", () => {
  const SUITE_SCRIPTS = ["create:unit", "create:test:ci", "create:coverage"];

  it("misuse: a run missing any built artifact fails up front, naming each one and the command that builds it", () => {
    expect(missingPrerequisites(() => true)).toBeUndefined();
    const onlyPkg = missingPrerequisites((path) => path === PKG_DIST_INDEX);
    expect(onlyPkg).toContain(ADAPTER_DIST_INDEX);
    expect(onlyPkg).not.toContain(PKG_DIST_INDEX);
    expect(onlyPkg).toContain("`yarn adapter:cf:build`");
    const neither = missingPrerequisites(() => false);
    expect(neither).toContain(PKG_DIST_INDEX);
    expect(neither).toContain(ADAPTER_DIST_INDEX);
    expect(neither).toContain("`yarn pkg:build && yarn adapter:cf:build`");
  });

  it("reads each job's run commands, including run blocks and chained commands", () => {
    const jobs = jobRunCommands(
      [
        "name: CI",
        "jobs:",
        "  a:",
        "    steps:",
        "      - run: yarn pkg:build && yarn adapter:cf:build",
        "      - name: block",
        "        run: |",
        "          corepack enable",
        "          yarn create:unit",
        "      - run: yarn create:test:ci",
        "  b:",
        "    steps:",
        "      - run: yarn create:unit",
        "other: x",
        "  c:",
      ].join("\r\n"),
    );
    expect([...jobs.keys()]).toEqual(["a", "b"]);
    expect(jobs.get("a")).toEqual([
      "yarn pkg:build && yarn adapter:cf:build",
      "corepack enable",
      "yarn create:unit",
      "yarn create:test:ci",
    ]);
    expect(
      runsScript("yarn pkg:build && yarn adapter:cf:build", "adapter:cf:build"),
    ).toBe(true);
    // A longer script that starts with the same name is a different script.
    expect(runsScript("yarn adapter:cf:build:x", "adapter:cf:build")).toBe(
      false,
    );
    expect(runsScript("yarn create:unit:watch", "create:unit")).toBe(false);
  });

  it("every CI job that runs the suite builds each prerequisite in an earlier step", () => {
    // The Create-Bascik and Windows jobs once built only the package, so the
    // Cloudflare test failed there while the Node 22.22 floor job, which
    // builds the adapter for its own tests, passed.
    const jobs = jobRunCommands(
      readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
    );
    const missing: string[] = [];
    const suiteJobs: string[] = [];
    for (const [job, commands] of jobs) {
      const suiteAt = commands.findIndex((command) =>
        SUITE_SCRIPTS.some((script) => runsScript(command, script)),
      );
      if (suiteAt < 0) continue;
      suiteJobs.push(job);
      for (const { script } of PREREQUISITES) {
        const builtAt = commands.findIndex((command) =>
          runsScript(command, script),
        );
        if (builtAt < 0 || builtAt > suiteAt)
          missing.push(`${job}: yarn ${script}`);
      }
    }
    // If this drops, the parser stopped seeing the jobs and the check above
    // proves nothing.
    expect(suiteJobs.length, suiteJobs.join(", ")).toBeGreaterThanOrEqual(3);
    expect(missing).toEqual([]);
  });
});
