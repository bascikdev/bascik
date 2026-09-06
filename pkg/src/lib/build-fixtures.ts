/**
 * Prompt 100 / 101 shared helpers: run real worker and serial builds against an
 * isolated fixture and read back the exact emitted disk inventory.
 *
 * These helpers intentionally execute the REAL page worker and the REAL main
 * thread. The worker boundary and the main-thread publishing path are never
 * mocked: the whole point of the parity suite is that identical serial and
 * worker builds publish identical artifact accounting. See
 * `worker-serial-parity.test.ts` and `targeted-build-owned-artifacts.test.ts`
 * for the consumers.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export interface BuildFixturePages {
  /** pageRelativePath -> source HTML */
  raw: boolean;
  /** "pages/<rel>" -> source bytes */
  assets: Record<string, string>;
}

export interface EmittedFile {
  hash: string;
  size: number;
}

export interface EmittedInventory {
  /** output-relative path (forward slashes) -> content hash + byte size */
  files: Record<string, EmittedFile>;
  /** page route path -> inline script/style hashes from dist/.bascik/csp-hashes.json */
  csp: Record<string, { scripts: string[]; styles: string[] }>;
  /** id -> source of each recorded server script (from the sidecar) */
  sidecar: Record<string, string>;
}

/** Recursively collect every file under `dir` as output-relative path -> bytes. */
export const readEmittedFiles = async (dir: string): Promise<Record<string, Buffer>> => {
  const out: Record<string, Buffer> = {};
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(dir, full).replace(/\\/g, "/");
      out[rel] = await readFile(full);
    }
  };
  await walk(dir);
  return out;
};

export const hashBytes = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

export const toInventory = (emitted: Record<string, Buffer>): EmittedInventory => ({
  files: Object.fromEntries(
    Object.entries(emitted)
      .filter(([rel]) => rel !== ".bascik/manifest.json")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rel, buf]) => [rel, { hash: hashBytes(buf), size: buf.length }]),
  ),
  csp: JSON.parse(emitted[".bascik/csp-hashes.json"]?.toString("utf8") ?? "{}"),
  sidecar: (Object.entries(
    JSON.parse(emitted[".bascik/server-scripts.json"]?.toString("utf8") ?? '{"scripts":{}}').scripts ?? {},
  ) as [string, { source: string }][]).reduce<Record<string, string>>((acc, [id, entry]) => {
    acc[id] = entry.source;
    return acc;
  }, {}),
});

export interface RunBuildOptions {
  /** Absolute path to the fixture project root. */
  projectRoot: string;
  /** Extra CLI args, e.g. --only "a.html". */
  args?: string[];
  /** Absolute path to the pkg entry (index.ts). */
  cliPath?: string;
  env?: Record<string, string>;
}

/**
 * Run a real `bascik --build` in a child Node process against `projectRoot`.
 * Exit 0 + non-empty dist is required; a failure surfaces stdout/stderr.
 */
export const runRealBuild = async (options: RunBuildOptions): Promise<{ stdout: string; stderr: string }> => {
  const cli = options.cliPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
  const args = ["--build", ...(options.args ?? [])];
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: options.projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    maxBuffer: 1024 * 1024 * 16,
  });
  return { stdout, stderr };
};

export const readSiteManifest = async (projectRoot: string) => {
  const content = await readFile(join(projectRoot, "dist", ".bascik", "manifest.json"), "utf8");
  return JSON.parse(content) as { version: string; files: Record<string, { hash: string; size: number }> };
};

export interface BuildFixture {
  root: string;
  /** Absolute paths of every emitted artifact file, excluding .bascik metadata. */
  emittedAssetPaths: string[];
}

/** Absolute path of the isolated fixture at the given root, creating subdirs. */
export const fixtureRoot = (name: string): string => {
  const root = join(tmpdir(), `bascik-100-${name}-${process.pid}-${Date.now()}`);
  return root;
};

export const createFixtureDirs = async (root: string): Promise<void> => {
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await mkdir(join(root, "src/pages/assets"), { recursive: true });
};

export const writeFixtureFile = async (root: string, relPath: string, content: string): Promise<void> => {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
};

/** (Re)write the fixture config to target a specific worker mode. */
export const writeWorkersConfig = async (root: string, workers: boolean): Promise<void> => {
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: ${workers} },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false },
};`,
  );
};

/**
 * The authored pages are path-stable only when the absolute source path is
 * stable: server-script placeholder ids and scoped instance ids derive from
 * the page path. Worker-versus-serial parity must therefore run both builds
 * against the SAME filesystem root, toggling the workers config between runs.
 */
export const writeParityFixture = async (root: string): Promise<BuildFixture> => {
  await createFixtureDirs(root);
  await writeWorkersConfig(root, true);

  await writeFixtureFile(
    root,
    "src/components/card.html",
    `<article class="card"><h2 class="card-title"><slot></slot></h2></article>`,
  );
  await writeFixtureFile(
    root,
    "src/components/card.style.css",
    `.card { border: 1px solid #ccc; } .card-title { color: rebeccapurple; }`,
  );

  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>首页 Home</title><style>.inline{color:red}</style></head><body>
  <h1 data-testid="home">Hello 世界</h1>
  <card>First</card><script>console.log('inline-script')</script>
  </body></html>`,
  );
  await writeFixtureFile(
    root,
    "src/pages/a.html",
    `<!DOCTYPE html><html><head><title>A</title></head><body>
  <p data-testid="a">A page</p>
  <script data-bascik-server>export default () => new Response('from server');</script>
  </body></html>`,
  );
  await writeFixtureFile(
    root,
    "src/pages/b.html",
    `<!DOCTYPE html><html><head><title>B</title></head><body><p data-testid="b">B page</p></body></html>`,
  );

  await writeFixtureFile(root, "src/pages/assets/logo.txt", "raw asset bytes\n");
  // unchanged-copy asset: content identical to its eventual dist copy (hash-equal no-op).
  await writeFixtureFile(root, "src/pages/assets/unchanged.txt", "same bytes both sides");

  return { root, emittedAssetPaths: [
    "a.html",
    "b.html",
    "index.html",
    "assets/logo.txt",
    "assets/unchanged.txt",
    ".bascik/csp-hashes.json",
    ".bascik/server-scripts.json",
  ] };
};

/** Remove the fixture root. */
export const cleanupFixture = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};