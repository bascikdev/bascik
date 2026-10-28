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
      // The body's title and text rules match the slot content: the h3 and
      // p arrive as plain tags inside the body wrapper, so each rule is the
      // wrapper class followed by an element name the build left as written.
      const body =
        /\.([\w-]+) :is\(h3\)\{margin:0 0 6px;font-size:1rem;color:var\(--text\)/.exec(
          html,
        )?.[1];
      expect(
        body,
        "the .fcard-body :is(h3) rule in the page's stylesheet",
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

    // The edge page's server script returns a <feat-card>, so the build
    // records the starter's components for request-time rendering and the
    // adapter bundles them: no "not rendered on this host" warning.
    const output = `${buildResult.stdout}\n${buildResult.stderr}`;
    expect(output).not.toContain("does not declare components: true");
    expect(output).toMatch(/component manifest: \d+ bytes \(\d+ components\)/);
    const manifest = JSON.parse(
      await readFile(join(projectDir, "dist/.bascik/components.json"), "utf8"),
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
