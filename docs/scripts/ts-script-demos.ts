/**
 * The Output panes of the TypeScript script demos, produced by the real compiler and server.
 *
 * Five demo boxes show a script written in TypeScript: a build script (/build-scripts), a server script
 * (/server-scripts), a stream script (/stream-scripts), a page's own `.ts` file (/scoped-javascript), and a
 * `scripts.typescript` esbuild compiler (/configuration). Their Output blocks are never written by hand.
 *
 * The Markdown is the single source. This library writes each demo's source blocks into a temp site under
 * /tmp/bascik-ts-script-demos/ (each block whole, at the path its first-line comment names, exactly as a reader's copy
 * button pastes it), runs the real `bascik --build`, reads `<body>` from the built page, and for a server or stream
 * script starts the real `bascik --server` and reads `<body>` from its response. Two sites are built: one with the
 * default compiler, and one with the documented esbuild `bascik.config.ts`. Each turns minification off, as every
 * Output in these docs does. The server is always stopped and the temp sites are always removed before this
 * returns.
 *
 * scripts/generate-ts-script-demos.ts writes the result into the Markdown, and scripts/ts-script-demos.test.ts
 * regenerates and compares, so a hand edit or a compiler change fails the docs unit tests.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { repoRoot } from "./example-fixtures.ts";
import { formatAsMarkdownFence, pathComment } from "./rtc-demos.ts";
import { extractBody } from "./url-root-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
export const SCRATCH = "/tmp/bascik-ts-script-demos";
const BASCIK_BIN = path.join(repoRoot, "pkg/bin/bascik.js");

export type TsDemoId = "build" | "server" | "stream" | "page" | "config";

export interface TsDemo {
  id: TsDemoId;
  /** The Markdown file (relative to docs/) that holds the demo's blocks. */
  md: string;
  /** The source blocks a reader copies into a site. */
  sources: string[];
  /** The generated block. */
  output: string;
  /** Which temp site builds it: the default compiler, or the documented esbuild config. */
  site: "default" | "esbuild";
  /** A built page under dist/, or a URL the server answers. */
  from: { built: string } | { url: string };
}

export const DEMOS: TsDemo[] = [
  {
    id: "build",
    md: "content/build-scripts.md",
    sources: ["ts-build-usage"],
    output: "ts-build-output-html",
    site: "default",
    from: { built: "build-scripts.html" },
  },
  {
    id: "server",
    md: "content/server-scripts.md",
    sources: ["ts-server-usage"],
    output: "ts-server-output-html",
    site: "default",
    from: { url: "/hello?name=Ada" },
  },
  {
    id: "stream",
    md: "content/stream-scripts.md",
    sources: ["ts-stream-usage"],
    output: "ts-stream-output-html",
    site: "default",
    from: { url: "/stock" },
  },
  {
    id: "page",
    md: "content/scoped-javascript.md",
    sources: ["ts-page-usage", "ts-page-source-js"],
    output: "ts-page-output-html",
    site: "default",
    from: { built: "counter.html" },
  },
  {
    id: "config",
    md: "content/configuration.md",
    sources: ["ts-config-esbuild", "ts-config-usage"],
    output: "ts-config-output-html",
    site: "esbuild",
    from: { built: "sizes.html" },
  },
];

/** Minification off, so the Output stays readable, as every Output in these docs is. */
export const MINIFY_OFF =
  "minify: { html: false, css: false, js: false, identifiers: false },";

export async function block(md: string, marker: string): Promise<string> {
  const result = await readDemoBlock(path.join(DOCS_ROOT, md), marker);
  if (result.code === undefined)
    throw new Error(`${md} ${marker}: ${result.problem}`);
  return result.code;
}

/**
 * A demo site's files: each source block at the path its first line names. A documented `bascik.config.ts` gets
 * minification turned off inside its `defineConfig({`; a site without one gets a config that only does that.
 */
export async function siteFiles(
  site: TsDemo["site"],
): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        { name: `ts-script-demos-${site}`, private: true, type: "module" },
        null,
        2,
      ) + "\n",
  };
  for (const demo of DEMOS.filter((d) => d.site === site)) {
    for (const marker of demo.sources) {
      const code = await block(demo.md, marker);
      const rel = pathComment(code);
      if (files[rel] !== undefined)
        throw new Error(`two demo blocks write ${rel}`);
      files[rel] = code + "\n";
    }
  }
  const config = files["bascik.config.ts"];
  if (config !== undefined) {
    if (!config.includes("defineConfig({\n"))
      throw new Error("the documented bascik.config.ts has no defineConfig({");
    files["bascik.config.ts"] = config.replace(
      "defineConfig({\n",
      `defineConfig({\n  ${MINIFY_OFF}\n`,
    );
  } else {
    files["bascik.config.ts"] =
      `import { defineConfig } from "@bascik/bascik/config";\n\nexport default defineConfig({\n  ${MINIFY_OFF}\n});\n`;
  }
  return files;
}

const cliEnv = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  BASCIK_SITE_URL: "https://example.com",
};

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

export interface TsDemoRun {
  /** Each demo's `<body>`, as built or sent. */
  raw: Record<TsDemoId, string>;
  /** Each demo's Output block text, formatted as `prettier --write` formats the fence. */
  formatted: Record<TsDemoId, string>;
  /** The temp workspace, already removed. */
  scratch: string;
}

/** Builds both demo sites, serves the default one for the request-time demos, and reads every Output. */
export async function runTsScriptDemos(): Promise<TsDemoRun> {
  if (!existsSync(path.join(repoRoot, "pkg/dist/index.js")))
    throw new Error("pkg/dist is missing: run `yarn pkg:build` first");
  mkdirSync(SCRATCH, { recursive: true });
  const scratch = mkdtempSync(path.join(SCRATCH, "demos-"));
  const raw = {} as Record<TsDemoId, string>;
  try {
    // node_modules sits above the sites, as in a monorepo, so bascik.config.ts resolves @bascik/bascik and esbuild.
    const modules = path.join(scratch, "node_modules");
    mkdirSync(path.join(modules, "@bascik"), { recursive: true });
    symlinkSync(
      path.join(repoRoot, "pkg"),
      path.join(modules, "@bascik/bascik"),
      "dir",
    );
    symlinkSync(
      path.join(repoRoot, "node_modules/esbuild"),
      path.join(modules, "esbuild"),
      "dir",
    );
    for (const site of ["default", "esbuild"] as const) {
      const dir = path.join(scratch, site);
      for (const [rel, content] of Object.entries(await siteFiles(site))) {
        const abs = path.join(dir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      const built = spawnSync(process.execPath, [BASCIK_BIN, "--build"], {
        cwd: dir,
        encoding: "utf8",
        env: cliEnv,
        timeout: 120_000,
      });
      if (built.status !== 0)
        throw new Error(
          `bascik --build failed in ${dir}:\n${built.stdout}\n${built.stderr}`,
        );
      const demos = DEMOS.filter((d) => d.site === site);
      for (const demo of demos) {
        if ("built" in demo.from)
          raw[demo.id] = extractBody(
            readFileSync(path.join(dir, "dist", demo.from.built), "utf8"),
          );
      }
      const served = demos.filter((d) => "url" in d.from);
      if (served.length === 0) continue;
      const server = await startServer(dir);
      try {
        for (const demo of served) {
          const url = (demo.from as { url: string }).url;
          const res = await fetch(`${server.origin}${url}`);
          const body = await res.text();
          if (res.status !== 200)
            throw new Error(`GET ${url} returned ${res.status}:\n${body}`);
          raw[demo.id] = extractBody(body);
        }
      } finally {
        await server.stop();
      }
    }
    const formatted = {} as Record<TsDemoId, string>;
    for (const demo of DEMOS)
      formatted[demo.id] = await formatAsMarkdownFence(raw[demo.id], demo.md);
    return { raw, formatted, scratch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
