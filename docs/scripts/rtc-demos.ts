/**
 * The Output panes of the "Returning component tags" demos, produced by the real request renderer.
 *
 * The demo boxes (server-scripts.md, stream-scripts.md, testing/troubleshooting.md, security.md) show what a
 * server or stream script that returns component tags sends. Their Output blocks are never written by hand: this library
 * builds ONE site from the Markdown source blocks only (each written whole, path comment included, to the path its
 * first-line comment names, exactly as a reader's copy button would paste it, plus the documented bascik.config.ts
 * with minification off), runs the real `bascik --build`, `bascik --check` and
 * `bascik --server`, and fetches each demo URL. The server is always stopped before this returns.
 *
 * Why committed blocks instead of running this during the docs build: a nested build plus a server process on a
 * port would make every docs build slower and depend on spawning, and llms.txt and the skill would no longer see
 * the Output inline. scripts/generate-rtc-demos.ts writes the result into the Markdown, and scripts/rtc-demos.test.ts
 * regenerates and compares, so a hand edit or a renderer change fails the docs unit tests.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { repoRoot } from "./example-fixtures.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = "/tmp/bascik-rtc-docs-demos";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");

export type DemoId =
  | "search"
  | "live"
  | "stream"
  | "passthrough"
  | "security-search"
  | "security-malicious";

export interface Demo {
  id: DemoId;
  /** The Markdown file (relative to docs/) that holds the demo's Output block. */
  md: string;
  /** The page the demo site serves for it. */
  url: string;
  /** `prettier`: formatted as `prettier --write` formats an ```html fence. `verbatim`: the bytes as sent. */
  format: "prettier" | "verbatim";
  outputMarker: string;
}

/** The query the security page's malicious demo sends: a component tag and an onerror payload. */
export const MALICIOUS_Q =
  "<product-card data-bascik-prop-name=x><img src=x onerror=alert(1)></product-card>";

export const DEMOS: Demo[] = [
  {
    id: "search",
    md: "content/server-scripts.md",
    url: "/search",
    format: "prettier",
    outputMarker: "rtc-search-output-html",
  },
  {
    id: "live",
    md: "content/server-scripts.md",
    url: "/featured",
    format: "prettier",
    outputMarker: "rtc-live-output-html",
  },
  {
    id: "stream",
    md: "content/stream-scripts.md",
    url: "/new-arrivals",
    format: "prettier",
    outputMarker: "rtc-stream-output-html",
  },
  {
    id: "passthrough",
    md: "content/testing/troubleshooting.md",
    url: "/help",
    format: "verbatim",
    outputMarker: "rtc-passthrough-output-html",
  },
  {
    id: "security-search",
    md: "content/security.md",
    url: "/find?q=kettle",
    format: "prettier",
    outputMarker: "security-search-output",
  },
  {
    id: "security-malicious",
    md: "content/security.md",
    url: `/find?q=${encodeURIComponent(MALICIOUS_Q)}`,
    format: "prettier",
    outputMarker: "security-malicious-q-output",
  },
];

/** Every source block a reader copies into a site, by Markdown file and marker. */
export const SOURCE_BLOCKS: [md: string, marker: string][] = [
  ["content/server-scripts.md", "rtc-search-source-usage"],
  ["content/server-scripts.md", "rtc-search-source-html"],
  ["content/server-scripts.md", "rtc-search-source-css"],
  ["content/server-scripts.md", "rtc-search-source-js"],
  ["content/server-scripts.md", "rtc-live-source-usage"],
  ["content/server-scripts.md", "rtc-live-source-html"],
  ["content/server-scripts.md", "rtc-live-source-css"],
  ["content/stream-scripts.md", "rtc-stream-source-usage"],
  ["content/testing/troubleshooting.md", "rtc-passthrough-source-usage"],
  ["content/security.md", "security-search-source-usage"],
];

/** The Markdown file that documents the bascik.config.ts the Output was made with. */
const CONFIG_MD = "content/server-scripts.md";

/** The path a block's first-line comment names: `<!-- p -->`, `/* p *\/` or `// p`. */
export function pathComment(code: string): string {
  const first = code.split("\n")[0];
  const named =
    /^<!--\s*(\S+)\s*-->$/.exec(first)?.[1] ??
    /^\/\*\s*(\S+)\s*\*\/$/.exec(first)?.[1] ??
    /^\/\/\s*(\S+)$/.exec(first)?.[1];
  if (!named) throw new Error(`demo block has no path comment: ${first}`);
  return named;
}

async function block(md: string, marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, md), marker);
  if (result.code === undefined)
    throw new Error(`${md} ${marker}: ${result.problem}`);
  return result.code;
}

/** The documented config: the ```ts block whose first line is `// bascik.config.ts`, minus that line. */
function documentedConfig(): string {
  const md = readFileSync(path.join(DOCS_ROOT, CONFIG_MD), "utf8");
  const config = /```ts\n\/\/ bascik\.config\.ts\n([\s\S]*?)\n```/.exec(
    md,
  )?.[1];
  if (config === undefined)
    throw new Error(
      `${CONFIG_MD} documents no \`\`\`ts // bascik.config.ts block`,
    );
  return config + "\n";
}

/**
 * The demo site: each source block, whole, at the path its first line names, plus bascik.config.ts. The path comment
 * stays in the file because a reader who copies the block gets it too, and it shows in the Output when minification
 * is off. The config's own comment line is dropped; it never reaches a response.
 */
export async function demoSiteFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [md, marker] of SOURCE_BLOCKS) {
    const code = await block(md, marker);
    const sitePath = pathComment(code);
    if (files[sitePath] !== undefined)
      throw new Error(`two demo blocks write ${sitePath}`);
    files[sitePath] = code + "\n";
  }
  files["bascik.config.ts"] = documentedConfig();
  return files;
}

/** What `prettier --write` makes of a ```html (or ```css) fence holding `raw` in the docs Markdown file `md`. */
export async function formatAsMarkdownFence(
  raw: string,
  md: string,
  lang: "html" | "css" = "html",
): Promise<string> {
  const prettier = await import("prettier");
  const options =
    (await prettier.resolveConfig(path.join(DOCS_ROOT, md))) ?? {};
  const source = "```" + lang + "\n" + raw.replace(/\n+$/, "") + "\n```\n";
  const out = await prettier.format(source, { ...options, parser: "markdown" });
  return new RegExp("^```" + lang + "\\n([\\s\\S]*?)\\n?```", "m")
    .exec(out)![1]
    .replace(/\n$/, "");
}

/** The Output block text for a demo: formatted, or the verbatim body without its final newline. */
export async function outputBlockText(
  demo: Demo,
  raw: string,
): Promise<string> {
  return demo.format === "verbatim"
    ? raw.replace(/\n$/, "")
    : formatAsMarkdownFence(raw, demo.md);
}

const newestMtime = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? newestMtime(abs)
        : /(?<!\.test)\.ts$/.test(entry.name)
          ? statSync(abs).mtimeMs
          : 0,
    );
  }
  return newest;
};

/** Warns when pkg/dist is older than the TypeScript in pkg/src: the Output would come from a stale renderer. */
function warnOnStaleDist(): void {
  const dist = path.join(repoRoot, "pkg/dist/index.js");
  if (!existsSync(dist)) {
    throw new Error("pkg/dist is missing: run `yarn pkg:build` first");
  }
  if (newestMtime(path.join(repoRoot, "pkg/src")) > statSync(dist).mtimeMs) {
    console.warn(
      "[rtc-demos] pkg/src is newer than pkg/dist: run `yarn pkg:build` so the Output comes from the current renderer.",
    );
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });

// A production build needs a site URL for its sitemap and robots.txt; nothing in the demo pages prints it.
const cliEnv = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  BASCIK_SITE_URL: "https://example.com",
};

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [BASCIK_BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: cliEnv,
    timeout: 120_000,
  });
}

async function startServer(
  cwd: string,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [BASCIK_BIN, "--server", "--port", String(port), "--host", "127.0.0.1"],
    { cwd, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  child.stdout?.on("data", (d) => output.push(String(d)));
  child.stderr?.on("data", (d) => output.push(String(d)));
  const stop = () =>
    new Promise<void>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolveStop();
      child.once("exit", () => resolveStop());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });
  const origin = `http://127.0.0.1:${port}`;
  try {
    // Readiness is the health endpoint, never a sleep.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`bascik --server exited early:\n${output.join("")}`);
      try {
        const res = await fetch(`${origin}/_health/ready`);
        await res.arrayBuffer();
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline)
        throw new Error(
          `bascik --server never became ready:\n${output.join("")}`,
        );
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { origin, stop };
}

export interface RtcDemoRun {
  /** Each demo's response body, as sent. */
  raw: Record<DemoId, string>;
  /** Each demo's Output block text (formatted or verbatim, per DEMOS). */
  formatted: Record<DemoId, string>;
  /** `bascik --check` on the demo site. */
  check: { status: number | null; output: string };
}

/**
 * Builds, checks and serves the demo site and fetches every demo URL. With `projectDir`, that project (a site a
 * reader assembled from the blocks) is built and served instead of a fresh one. The server is always stopped.
 */
export async function runRtcDemos(
  opts: { projectDir?: string } = {},
): Promise<RtcDemoRun> {
  warnOnStaleDist();
  let dir = opts.projectDir;
  let cleanup = () => {};
  if (!dir) {
    mkdirSync(SCRATCH, { recursive: true });
    const workspace = mkdtempSync(path.join(SCRATCH, "site-"));
    cleanup = () => rmSync(workspace, { recursive: true, force: true });
    // node_modules sits above the site, as in a monorepo, so bascik.config.ts resolves @bascik/bascik.
    const scope = path.join(workspace, "node_modules/@bascik");
    mkdirSync(scope, { recursive: true });
    symlinkSync(path.join(repoRoot, "pkg"), path.join(scope, "bascik"), "dir");
    dir = path.join(workspace, "site");
    const files = {
      "package.json":
        JSON.stringify(
          { name: "rtc-demos", private: true, type: "module" },
          null,
          2,
        ) + "\n",
      ...(await demoSiteFiles()),
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  try {
    const built = runCli(dir, ["--build"]);
    if (built.status !== 0)
      throw new Error(
        `bascik --build failed in ${dir}:\n${built.stdout}\n${built.stderr}`,
      );
    const checked = runCli(dir, ["--check"]);
    const check = {
      status: checked.status,
      output: `${checked.stdout}\n${checked.stderr}`.trim(),
    };
    const server = await startServer(dir);
    const raw = {} as Record<DemoId, string>;
    try {
      for (const demo of DEMOS) {
        const res = await fetch(`${server.origin}${demo.url}`);
        const body = await res.text();
        if (res.status !== 200)
          throw new Error(`GET ${demo.url} returned ${res.status}:\n${body}`);
        raw[demo.id] = body;
      }
    } finally {
      await server.stop();
    }
    const formatted = {} as Record<DemoId, string>;
    for (const demo of DEMOS)
      formatted[demo.id] = await outputBlockText(demo, raw[demo.id]);
    return { raw, formatted, check };
  } finally {
    cleanup();
  }
}
