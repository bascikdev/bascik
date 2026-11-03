/**
 * @module build
 *
 * Bascik only accepts adapter output inside the target's own folder
 * (`dist/.bascik/<target>/`), so the adapter writes there:
 *
 *   publish/                    static pages and assets
 *   functions/bascik-pages.mjs  one Netlify Function (v2) for the dynamic
 *                               pages and the API routes
 *
 * `bascik-netlify-install` (./cli.ts) then copies them to `publish/`
 * (netlify.toml's publish directory) and `.netlify/v1/functions/`, where
 * Netlify's Frameworks API picks the function up.
 */

import {
  pageAliasesFor,
  type AdapterBuildContext,
  type AdapterBuildResult,
  type SiteGraph,
  type SiteGraphJob,
} from "@bascik/bascik/adapter";
import { manifestHasComponents } from "@bascik/bascik/runtime";
import { json } from "@bascik/bascik/html";
import { build as esbuild, type Message, type Plugin } from "esbuild";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FUNCTION_DIR, FUNCTION_FILE, PUBLISH_DIR } from "./paths.js";
import { buildHeadersFile } from "./headers-file.js";

const here = fileURLToPath(import.meta.url);
const runtimeFile = resolve(
  here,
  `../runtime${here.endsWith(".ts") ? ".ts" : ".js"}`,
);

const NO_COMPONENTS = "bascik-no-components";
/** component-host.ts's export for a site with nothing to render. */
const COMPONENT_HOST_STUB = "export const componentExecution = () => null;";

/** Staged server-script modules import project files by file:// URL; esbuild needs paths. */
export const fileUrlPlugin: Plugin = {
  name: "file-url",
  setup(build) {
    build.onResolve({ filter: /^file:\/\// }, (args) => ({
      path: fileURLToPath(args.path),
    }));
  },
};

/** Characters URLPattern treats as syntax in a path; a literal one is escaped. */
const URL_PATTERN_SYNTAX = /[:*?+(){}\\]/g;

/**
 * An API route as a Netlify `config.path` pattern (URLPattern syntax):
 * `[id]` is `:id`, a final `[...rest]` (one or more segments) is `*`, and any
 * other character URLPattern reads as syntax is escaped.
 */
export function apiRoutePattern(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return "*";
      const param = /^\[([^\]]+)\]$/.exec(segment);
      if (param) return `:${param[1]!.replace(/[^A-Za-z0-9_]/g, "_")}`;
      return segment.replace(URL_PATTERN_SYNTAX, (c) => `\\${c}`);
    })
    .join("/");
}

/** Every URL path the function answers: each dynamic page alias, then each API route. */
export function functionPaths(
  graph: Pick<SiteGraph, "pages" | "base"> &
    Partial<Pick<SiteGraph, "apiRoutes">>,
): string[] {
  const paths = new Set<string>();
  for (const path of Object.keys(graph.pages)) {
    for (const alias of pageAliasesFor(path, graph.base))
      paths.add(alias.replace(URL_PATTERN_SYNTAX, (c) => `\\${c}`));
  }
  const pages = [...paths].sort();
  const api = [
    ...new Set((graph.apiRoutes ?? []).map((r) => apiRoutePattern(r.path))),
  ];
  return [...pages, ...api];
}

const specifierOf = (job: SiteGraphJob): string =>
  job.source.kind === "module" ? job.source.path : job.source.stagedPath;

const jobLiteral = (
  id: string,
  job: SiteGraphJob,
  outputScope: string | undefined,
  owner?: string,
): string =>
  `${JSON.stringify(id)}: { id: ${JSON.stringify(id)}, mode: ${JSON.stringify(job.mode)}, ${outputScope ? `outputScope: ${JSON.stringify(outputScope)}, ` : ""}${owner ? `owner: ${JSON.stringify(owner)}, ` : ""}load: () => import(${String(json(specifierOf(job)))}) }`;

/** Whether the graph has a component the request-time renderer can expand. */
const renderableComponents = (graph: Pick<SiteGraph, "components">) =>
  manifestHasComponents(graph.components?.manifest)
    ? graph.components
    : undefined;

/** The generated entry module: the site graph with lazy job loaders. */
export function entrySource(
  graph: SiteGraph,
  paths: string[],
  projectRoot = process.cwd(),
): string {
  const lines: string[] = [];
  lines.push(
    `import { createNetlifyHandler } from ${JSON.stringify(runtimeFile)};`,
  );

  const components = renderableComponents(graph);
  if (components) {
    const manifestScopes = new Map<string, string | undefined>();
    for (const entry of Object.values(components.manifest.components))
      for (const job of entry.jobs) manifestScopes.set(job.id, job.outputScope);
    const componentJobs = Object.entries(components.jobs).map(([id, job]) =>
      jobLiteral(id, job, job.outputScope ?? manifestScopes.get(id), job.owner),
    );
    lines.push(
      `const componentManifest = ${JSON.stringify(components.manifest)};`,
    );
    lines.push(`const componentJobs = { ${componentJobs.join(",\n  ")} };`);
  }

  const pageLiterals = Object.entries(graph.pages)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([httpPath, page]) => {
      const jobs = Object.entries(page.jobs).map(([id, job]) =>
        jobLiteral(id, job, job.outputScope),
      );
      return `${JSON.stringify(httpPath)}: { path: ${JSON.stringify(httpPath)}, is404: ${page.is404}, segments: ${JSON.stringify(page.segments)}, jobs: { ${jobs.join(", ")} } }`;
    });
  const routeLiterals = (graph.apiRoutes ?? []).map(
    (r) =>
      `{ path: ${JSON.stringify(r.path)}, filePath: ${JSON.stringify(relative(projectRoot, r.filePath).replace(/\\/g, "/"))}, paramNames: ${JSON.stringify(r.paramNames)}, isDynamic: ${r.isDynamic}, load: () => import(${String(json(r.filePath))}) }`,
  );

  lines.push("const graph = {");
  lines.push(`  base: ${JSON.stringify(graph.base ?? "/")},`);
  lines.push(`  scriptTimeoutMs: ${graph.scriptTimeoutMs},`);
  if (graph.apiTimeoutMs !== undefined)
    lines.push(`  apiTimeoutMs: ${graph.apiTimeoutMs},`);
  lines.push(
    `  onServerScriptError: ${JSON.stringify(graph.onServerScriptError)},`,
  );
  if (graph.custom500 !== undefined)
    lines.push(`  custom500: ${JSON.stringify(graph.custom500)},`);
  lines.push(`  pages: { ${pageLiterals.join(",\n    ")} },`);
  lines.push(`  apiRoutes: [ ${routeLiterals.join(",\n    ")} ],`);
  if (components)
    lines.push(
      "  components: { manifest: componentManifest, jobs: componentJobs },",
    );
  const csp = graph.contentSecurityPolicy;
  if (csp) {
    // The function sends the policy for the pages it renders; static pages
    // carry theirs in the _headers file.
    const hashes: Record<string, unknown> = {};
    for (const path of Object.keys(graph.pages))
      if (csp.hashes[path]) hashes[path] = csp.hashes[path];
    lines.push(
      `  contentSecurityPolicy: { policy: ${JSON.stringify(csp.policy)}, hashes: ${JSON.stringify(hashes)} },`,
    );
  }
  if (graph.responseSecurity !== undefined)
    lines.push(
      `  responseSecurity: ${JSON.stringify(graph.responseSecurity)},`,
    );
  if (graph.hideDotfiles !== undefined)
    lines.push(
      `  hideDotfiles: ${graph.hideDotfiles === false ? "false" : "true"},`,
    );
  if (graph.stripAnsi !== undefined)
    lines.push(`  stripAnsi: ${graph.stripAnsi === false ? "false" : "true"},`);
  if (graph.renderLimits !== undefined)
    lines.push(`  renderLimits: ${JSON.stringify(graph.renderLimits)},`);
  lines.push("};");
  lines.push(
    'console.info(JSON.stringify({ fn: "bascik-pages", event: "module.loaded", deployId: process.env.DEPLOY_ID ?? null }));',
  );
  lines.push("export default createNetlifyHandler(graph);");
  lines.push(
    `export const config = { path: ${JSON.stringify(paths)}, preferStatic: false };`,
  );
  return lines.join("\n");
}

/** Writes `publish/` and `functions/bascik-pages.mjs` into the target folder. */
export async function build(
  context: AdapterBuildContext,
): Promise<AdapterBuildResult> {
  const { graph, distDir, outDir, projectRoot, log } = context;

  // Static files: Bascik's private .bascik folder is never published.
  const publishDir = join(outDir, PUBLISH_DIR);
  await mkdir(publishDir, { recursive: true });
  for (const rel of graph.publicFiles) {
    if (rel.split("/")[0]?.toLowerCase() === ".bascik") continue;
    const to = join(publishDir, rel);
    if (!resolve(to).startsWith(publishDir + sep)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(distDir, rel), to);
  }

  // Security headers (and opt-in CSP) for static files, which the CDN serves
  // without the function. An authored _headers file keeps its rules first.
  const headers = await buildHeadersFile(graph, publishDir);
  for (const warning of headers.warnings) log(warning);

  const functionDir = join(outDir, FUNCTION_DIR);
  const functionPath = join(functionDir, FUNCTION_FILE);
  const paths = functionPaths(graph);
  if (paths.length === 0) {
    return {
      publicDir: publishDir,
      notes: ["no dynamic pages or API routes: no function written"],
    };
  }

  const components = renderableComponents(graph);
  // Errors in a bundled module name the authored file that reached it.
  const owners = new Map<string, string>();
  const addOwner = (file: string, owner: string) => {
    owners.set(file, owner);
    try {
      owners.set(realpathSync(file), owner);
    } catch {
      // Not on disk: only the spelling the graph gave is known.
    }
  };
  for (const page of Object.values(graph.pages))
    for (const job of Object.values(page.jobs))
      addOwner(specifierOf(job), job.owner);
  for (const job of Object.values(components?.jobs ?? {}))
    addOwner(specifierOf(job), job.owner);
  for (const route of graph.apiRoutes)
    addOwner(route.filePath, `API route ${route.path}`);

  const stagingDir = join(outDir, ".staging");
  await mkdir(stagingDir, { recursive: true });
  const entryPath = join(stagingDir, "netlify-entry.mjs");
  await writeFile(entryPath, entrySource(graph, paths, projectRoot), "utf8");

  const bundlingFailed = (errors: Message[]): Error =>
    new Error(
      `[bascik] --target netlify: bundling failed:\n${errors
        .map((e) => {
          const at = e.location
            ? `${e.location.file}:${e.location.line}:${e.location.column}: `
            : "";
          const owner = e.location
            ? owners.get(resolve(projectRoot, e.location.file))
            : undefined;
          return `  ${at}${e.text}${owner ? `\n    Reached from: ${owner}` : ""}`;
        })
        .join("\n")}`,
    );

  let code: string;
  try {
    const result = await esbuild({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node20",
      absWorkingDir: projectRoot,
      logLevel: "silent",
      plugins: [
        fileUrlPlugin,
        {
          name: "bascik-request-time-graph",
          setup(buildInstance) {
            // Nothing to render: the component host (and its renderer) stays out.
            if (!components) {
              buildInstance.onResolve(
                { filter: /^\.\/component-host\.js$/ },
                (args) =>
                  args.importer === runtimeFile
                    ? { path: "component-host", namespace: NO_COMPONENTS }
                    : undefined,
              );
              buildInstance.onLoad(
                { filter: /.*/, namespace: NO_COMPONENTS },
                () => ({ contents: COMPONENT_HOST_STUB, loader: "js" }),
              );
            }
            buildInstance.onResolve({ filter: /^@\// }, (args) => ({
              errors: [
                {
                  text:
                    `"${args.path}" cannot be resolved from a module file. The @/ alias is available inside ` +
                    `<script> blocks only; in ${relative(projectRoot, args.importer).replace(/\\/g, "/")} use a relative import.`,
                },
              ],
            }));
          },
        },
      ],
      // CommonJS dependencies (Stripe's SDK, for one) call require() inside an ES module bundle.
      banner: {
        js: "import { createRequire as __bascikCreateRequire } from 'node:module'; const require = __bascikCreateRequire(import.meta.url);",
      },
    });
    code = result.outputFiles[0]?.text ?? "";
  } catch (err) {
    const errors = (err as { errors?: Message[] }).errors;
    if (errors?.length) throw bundlingFailed(errors);
    throw err;
  }
  await mkdir(functionDir, { recursive: true });
  await writeFile(functionPath, code, "utf8");
  log(
    `[netlify adapter] function ${FUNCTION_FILE} answers ${paths.join(", ")}`,
  );

  const notes = [`function paths: ${paths.join(", ")}`];
  if (components) {
    const count = Object.keys(components.manifest.components).length;
    notes.push(
      `component manifest: ${count} ${count === 1 ? "component" : "components"}`,
    );
  }
  return {
    workerPath: functionPath,
    publicDir: publishDir,
    bundleBytes: Buffer.byteLength(code, "utf8"),
    notes,
    components: true,
  };
}
