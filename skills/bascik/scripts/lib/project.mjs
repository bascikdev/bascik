// Shared helpers for the Bascik skill scripts. Dependency-free; Node.js 22.22+.
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONFIG_FILES = [
  "bascik.config.js",
  "bascik.config.mjs",
  "bascik.config.ts",
];
export const DEFAULT_DOCS_URL = "https://bascik.dev";

/** Print a message to stderr and exit with the given code. */
export function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * True when the module at `metaUrl` is the script Node was asked to run. Both sides are compared as real paths:
 * Node resolves symlinks in the main module's path before setting import.meta.url, so comparing it with argv[1] as
 * typed made the script a silent no-op (exit 0, no output) whenever a folder on the path was a symlink or junction,
 * such as the skills CLI's install into .claude/skills.
 */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === metaUrl;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function dependsOnBascik(pkg) {
  if (!pkg) return false;
  return ["dependencies", "devDependencies", "peerDependencies"].some(
    (field) => pkg[field] && Object.hasOwn(pkg[field], "@bascik/bascik"),
  );
}

/**
 * Find the Bascik project root: the nearest directory, walking up from `start`, that has a bascik config file or a
 * package.json depending on @bascik/bascik. Falls back to the nearest package.json, then to `start`.
 */
export function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start);
  let nearestPackage;
  while (true) {
    if (CONFIG_FILES.some((file) => existsSync(join(dir, file)))) return dir;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      if (dependsOnBascik(readJson(pkgPath))) return dir;
      nearestPackage ??= dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return nearestPackage ?? resolve(start);
    dir = parent;
  }
}

/** Absolute path of the project's config file (the first of .js, .mjs, .ts, matching Bascik), or undefined. */
export function findConfigFile(root) {
  for (const file of CONFIG_FILES) {
    const path = join(root, file);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Import the project's config module. Returns `{ path, module }`, `{ path, error }` when the import fails, or
 * `undefined` when the project has no config (the zero-config default).
 */
export async function loadProjectConfig(root) {
  const path = findConfigFile(root);
  if (!path) return undefined;
  try {
    const module = await import(pathToFileURL(path).href);
    return { path, module };
  } catch (error) {
    return { path, error };
  }
}

/**
 * Locate an installed package directory by walking up node_modules from `root`. Works with npm, Yarn, and pnpm
 * layouts and with workspace symlinks. Does not use require.resolve because package export maps hide package.json.
 */
export function findInstalledPackage(root, name) {
  let dir = resolve(root);
  while (true) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Absolute path of a package's bin script, or undefined when the package is not installed. */
export function findPackageBin(root, name, binName) {
  const dir = findInstalledPackage(root, name);
  if (!dir) return undefined;
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg?.bin) return undefined;
  const rel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin[binName ?? Object.keys(pkg.bin)[0]];
  if (!rel) return undefined;
  const path = join(dir, rel);
  return existsSync(path) ? path : undefined;
}

/** Version string of an installed package, or undefined. */
export function installedVersion(root, name) {
  const dir = findInstalledPackage(root, name);
  return dir ? readJson(join(dir, "package.json"))?.version : undefined;
}

/** The project's component roots as absolute paths, from config `directory.components` or the default. */
export function componentRoots(root, configModule) {
  const configured = configModule?.default?.directory?.components;
  const list =
    configured === undefined
      ? ["src/components"]
      : Array.isArray(configured)
        ? configured
        : [configured];
  return list.map((entry) => resolve(root, entry));
}

/** The project's pages directory as an absolute path. */
export function pagesDirectory(root, configModule) {
  return resolve(root, configModule?.default?.directory?.pages ?? "src/pages");
}

/** Recursively list files under `dir` with one of `extensions`, skipping dot-directories and node_modules. */
export function walkFiles(dir, extensions) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) stack.push(full);
      else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)))
        out.push(full);
    }
  }
  return out.sort();
}

/** Run a command and capture its output. Never throws for a nonzero exit. */
export function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) =>
      resolvePromise({ code: 127, output: String(error.message) }),
    );
    child.on("close", (code, signal) => {
      resolvePromise({
        code: code ?? (signal ? 1 : 0),
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

/** Base URL of the documentation site. Override with BASCIK_DOCS_URL (for example a local docs dev server). */
export function docsBaseUrl() {
  return (process.env.BASCIK_DOCS_URL || DEFAULT_DOCS_URL).replace(/\/+$/, "");
}

/** Fetch the docs search index (one entry per page section). */
export async function fetchDocsIndex() {
  const url = `${docsBaseUrl()}/assets/search-index.json`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(
      `Could not reach ${url}: ${error.message}. Check the network, or set BASCIK_DOCS_URL.`,
    );
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data))
    throw new Error(`${url} did not return a JSON array.`);
  return data;
}

/** Normalize a docs reference (`/props`, `props`, `https://bascik.dev/props#x`) to a page path such as `/props`. */
export function normalizeDocPath(input) {
  let value = String(input).trim();
  try {
    if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
  } catch {
    // Not a URL; treat it as a path.
  }
  value = value
    .replace(/[#?].*$/, "")
    .replace(/\.html$/, "")
    .replace(/\/index$/, "/");
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value;
}
