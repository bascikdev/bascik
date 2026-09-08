/**
 * @module serverless-artifacts
 *
 * Compile request-time code into a private deployment bundle (prompt 133).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bascik --build --target <name>` runs the ordinary build first, then this
 * module reads ONLY what the build wrote to `directory.out` (pages, assets,
 * the server-scripts sidecar) plus the API route sources, and emits a
 * deployment folder under `dist/.bascik/<target>/`:
 *
 *   dist/.bascik/cloudflare-pages/
 *     public/            the upload tree: static files + _worker.js + _routes.json
 *     build-info.json    release identity, compatibility date, bundle size, routes
 *
 *   dist/.bascik/cloudflare-workers/
 *     public/            static files only (Workers Static Assets directory)
 *     worker.js          the Module Worker entry
 *     wrangler.jsonc     assets binding + run_worker_first routing
 *     build-info.json
 *
 * Public versus private, by construction:
 * - a dynamic page (one with any server/stream job) is NEVER copied into
 *   `public/`; its template lives inside the worker bundle. A routing failure
 *   that lets the request reach the asset layer yields a 404, not a page with
 *   inert placeholders;
 * - `.bascik/`, source maps, precompressed sidecars, and hidden paths are
 *   excluded from `public/` by rule, not by dotfile assumption;
 * - handler modules and page plans exist only in the bundle.
 *
 * Bundling uses esbuild resolved from the USER's project (it is not a
 * dependency of `@bascik/bascik`). A missing install is a clear error with the
 * install command. Unsupported Node builtins are rejected with the authored
 * import chain; nothing is stubbed.
 */

import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BascikConfig } from "./config.ts";
import { getHttpPath } from "./paths.ts";
import { getImportRoot } from "./import-root.ts";
import { rewriteModuleSpecifiers, resolveScriptSrcPath } from "./module-specifiers.ts";
import { scanApiRouteFiles, buildApiRouteTree, type ApiRouteDefinition } from "./api-routes.ts";
import { withBasePath } from "./base-path.ts";
import { getHtmlAttributeValue } from "./html-patterns.ts";
import { SIDECAR_SCHEMA_VERSION, type ServerScriptEntry, type ServerScriptsSidecar } from "./server-sidecar.ts";
import { DEFAULT_SCRIPT_TIMEOUT_MS } from "./server-scripts.ts";
import type { DeployTarget } from "./cli.ts";

export type { DeployTarget };

// ─── Pinned target facts ─────────────────────────────────────────────────────

/**
 * Compatibility date the generated Worker declares. Pinned, not "today":
 * Cloudflare's Node compatibility defaults depend on this date, and the local
 * workerd harness in `miniflare` only accepts dates its binary knows. Bump it
 * together with the `miniflare` devDependency and re-run the parity suite.
 */
export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-01";

/** Flags the generated Worker declares. `nodejs_compat` enables the supported `node:*` subset. */
export const CLOUDFLARE_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

/** Cloudflare Pages `_routes.json` accepts at most this many combined rules. */
export const PAGES_ROUTES_LIMIT = 100;

/**
 * `node:*` modules Workers provides under `nodejs_compat` for the pinned date.
 * Source: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
 * Anything else is rejected at build time with an import-chain diagnostic.
 */
export const WORKERS_SUPPORTED_NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "querystring",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "url",
  "util",
  "util/types",
  "zlib",
]);

const ALL_NODE_BUILTINS: ReadonlySet<string> = new Set([
  ...WORKERS_SUPPORTED_NODE_BUILTINS,
  "child_process",
  "cluster",
  "console",
  "constants",
  "dgram",
  "domain",
  "http2",
  "inspector",
  "module",
  "punycode",
  "readline",
  "readline/promises",
  "repl",
  "sys",
  "trace_events",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

export type NodeBuiltinClass = "provided" | "unsupported" | "not-builtin";

export const classifyNodeBuiltin = (specifier: string): NodeBuiltinClass => {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (!ALL_NODE_BUILTINS.has(bare)) return "not-builtin";
  return WORKERS_SUPPORTED_NODE_BUILTINS.has(bare) ? "provided" : "unsupported";
};

// ─── Pure planning helpers ───────────────────────────────────────────────────

export interface DistPageSegment {
  kind: "static" | "script";
  text?: string;
  id?: string;
}

const PLACEHOLDER_RE =
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*type=["']text\/bascik-server["'](?:[^>"']|"[^"]*"|'[^']*')*>\s*<\/script>/gi;

/** Split built placeholder HTML into static text and script ids, in document order. */
export const splitDistPageIntoSegments = (html: string): { segments: DistPageSegment[]; scriptIds: string[] } => {
  const segments: DistPageSegment[] = [];
  const scriptIds: string[] = [];
  let cursor = 0;
  for (const match of html.matchAll(PLACEHOLDER_RE)) {
    const index = match.index!;
    const id = getHtmlAttributeValue(match[0], "data-bascik-server-id");
    if (!id) continue;
    if (index > cursor) segments.push({ kind: "static", text: html.slice(cursor, index) });
    segments.push({ kind: "script", id });
    scriptIds.push(id);
    cursor = index + match[0].length;
  }
  if (cursor < html.length || segments.length === 0) segments.push({ kind: "static", text: html.slice(cursor) });
  return { segments, scriptIds };
};

/**
 * Every request spelling the Node server resolves to a page: the canonical
 * path, its trailing-slash toggle, `/index`, and `.html` forms. Used both to
 * key the worker's page table and to generate invocation routes.
 */
export const pageAliasesFor = (httpPath: string, base: string): string[] => {
  const aliases: string[] = [];
  const push = (p: string) => {
    const withBase = withBasePath(p, base);
    if (!aliases.includes(withBase)) aliases.push(withBase);
  };
  push(httpPath);
  if (httpPath === "/") {
    // With a base, the Node server also maps the bare prefix (`/docs`) to `/`.
    if (base !== "/") aliases.push(base.replace(/\/$/, ""));
    push("/index");
    push("/index.html");
  } else if (httpPath.endsWith("/")) {
    push(httpPath.slice(0, -1));
    push(`${httpPath}index`);
    push(`${httpPath}index.html`);
  } else {
    push(`${httpPath}/`);
    push(`${httpPath}.html`);
  }
  return aliases;
};

/** Whether a dist-relative path may be uploaded as a public static file. */
export const isPublicAssetPath = (distRelativePath: string): boolean => {
  const normalized = distRelativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") && segment !== ".well-known")) return false;
  if (normalized.endsWith(".map")) return false;
  if (/\.(br|gz)$/i.test(normalized) || /\.bmeta$/i.test(normalized)) return false;
  return true;
};

export interface InvocationRoutes {
  include: string[];
  exclude: string[];
  /** True when the rule count exceeded the platform limit and `/*` was used instead. */
  overflowed: boolean;
}

/**
 * Routes that must invoke the Worker: every alias of every dynamic page and
 * the API prefix. Everything else is served by the asset layer.
 */
export const buildInvocationRoutes = (input: {
  base: string;
  dynamicPagePaths: string[];
  hasApiRoutes: boolean;
}): InvocationRoutes => {
  const include = new Set<string>();
  for (const path of input.dynamicPagePaths) for (const alias of pageAliasesFor(path, input.base)) include.add(alias);
  if (input.hasApiRoutes) include.add(withBasePath("/api/*", input.base));
  // Generated control files are routed to the worker, which answers 404, so
  // the bundle can never be downloaded from the public origin even on a host
  // that would otherwise serve every uploaded file.
  for (const control of GENERATED_CONTROL_PATHS) include.add(withBasePath(control, input.base));
  const sorted = Array.from(include).sort();
  if (sorted.length > PAGES_ROUTES_LIMIT) {
    return { include: [withBasePath("/*", input.base)], exclude: [], overflowed: true };
  }
  return { include: sorted, exclude: [], overflowed: false };
};

/** Public-tree control files the worker refuses to serve. */
export const GENERATED_CONTROL_PATHS = ["/_worker.js", "/_routes.json"] as const;

const CONTROL_FILES: Record<DeployTarget, string[]> = {
  "cloudflare-pages": ["_worker.js", "_routes.json"],
  "cloudflare-workers": ["wrangler.jsonc", "worker.js"],
};

/** Authored public files that would shadow generated control files or static API routes. */
export const detectPublicCollisions = (input: {
  publicPaths: string[];
  apiRoutePaths: string[];
  target: DeployTarget;
}): string[] => {
  const problems: string[] = [];
  const control = new Set(CONTROL_FILES[input.target]);
  for (const path of [...input.publicPaths].sort()) {
    if (control.has(path)) {
      problems.push(`[bascik] --target ${input.target}: authored file "${path}" collides with a generated control file. Rename it or remove it from directory.pages.`);
    }
  }
  const staticApi = new Set(input.apiRoutePaths.filter((p) => !p.includes("[")).map((p) => p.replace(/^\/+/, "")));
  for (const path of input.publicPaths) {
    const withoutExt = path.replace(/\.[a-zA-Z0-9]+$/, "");
    if (staticApi.has(path) || staticApi.has(withoutExt)) {
      problems.push(`[bascik] --target ${input.target}: public file "${path}" shadows API route "/${path.replace(/\.[a-zA-Z0-9]+$/, "")}".`);
    }
  }
  return problems;
};

export const formatUnsupportedImport = (input: {
  specifier: string;
  importer: string;
  projectRoot: string;
  owners: string[];
}): string => {
  const rel = relative(input.projectRoot, input.importer).replace(/\\/g, "/");
  const owners = input.owners.length ? `\n  Reached from: ${input.owners.join(", ")}` : "";
  return (
    `[bascik] --target: "${input.specifier}" (imported by ${rel}) is not available in the Cloudflare Workers runtime ` +
    `for compatibility date ${CLOUDFLARE_COMPATIBILITY_DATE}.${owners}\n` +
    `  Move that dependency out of request-time code, or keep this site on \`bascik --server\`.`
  );
};

// ─── Build-time assembly ─────────────────────────────────────────────────────

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{
    outputFiles?: Array<{ path: string; contents: Uint8Array; text: string }>;
    errors: Array<{ text: string; location?: { file: string } | null }>;
    warnings: Array<{ text: string }>;
    metafile?: { inputs: Record<string, unknown>; outputs: Record<string, { bytes: number }> };
  }>;
}

/**
 * esbuild is the user's dependency, not Bascik's. Resolve it from the project
 * and fail with the install command when absent.
 */
export const loadProjectEsbuild = async (projectRoot: string): Promise<EsbuildLike> => {
  const require = createRequire(join(projectRoot, "package.json"));
  let entry: string;
  try {
    entry = require.resolve("esbuild");
  } catch {
    throw new Error(
      "[bascik] --target needs esbuild to bundle request-time code, and it is not installed in this project.\n" +
      "  Install it as a dev dependency: npm install --save-dev esbuild",
    );
  }
  return (await import(pathToFileURL(entry).href)) as EsbuildLike;
};

interface ScriptJobSource {
  id: string;
  mode: "server" | "stream";
  /** Absolute module file for `src=` jobs; undefined for inline jobs. */
  modulePath?: string;
  /** Rewritten inline source (absolute file: URLs) for inline jobs. */
  inlineSource?: string;
  owner: string;
}

const owners = new Map<string, Set<string>>();
const addOwner = (file: string, owner: string): void => {
  let set = owners.get(file);
  if (!set) owners.set(file, (set = new Set()));
  set.add(owner);
};

const readDistFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).replace(/\\/g, "/"));
    }
  };
  await walk(dir);
  return out;
};

const hashOf = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex").slice(0, 16);

const ident = (id: string): string => `m_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;

export interface ServerlessBuildResult {
  target: DeployTarget;
  outDir: string;
  publicDir: string;
  workerPath: string;
  bundleBytes: number;
  dynamicPages: string[];
  apiRoutes: string[];
  invocationRoutes: InvocationRoutes;
  release: string;
}

/**
 * Assemble the deployment folder for `target` from a completed build.
 * Throws with an actionable message on unsupported imports, collisions, or a
 * missing bundler. Never runs user handlers.
 */
export const emitServerlessArtifacts = async (
  target: DeployTarget,
  options: { version: string; projectRoot?: string } ,
): Promise<ServerlessBuildResult> => {
  const projectRoot = options.projectRoot ?? process.cwd();
  const distDir = resolve(projectRoot, BascikConfig.directory.out);
  const base = BascikConfig.base;
  const targetDir = join(distDir, ".bascik", target);
  const publicDir = join(targetDir, "public");
  const stagingDir = join(targetDir, ".staging");
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  owners.clear();

  // ── Sidecar: the only source of request-time script code ─────────────────
  let sidecar: ServerScriptsSidecar | null = null;
  try {
    sidecar = JSON.parse(await readFile(join(distDir, ".bascik", "server-scripts.json"), "utf8")) as ServerScriptsSidecar;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (sidecar && sidecar.schema !== undefined && sidecar.schema !== SIDECAR_SCHEMA_VERSION) {
    throw new Error(`[bascik] --target: sidecar schema ${sidecar.schema} is not understood (expected ${SIDECAR_SCHEMA_VERSION}). Run \`bascik --build\` again.`);
  }
  const sidecarScripts: Record<string, ServerScriptEntry> = sidecar?.scripts ?? {};

  // ── Classify every dist file ─────────────────────────────────────────────
  const distFiles = await readDistFiles(distDir);
  const publicPaths: string[] = [];
  const dynamicPages = new Map<string, { path: string; is404: boolean; segments: DistPageSegment[]; jobs: ScriptJobSource[] }>();
  let custom500: string | undefined;
  const pagesDir = BascikConfig.directory.pages;
  const importRoot = getImportRoot();

  for (const rel of distFiles) {
    if (rel.startsWith(".bascik/")) continue;
    if (!isPublicAssetPath(rel)) continue;
    if (/\.html?$/i.test(rel)) {
      const html = await readFile(join(distDir, rel), "utf8");
      const { segments, scriptIds } = splitDistPageIntoSegments(html);
      const httpPath = getHttpPath(rel, pagesDir);
      if (httpPath === "/500") custom500 = html;
      if (scriptIds.length === 0) {
        publicPaths.push(rel);
        continue;
      }
      const jobs: ScriptJobSource[] = [];
      for (const id of scriptIds) {
        const entry = sidecarScripts[id];
        if (!entry) {
          throw new Error(`[bascik] --target: page "${rel}" references server script "${id}" that is missing from the sidecar. Run \`bascik --build\` again.`);
        }
        const owner = `${entry.mode} script in ${entry.sourceFile ? relative(projectRoot, entry.sourceFile).replace(/\\/g, "/") : rel}${entry.sourceLine ? `:${entry.sourceLine}` : ""}`;
        const containingDir = entry.sourceFile ? dirname(resolve(projectRoot, entry.sourceFile)) : projectRoot;
        if (entry.modulePath) {
          const modulePath = resolveScriptSrcPath(entry.modulePath, containingDir, importRoot);
          addOwner(modulePath, owner);
          jobs.push({ id, mode: entry.mode, modulePath, owner });
        } else {
          const rewritten = rewriteModuleSpecifiers(entry.source, containingDir, { importRoot });
          jobs.push({ id, mode: entry.mode, inlineSource: rewritten, owner });
        }
      }
      // Dynamic templates stay private: never copied to public/.
      dynamicPages.set(httpPath, { path: httpPath, is404: httpPath === "/404", segments, jobs });
      continue;
    }
    publicPaths.push(rel);
  }

  // ── API routes from source ───────────────────────────────────────────────
  const apiDir = resolve(projectRoot, BascikConfig.directory.api ?? "src/api");
  const apiFiles = await scanApiRouteFiles(apiDir);
  const apiRoutes: ApiRouteDefinition[] = apiFiles.length ? buildApiRouteTree(apiFiles, apiDir, base) : [];
  for (const route of apiRoutes) addOwner(route.filePath, `API route ${route.path}`);

  const collisions = detectPublicCollisions({ publicPaths, apiRoutePaths: apiRoutes.map((r) => r.path), target });
  if (collisions.length) throw new Error(collisions.join("\n"));

  // ── Generate the worker entry as a virtual graph ─────────────────────────
  // Inline scripts become real files in a staging directory so esbuild can
  // resolve their (already absolute) imports; `src=` scripts and API routes
  // are imported directly from their source paths. Nothing is eval'd.
  const lines: string[] = [];
  // The runtime entry lives beside this module: `.ts` when running from
  // source, `.js` from the compiled package.
  const here = fileURLToPath(import.meta.url);
  const runtimeEntry = resolve(here, `../../adapters/cloudflare-runtime${here.endsWith(".ts") ? ".ts" : ".js"}`);
  lines.push(`import { createCloudflareWorker } from ${JSON.stringify(runtimeEntry)};`);

  const pageLiterals: string[] = [];
  for (const [httpPath, page] of [...dynamicPages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const jobLiterals: string[] = [];
    for (const job of page.jobs) {
      let specifier: string;
      if (job.modulePath) {
        specifier = job.modulePath;
      } else {
        const file = join(stagingDir, `${ident(job.id)}.${hashOf(job.inlineSource!)}.mjs`);
        await writeFile(file, job.inlineSource!, "utf8");
        specifier = file;
        addOwner(file, job.owner);
      }
      jobLiterals.push(
        `${JSON.stringify(job.id)}: { id: ${JSON.stringify(job.id)}, mode: ${JSON.stringify(job.mode)}, load: () => import(${JSON.stringify(specifier)}) }`,
      );
    }
    pageLiterals.push(
      `${JSON.stringify(httpPath)}: { path: ${JSON.stringify(httpPath)}, is404: ${page.is404}, segments: ${JSON.stringify(page.segments)}, jobs: { ${jobLiterals.join(", ")} } }`,
    );
  }
  const routeLiterals = apiRoutes.map(
    (r) =>
      `{ path: ${JSON.stringify(r.path)}, filePath: ${JSON.stringify(relative(projectRoot, r.filePath).replace(/\\/g, "/"))}, paramNames: ${JSON.stringify(r.paramNames)}, isDynamic: ${r.isDynamic}, load: () => import(${JSON.stringify(r.filePath)}) }`,
  );
  const release = `${options.version}+${hashOf(JSON.stringify({ pages: [...dynamicPages.keys()], api: apiRoutes.map((r) => r.path), files: publicPaths }))}`;
  lines.push(`const graph = {`);
  lines.push(`  base: ${JSON.stringify(base)},`);
  lines.push(`  scriptTimeoutMs: ${BascikConfig.scripts.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS},`);
  lines.push(`  apiTimeoutMs: ${BascikConfig.http.apiTimeout ?? 10000},`);
  lines.push(`  onServerScriptError: ${JSON.stringify(BascikConfig.scripts.onServerScriptError ?? "error")},`);
  lines.push(`  release: ${JSON.stringify(release)},`);
  if (custom500 !== undefined) lines.push(`  custom500: ${JSON.stringify(custom500)},`);
  lines.push(`  pages: { ${pageLiterals.join(",\n    ")} },`);
  lines.push(`  apiRoutes: [ ${routeLiterals.join(",\n    ")} ],`);
  lines.push(`};`);
  lines.push(`export default createCloudflareWorker(graph);`);
  const entryPath = join(stagingDir, "worker-entry.mjs");
  await writeFile(entryPath, lines.join("\n"), "utf8");

  // ── Bundle ───────────────────────────────────────────────────────────────
  const esbuild = await loadProjectEsbuild(projectRoot);
  const unsupported: string[] = [];
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["workerd", "worker", "browser", "module", "main"],
    conditions: ["workerd", "worker", "browser", "import", "module", "default"],
    logLevel: "silent",
    metafile: true,
    absWorkingDir: projectRoot,
    plugins: [
      {
        name: "bascik-request-time-graph",
        setup(build: {
          onResolve: (
            o: { filter: RegExp },
            cb: (args: { path: string; importer: string; kind: string }) => unknown,
          ) => void;
        }) {
          // `@/` is rewritten inside inline script blocks before staging (the
          // same rewrite the Node runtime applies), so it never reaches the
          // bundler from there. Inside a `src=` module or a helper file it is
          // not an alias on Node either; name the rule instead of guessing.
          build.onResolve({ filter: /^@\// }, (args) => ({
            errors: [
              {
                text:
                  `"${args.path}" cannot be resolved from a module file. The @/ alias is available inside ` +
                  `<script> blocks only; in ${relative(projectRoot, args.importer).replace(/\\/g, "/")} use a relative import.`,
              },
            ],
          }));
          // Inline blocks were rewritten to absolute `file:` URLs (the form
          // Node imports at request time). esbuild does not resolve URLs, so
          // map them back to paths here and carry owner attribution along.
          build.onResolve({ filter: /^file:/ }, (args) => {
            const resolved = fileURLToPath(args.path);
            for (const owner of owners.get(args.importer) ?? []) addOwner(resolved, owner);
            return { path: resolved };
          });
          // Carry owner attribution down relative imports so an unsupported
          // builtin three files deep still names the page or route that
          // reached it.
          build.onResolve({ filter: /^\.\.?\// }, (args) => {
            const resolved = resolve(dirname(args.importer), args.path);
            for (const owner of owners.get(args.importer) ?? []) addOwner(resolved, owner);
            return undefined;
          });
          build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
            const kind = classifyNodeBuiltin(args.path);
            if (kind === "not-builtin") return undefined;
            if (kind === "provided") return { path: args.path.startsWith("node:") ? args.path : `node:${args.path}`, external: true };
            const ownerList = [...(owners.get(args.importer) ?? [])];
            unsupported.push(formatUnsupportedImport({ specifier: args.path, importer: args.importer, projectRoot, owners: ownerList }));
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  if (unsupported.length) throw new Error([...new Set(unsupported)].join("\n"));
  if (result.errors.length) {
    throw new Error(`[bascik] --target ${target}: bundling failed:\n${result.errors.map((e) => `  ${e.location?.file ? `${e.location.file}: ` : ""}${e.text}`).join("\n")}`);
  }
  const workerCode = result.outputFiles?.[0]?.text ?? "";
  await rm(stagingDir, { recursive: true, force: true });

  // ── Public tree ──────────────────────────────────────────────────────────
  for (const rel of publicPaths) {
    const from = join(distDir, rel);
    const to = join(publicDir, rel);
    if (!resolve(to).startsWith(publicDir + sep)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }

  const invocationRoutes = buildInvocationRoutes({
    base,
    dynamicPagePaths: [...dynamicPages.keys()],
    hasApiRoutes: apiRoutes.length > 0,
  });

  let workerPath: string;
  if (target === "cloudflare-pages") {
    workerPath = join(publicDir, "_worker.js");
    await writeFile(workerPath, workerCode, "utf8");
    await writeFile(
      join(publicDir, "_routes.json"),
      JSON.stringify({ version: 1, include: invocationRoutes.include, exclude: invocationRoutes.exclude }, null, 2),
      "utf8",
    );
  } else {
    workerPath = join(targetDir, "worker.js");
    await writeFile(workerPath, workerCode, "utf8");
    const wrangler = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: "bascik-site",
      main: "worker.js",
      compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
      compatibility_flags: [...CLOUDFLARE_COMPATIBILITY_FLAGS],
      assets: {
        directory: "./public",
        binding: "ASSETS",
        not_found_handling: "404-page",
        run_worker_first: invocationRoutes.include,
      },
    };
    await writeFile(join(targetDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`, "utf8");
  }

  const bundleBytes = Buffer.byteLength(workerCode, "utf8");
  const info = {
    target,
    release,
    bascikVersion: options.version,
    compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
    compatibilityFlags: [...CLOUDFLARE_COMPATIBILITY_FLAGS],
    bundleBytes,
    dynamicPages: [...dynamicPages.keys()].sort(),
    apiRoutes: apiRoutes.map((r) => r.path),
    publicFiles: publicPaths.length,
    invocationRoutes,
  };
  await writeFile(join(targetDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");

  return {
    target,
    outDir: targetDir,
    publicDir,
    workerPath,
    bundleBytes,
    dynamicPages: info.dynamicPages,
    apiRoutes: info.apiRoutes,
    invocationRoutes,
    release,
  };
};

/** Human summary printed after a target build. */
export const formatServerlessSummary = (result: ServerlessBuildResult, projectRoot = process.cwd()): string => {
  const rel = (p: string) => relative(projectRoot, p).replace(/\\/g, "/");
  const kb = (result.bundleBytes / 1024).toFixed(1);
  const lines = [
    `✓ ${result.target} bundle: ${rel(result.outDir)}/`,
    `  public tree: ${rel(result.publicDir)}/`,
    `  worker: ${rel(result.workerPath)} (${kb} kB, compatibility date ${CLOUDFLARE_COMPATIBILITY_DATE})`,
    `  dynamic pages: ${result.dynamicPages.length}, API routes: ${result.apiRoutes.length}`,
  ];
  if (result.invocationRoutes.overflowed) {
    lines.push(`  note: more than ${PAGES_ROUTES_LIMIT} invocation rules; every request invokes the worker (static requests are forwarded to assets).`);
  }
  return lines.join("\n");
};

