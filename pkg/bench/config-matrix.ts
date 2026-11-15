/**
 * Config matrix: build one project under many configurations and compare
 * what a browser renders against the default build.
 *
 *   yarn pkg:build
 *   yarn workspace @bascik/bascik profile:matrix [--only a,b] [--list]
 *       [--project <dir>] [--report-dir <dir>] [--skip-browser] [--keep]
 *
 * Without `--project` the driver copies `bench/config-matrix-fixture/` into
 * a private temporary directory and removes it afterwards (`--keep` leaves
 * it, with every build's output, and prints the path). A project marks the
 * elements to compare with `data-probe="<name>"`.
 *
 * For each variant the driver writes a config file, runs this workspace's
 * CLI (`src/index.ts --build --config <file>`) into its own output
 * directory, serves the output, loads every page in Chromium, and records
 * for each probe its rendered text, a set of computed styles, its box, and
 * which probe each ID reference (`for`, `aria-*`, `href="#..."`,
 * `popovertarget`, `list`, `form`, `url(#...)`) resolves to
 * (`config-matrix-snapshot.js`). Console errors, page errors, and failed
 * requests are recorded too. A variant whose option is not supposed to
 * change rendering must match the baseline; some must also be
 * byte-identical, to the baseline or to their `pipeline.workers: false` twin.
 *
 * Builds run one after another on the same project path, because instance
 * IDs hash absolute source paths. Exit code 1 when any variant fails.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Expectation =
  /** Every output file equals the baseline's. */
  | "bytes"
  /** Every HTML file equals the baseline's; other files may differ. */
  | "html-bytes"
  /** The browser snapshot equals the baseline's. */
  | "render"
  /** The option changes rendering by design: only a failed build fails. */
  | "builds";

interface Variant {
  name: string;
  config: Record<string, Json>;
  expect: Expectation;
  /** Compare against this variant instead of `baseline`. */
  against?: string;
  siteUrl?: string;
  /**
   * `assets.inlineStyles` stops copying the stylesheet, and the docs tell the
   * author to remove its `<link>`. The fixture keeps the link, so a missing
   * `.css` file is not a finding for these variants.
   */
  allowMissingCss?: boolean;
  /** Copy `src/pages` and `src/components` to these folders before the build. */
  relocate?: { pages: string; components: string };
}

const SITE_URL = "https://example.com";
const MINIFY_KEYS = ["html", "css", "js", "identifiers"] as const;

const minifyCombos = (): Variant[] => {
  const variants: Variant[] = [];
  // Every combination of the four minifiers except all-on (the baseline).
  for (let mask = 0; mask < 15; mask++) {
    const minify: Record<string, boolean> = {};
    const off: string[] = [];
    MINIFY_KEYS.forEach((key, bit) => {
      minify[key] = (mask & (1 << bit)) !== 0;
      if (!minify[key]) off.push(key);
    });
    variants.push({
      name: `minify-off-${off.join("+")}`,
      config: { minify },
      expect: "render",
    });
  }
  return variants;
};

const SECURITY_KEYS = [
  "blockScriptUrls",
  "blockCodeBindings",
  "headers",
  "hsts",
  "privateDynamicPages",
  "stripDirectiveScripts",
  "hideDotfiles",
];

const VARIANTS: Variant[] = [
  { name: "baseline", config: {}, expect: "bytes" },
  { name: "baseline-again", config: {}, expect: "bytes" },
  ...minifyCombos(),
  { name: "minify-false", config: { minify: false }, expect: "render" },
  { name: "minify-true", config: { minify: true }, expect: "bytes" },
  // Workers must not change a byte, under any minify setting.
  { name: "workers", config: { pipeline: { workers: true } }, expect: "bytes" },
  {
    name: "workers+minify-false",
    config: { pipeline: { workers: true }, minify: false },
    expect: "bytes",
    against: "minify-false",
  },
  {
    name: "workers+identifiers-off",
    config: { pipeline: { workers: true }, minify: { identifiers: false } },
    expect: "bytes",
    against: "minify-off-identifiers",
  },
  {
    name: "workers+inline-styles",
    config: { pipeline: { workers: true }, assets: { inlineStyles: true } },
    allowMissingCss: true,
    expect: "bytes",
    against: "inline-styles",
  },
  {
    name: "workers+base",
    config: { pipeline: { workers: true }, base: "/docs/" },
    expect: "bytes",
    against: "base",
  },
  {
    name: "workers+dedupe-off",
    config: {
      pipeline: { workers: true },
      scoping: { deduplicateCss: false },
    },
    expect: "bytes",
    against: "dedupe-off",
  },
  // Scoping options.
  {
    name: "dedupe-off",
    config: { scoping: { deduplicateCss: false } },
    expect: "render",
  },
  {
    name: "dedupe-off+minify-false",
    config: { scoping: { deduplicateCss: false }, minify: false },
    expect: "render",
  },
  {
    name: "dedupe-off+identifiers-off",
    config: {
      scoping: { deduplicateCss: false },
      minify: { identifiers: false },
    },
    expect: "render",
  },
  {
    name: "inherit-attributes-off",
    config: { scoping: { inheritAttributes: false } },
    expect: "render",
  },
  {
    name: "scope-name",
    config: { scoping: { attributes: { name: true } } },
    expect: "builds",
  },
  {
    name: "script-blocks-off",
    config: { scoping: { scriptBlocks: false } },
    expect: "builds",
  },
  {
    name: "scope-class-off",
    config: { scoping: { attributes: { class: false } } },
    expect: "builds",
  },
  {
    name: "scope-id-off",
    config: { scoping: { attributes: { id: false } } },
    expect: "builds",
  },
  // Assets.
  {
    name: "inline-styles",
    config: { assets: { inlineStyles: true } },
    allowMissingCss: true,
    expect: "render",
  },
  {
    name: "inline-styles+minify-false",
    config: { assets: { inlineStyles: true }, minify: false },
    allowMissingCss: true,
    expect: "render",
  },
  {
    name: "inline-styles+css-off",
    config: { assets: { inlineStyles: true }, minify: { css: false } },
    allowMissingCss: true,
    expect: "render",
  },
  {
    name: "inline-styles+html-off",
    config: { assets: { inlineStyles: true }, minify: { html: false } },
    allowMissingCss: true,
    expect: "render",
  },
  {
    name: "inline-styles+dedupe-off",
    config: {
      assets: { inlineStyles: true },
      scoping: { deduplicateCss: false },
    },
    allowMissingCss: true,
    expect: "render",
  },
  {
    name: "inline-styles+base",
    config: { assets: { inlineStyles: true }, base: "/docs/" },
    allowMissingCss: true,
    expect: "render",
  },
  { name: "symlink", config: { assets: { symlink: true } }, expect: "render" },
  // Generated files never change a page.
  {
    name: "generate-none",
    config: { generate: { sitemap: false, robots: false } },
    expect: "html-bytes",
  },
  {
    name: "generate-all",
    config: {
      generate: { sitemapLastmod: true, cspHashes: true, manifest: true },
    },
    expect: "html-bytes",
  },
  {
    name: "generate-all+workers",
    config: {
      generate: { sitemapLastmod: true, cspHashes: true, manifest: true },
      pipeline: { workers: true },
    },
    expect: "bytes",
    against: "generate-all",
  },
  // Base path and site URL.
  { name: "base", config: { base: "/docs/" }, expect: "render" },
  {
    name: "base-bare",
    config: { base: "docs" },
    expect: "bytes",
    against: "base",
  },
  { name: "base-deep", config: { base: "/a/b/c/" }, expect: "render" },
  {
    name: "base+minify-false",
    config: { base: "/docs/", minify: false },
    expect: "render",
  },
  {
    name: "base+identifiers-off",
    config: { base: "/docs/", minify: { identifiers: false } },
    expect: "render",
  },
  {
    name: "base+html-off",
    config: { base: "/docs/", minify: { html: false } },
    expect: "render",
  },
  {
    name: "site-url-trailing-slash",
    config: {},
    siteUrl: `${SITE_URL}/`,
    expect: "bytes",
  },
  {
    name: "site-url-with-path",
    config: { base: "/docs/" },
    siteUrl: `${SITE_URL}/docs/`,
    expect: "render",
  },
  // Security toggles: the fixture has nothing they rewrite.
  ...SECURITY_KEYS.map((key): Variant => ({
    name: `security-${key}-off`,
    config: { security: { [key]: false } },
    expect: "html-bytes",
  })),
  {
    name: "security-all-off",
    config: {
      security: Object.fromEntries(SECURITY_KEYS.map((key) => [key, false])),
    },
    expect: "html-bytes",
  },
  // Scripts.
  { name: "cache-off", config: { scripts: { cache: false } }, expect: "bytes" },
  {
    name: "cache-off+workers",
    config: { scripts: { cache: false }, pipeline: { workers: true } },
    expect: "bytes",
  },
  {
    name: "strip-ansi-off",
    config: { scripts: { stripAnsi: false } },
    expect: "bytes",
  },
  {
    name: "import-root-explicit",
    config: { scripts: { importRoot: "src" } },
    expect: "bytes",
  },
  // Logging and error policy.
  {
    name: "log-silent",
    config: {
      logging: {
        level: "silent",
        copies: false,
        deletes: false,
        transpiles: false,
      },
    },
    expect: "bytes",
  },
  {
    name: "minify-error-warn",
    config: { onMinifyError: "warn" },
    expect: "bytes",
  },
  // Directory overrides: instance IDs hash source paths, so only rendering matches.
  {
    name: "directories",
    config: { directory: { pages: "alt/site-pages", components: ["alt/ui"] } },
    relocate: { pages: "alt/site-pages", components: "alt/ui" },
    expect: "render",
  },
  {
    name: "directories+workers",
    config: {
      directory: { pages: "alt/site-pages", components: "alt/ui" },
      pipeline: { workers: true },
    },
    relocate: { pages: "alt/site-pages", components: "alt/ui" },
    expect: "bytes",
    against: "directories",
  },
];

// --- arguments -------------------------------------------------------------

/** A mistake in the command line: reported without a stack, exit code 2. */
class UsageError extends Error {}

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  // A flag that lost its value must not fall back to the default: `--only`
  // with nothing after it would run, and pass, a different set of variants.
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${flag} needs a value.`);
  return value;
};

/** The `--only` names, each checked against the variant list. */
const onlyNames = (): string[] | undefined => {
  const names = argValue("--only")?.split(",");
  const unknown = names?.filter(
    (name) => !VARIANTS.some((variant) => variant.name === name),
  );
  if (unknown?.length)
    throw new UsageError(
      `--only names no variant: ${unknown.join(", ")}. Run with --list to see the names.`,
    );
  return names;
};

/** The temporary fixture copy to remove when the run ends, however it ends. */
let temporaryProject: string | undefined;

const benchDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(benchDir, "..");
const CLI = join(packageDir, "src/index.ts");

// --- build -----------------------------------------------------------------

interface BuildResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

const BUILD_TIMEOUT_MS = 120_000;

const runBuild = (
  project: string,
  configPath: string,
  siteUrl: string,
): Promise<BuildResult> =>
  new Promise((resolveBuild) => {
    const child = spawn(
      process.execPath,
      [CLI, "--build", "--config", configPath, "--site-url", siteUrl],
      {
        cwd: project,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BUILD_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveBuild({ code, output, timedOut });
    });
  });

const listFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // statSync follows symlinks (assets.symlink).
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return files.sort();
};

const compareBytes = (
  outDir: string,
  baseDir: string,
  htmlOnly: boolean,
): string[] => {
  const keep = (file: string) => !htmlOnly || file.endsWith(".html");
  const mine = listFiles(outDir).filter(keep);
  const theirs = listFiles(baseDir).filter(keep);
  const problems: string[] = [];
  for (const file of theirs)
    if (!mine.includes(file)) problems.push(`missing file ${file}`);
  for (const file of mine) {
    if (!theirs.includes(file)) {
      problems.push(`extra file ${file}`);
      continue;
    }
    const a = readFileSync(join(outDir, file));
    const b = readFileSync(join(baseDir, file));
    if (!a.equals(b)) {
      let at = 0;
      while (at < a.length && at < b.length && a[at] === b[at]) at++;
      const from = Math.max(0, at - 40);
      problems.push(
        `${file} differs at byte ${at}:\n      this: ${JSON.stringify(a.subarray(from, at + 60).toString())}\n      base: ${JSON.stringify(b.subarray(from, at + 60).toString())}`,
      );
    }
  }
  return problems;
};

// --- serve -----------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

const serve = (outDir: string, base: string): Promise<Server> =>
  new Promise((resolveServer) => {
    const server = createServer((request, response) => {
      let path = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      const prefix = base.replace(/\/$/, "");
      if (prefix) {
        if (path !== prefix && !path.startsWith(`${prefix}/`)) {
          response.writeHead(404).end("outside base");
          return;
        }
        path = path.slice(prefix.length) || "/";
      }
      const candidates = [path, `${path}.html`, join(path, "index.html")];
      for (const candidate of candidates) {
        const file = join(outDir, candidate);
        if (
          file.startsWith(outDir) &&
          existsSync(file) &&
          statSync(file).isFile()
        ) {
          response.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
          });
          response.end(readFileSync(file));
          return;
        }
      }
      response.writeHead(404).end("not found");
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });

// --- browser snapshot --------------------------------------------------------

/**
 * The browser side of the snapshot. Kept as text: it runs in the page through
 * `page.evaluate`, and the package's TypeScript program has no DOM types.
 */
const SNAPSHOT_SOURCE = readFileSync(
  new URL("./config-matrix-snapshot.js", import.meta.url),
  "utf8",
);

const diffJson = (a: Json, b: Json, path = ""): string[] => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const key of keys) {
      out.push(
        ...diffJson(
          (a as Record<string, Json>)[key] ?? null,
          (b as Record<string, Json>)[key] ?? null,
          path ? `${path}.${key}` : key,
        ),
      );
    }
    return out;
  }
  return [`${path}: this ${JSON.stringify(a)} | base ${JSON.stringify(b)}`];
};

// --- main ------------------------------------------------------------------

const normalizeBase = (base: Json | undefined): string => {
  if (typeof base !== "string" || base === "/" || base === "") return "/";
  return `/${base.replace(/^\/+|\/+$/g, "")}/`;
};

/**
 * A private copy of the fixture. Realpath: on macOS the temporary directory
 * is a symlink, and the build must see the same paths this driver prints.
 * The fixture's build script imports `@bascik/bascik/html`, which resolves
 * to this workspace's built `dist/`.
 */
const makeFixtureProject = (): string => {
  if (!existsSync(join(packageDir, "dist/html.js")))
    throw new Error(
      "pkg/dist is missing: run `yarn pkg:build` first (the fixture's build script imports @bascik/bascik/html).",
    );
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "bascik-config-matrix-")),
  );
  chmodSync(project, 0o700);
  cpSync(join(benchDir, "config-matrix-fixture"), project, { recursive: true });
  mkdirSync(join(project, "node_modules/@bascik"), { recursive: true });
  symlinkSync(packageDir, join(project, "node_modules/@bascik/bascik"), "dir");
  return project;
};

const main = async (): Promise<number> => {
  if (process.argv.includes("--list")) {
    for (const variant of VARIANTS)
      console.log(`${variant.name}\t${variant.expect}`);
    return 0;
  }
  // Read every argument before anything is created, so a mistake in one
  // leaves nothing behind.
  const projectArg = argValue("--project");
  const reportArg = argValue("--report-dir");
  const only = onlyNames();
  const keep = process.argv.includes("--keep");
  const skipBrowser = process.argv.includes("--skip-browser");
  const project = projectArg ? resolve(projectArg) : makeFixtureProject();
  if (!projectArg && !keep) temporaryProject = project;
  const work = join(project, ".config-matrix");
  const reportDir = resolve(reportArg ?? join(work, "report"));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const selected = VARIANTS.filter(
    (variant) =>
      !only ||
      only.includes(variant.name) ||
      variant.name === "baseline" ||
      // A variant's comparison target must be built too.
      VARIANTS.some(
        (other) => only.includes(other.name) && other.against === variant.name,
      ),
  );

  const outDirs = new Map<string, string>();
  const failures = new Map<string, string[]>();
  const fail = (name: string, message: string) => {
    failures.set(name, [...(failures.get(name) ?? []), message]);
  };

  for (const variant of selected) {
    const outDir = join(work, "out", variant.name);
    const configPath = join(work, `${variant.name}.config.mjs`);
    const config = {
      ...variant.config,
      directory: {
        ...((variant.config.directory as Record<string, Json>) ?? {}),
        out: relative(project, outDir),
      },
    };
    writeFileSync(
      configPath,
      `export default ${JSON.stringify(config, null, 2)};\n`,
    );
    // The copy is removed after the build, folder and all. In a `--project`
    // run that folder could be the project's own, so it must not exist yet.
    const relocated =
      variant.relocate && join(project, variant.relocate.pages.split("/")[0]);
    if (relocated && existsSync(relocated)) {
      fail(
        variant.name,
        `not built: ${relocated} exists, and this variant copies the pages and components there and removes the folder afterwards`,
      );
      continue;
    }
    if (variant.relocate) {
      cpSync(
        join(project, "src/pages"),
        join(project, variant.relocate.pages),
        {
          recursive: true,
        },
      );
      cpSync(
        join(project, "src/components"),
        join(project, variant.relocate.components),
        { recursive: true },
      );
    }
    const started = Date.now();
    const result = await runBuild(
      project,
      configPath,
      variant.siteUrl ?? SITE_URL,
    );
    if (relocated) rmSync(relocated, { recursive: true, force: true });
    writeFileSync(join(reportDir, `${variant.name}.log`), result.output);
    process.stdout.write(
      `built ${variant.name} (${Date.now() - started}ms, exit ${result.code})\n`,
    );
    if (result.timedOut) fail(variant.name, "build timed out");
    else if (result.code !== 0)
      fail(
        variant.name,
        `build exited ${result.code}:\n${result.output.trim().split("\n").slice(-12).join("\n")}`,
      );
    else outDirs.set(variant.name, outDir);
  }

  // Byte comparisons.
  for (const variant of selected) {
    const outDir = outDirs.get(variant.name);
    if (!outDir || variant.name === "baseline") continue;
    if (variant.expect !== "bytes" && variant.expect !== "html-bytes") continue;
    const baseDir = outDirs.get(variant.against ?? "baseline");
    if (!baseDir) continue;
    for (const problem of compareBytes(
      outDir,
      baseDir,
      variant.expect === "html-bytes",
    ))
      fail(
        variant.name,
        `bytes vs ${variant.against ?? "baseline"}: ${problem}`,
      );
  }

  if (!skipBrowser) {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    const snapshots = new Map<string, Record<string, Json>>();
    try {
      const baselineDir = outDirs.get("baseline");
      const pages = baselineDir
        ? listFiles(baselineDir).filter((file) => file.endsWith(".html"))
        : [];
      for (const variant of selected) {
        const outDir = outDirs.get(variant.name);
        if (!outDir) continue;
        const base = normalizeBase(variant.config.base);
        const server = await serve(outDir, base);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const perPage: Record<string, Json> = {};
        const context = await browser.newContext({
          viewport: { width: 1000, height: 800 },
        });
        try {
          for (const file of pages) {
            const route = file
              .replace(/(^|\/)index\.html$/, "$1")
              .replace(/\.html$/, "");
            const page = await context.newPage();
            const problems: string[] = [];
            const missingCss = /\.css$|Failed to load resource/;
            page.on("console", (message) => {
              if (message.type() === "error" || message.type() === "warning")
                problems.push(`console ${message.type()}: ${message.text()}`);
            });
            page.on("pageerror", (error) =>
              problems.push(`pageerror: ${error.message}`),
            );
            page.on("requestfailed", (request) =>
              problems.push(
                `requestfailed: ${new URL(request.url()).pathname}`,
              ),
            );
            page.on("response", (response) => {
              if (response.status() >= 400)
                problems.push(
                  `http ${response.status()}: ${new URL(response.url()).pathname.slice(base.length - 1)}`,
                );
            });
            await page.addInitScript(
              `window.__matrixBase = ${JSON.stringify(base)};`,
            );
            await page.goto(`http://127.0.0.1:${port}${base}${route}`, {
              waitUntil: "load",
            });
            const snapshot = (await page.evaluate(SNAPSHOT_SOURCE)) as Json;
            const reported = variant.allowMissingCss
              ? problems.filter((problem) => !missingCss.test(problem))
              : problems;
            perPage[file] = { snapshot, problems: reported };
            // A "builds" variant ships scripts or names unscoped by design,
            // so what the page then does in a browser is not a finding.
            if (variant.expect !== "builds")
              for (const problem of reported)
                fail(variant.name, `${file}: ${problem}`);
            await page.close();
          }
        } finally {
          await context.close();
          await new Promise((done) => server.close(done));
        }
        snapshots.set(variant.name, perPage);
        writeFileSync(
          join(reportDir, `${variant.name}.snapshot.json`),
          JSON.stringify(perPage, null, 2),
        );
      }
    } finally {
      await browser.close();
    }
    for (const variant of selected) {
      if (variant.expect === "builds" || variant.name === "baseline") continue;
      const mine = snapshots.get(variant.name);
      const base = snapshots.get("baseline");
      if (!mine || !base) continue;
      for (const difference of diffJson(mine, base).slice(0, 40))
        fail(variant.name, `render: ${difference}`);
    }
  }

  const summary: string[] = [];
  for (const variant of selected) {
    const problems = failures.get(variant.name);
    summary.push(
      problems
        ? `FAIL ${variant.name} (${variant.expect})\n${problems.map((p) => `    ${p}`).join("\n")}`
        : `ok   ${variant.name} (${variant.expect})`,
    );
  }
  const text = summary.join("\n");
  writeFileSync(join(reportDir, "summary.txt"), `${text}\n`);
  console.log(text);
  console.log(`\n${failures.size} of ${selected.length} variants failed.`);
  if (temporaryProject) {
    if (reportArg) console.log(`Report: ${reportDir}`);
  } else {
    console.log(`Report: ${reportDir}\nBuilds: ${join(work, "out")}`);
  }
  return failures.size > 0 ? 1 : 0;
};

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`config-matrix: ${error.message}`);
  process.exitCode = 2;
} finally {
  // Also after a crash (a browser that will not start, a full disk): the
  // copy holds every build's output.
  if (temporaryProject)
    rmSync(temporaryProject, { recursive: true, force: true });
}
