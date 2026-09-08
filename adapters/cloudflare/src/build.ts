/**
 * @module build
 *
 * Cloudflare adapter build implementation.
 */

import { pageAliasesFor, type AdapterBuildContext, type AdapterBuildResult } from "@bascik/bascik/adapter";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_COMPATIBILITY_FLAGS,
  PAGES_ROUTES_LIMIT,
  classifyNodeBuiltin,
  formatUnsupportedImport,
} from "./compat.js";
import { build as esbuildBuild } from "esbuild";

export { pageAliasesFor };

export interface InvocationRoutes {
  include: string[];
  exclude: string[];
  overflowed: boolean;
}

const withBasePath = (path: string, base: string): string => {
  if (base === "/" || !base) return path;
  const cleanBase = base.replace(/\/$/, "");
  return path.startsWith("/") ? `${cleanBase}${path}` : `${cleanBase}/${path}`;
};

export const buildInvocationRoutes = (input: {
  base: string;
  dynamicPagePaths: string[];
  hasApiRoutes: boolean;
}): InvocationRoutes => {
  const include = new Set<string>();
  for (const path of input.dynamicPagePaths) for (const alias of pageAliasesFor(path, input.base)) include.add(alias);
  if (input.hasApiRoutes) include.add(withBasePath("/api/*", input.base));
  include.add(withBasePath("/_routes.json", input.base));
  include.add(withBasePath("/_worker.js", input.base));
  const sorted = Array.from(include).sort();
  if (sorted.length > PAGES_ROUTES_LIMIT) {
    return { include: [withBasePath("/*", input.base)], exclude: [], overflowed: true };
  }
  return { include: sorted, exclude: [], overflowed: false };
};

const CONTROL_FILES: Record<string, string[]> = {
  pages: ["_worker.js", "_routes.json"],
  workers: ["wrangler.jsonc", "worker.js"],
};

export const detectControlCollisions = (publicPaths: string[], variant: string): string[] => {
  const control = new Set(CONTROL_FILES[variant] ?? []);
  const problems: string[] = [];
  for (const path of [...publicPaths].sort()) {
    if (control.has(path)) {
      problems.push(
        `[bascik] --target cloudflare-${variant}: authored file "${path}" collides with a generated control file. Rename it or remove it from directory.pages.`,
      );
    }
  }
  return problems;
};

export const build = async (context: AdapterBuildContext): Promise<AdapterBuildResult> => {
  const { graph, distDir, outDir, projectRoot, variant = "pages" } = context;
  if (variant !== "pages" && variant !== "workers") {
    throw new Error(`[bascik] --target cloudflare: unknown variant "${variant}". Valid variants are "pages" and "workers".`);
  }

  const publicDir = join(outDir, "public");
  await mkdir(publicDir, { recursive: true });

  const collisions = detectControlCollisions(graph.publicFiles, variant);
  if (collisions.length) throw new Error(collisions.join("\n"));

  const owners = new Map<string, Set<string>>();
  const addOwner = (file: string, owner: string) => {
    let set = owners.get(file);
    if (!set) {
      set = new Set();
      owners.set(file, set);
    }
    set.add(owner);
  };

  const here = fileURLToPath(import.meta.url);
  const runtimeFile = resolve(here, `../runtime${here.endsWith(".ts") ? ".ts" : ".js"}`);

  const lines: string[] = [];
  lines.push(`import { createCloudflareWorker } from ${JSON.stringify(runtimeFile)};`);

  const pageLiterals: string[] = [];
  for (const [httpPath, page] of Object.entries(graph.pages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const jobLiterals: string[] = [];
    for (const [id, job] of Object.entries(page.jobs)) {
      let specifier: string;
      if (job.source.kind === "module") {
        specifier = job.source.path;
      } else {
        specifier = job.source.stagedPath;
      }
      addOwner(specifier, job.owner);
      jobLiterals.push(
        `${JSON.stringify(id)}: { id: ${JSON.stringify(id)}, mode: ${JSON.stringify(job.mode)}, load: () => import(${JSON.stringify(specifier)}) }`,
      );
    }
    pageLiterals.push(
      `${JSON.stringify(httpPath)}: { path: ${JSON.stringify(httpPath)}, is404: ${page.is404}, segments: ${JSON.stringify(page.segments)}, jobs: { ${jobLiterals.join(", ")} } }`,
    );
  }

  const routeLiterals = graph.apiRoutes.map((r) => {
    addOwner(r.filePath, `API route ${r.path}`);
    return `{ path: ${JSON.stringify(r.path)}, filePath: ${JSON.stringify(relative(projectRoot, r.filePath).replace(/\\/g, "/"))}, paramNames: ${JSON.stringify(r.paramNames)}, isDynamic: ${r.isDynamic}, load: () => import(${JSON.stringify(r.filePath)}) }`;
  });

  lines.push(`const graph = {`);
  lines.push(`  base: ${JSON.stringify(graph.base)},`);
  lines.push(`  scriptTimeoutMs: ${graph.scriptTimeoutMs},`);
  lines.push(`  apiTimeoutMs: ${graph.apiTimeoutMs},`);
  lines.push(`  onServerScriptError: ${JSON.stringify(graph.onServerScriptError)},`);
  lines.push(`  release: ${JSON.stringify(graph.release)},`);
  if (graph.custom500 !== undefined) lines.push(`  custom500: ${JSON.stringify(graph.custom500)},`);
  lines.push(`  pages: { ${pageLiterals.join(",\n    ")} },`);
  lines.push(`  apiRoutes: [ ${routeLiterals.join(",\n    ")} ],`);
  lines.push(`};`);
  lines.push(`export default createCloudflareWorker(graph);`);

  const stagingDir = join(outDir, ".staging");
  await mkdir(stagingDir, { recursive: true });
  const entryPath = join(stagingDir, "worker-entry.mjs");
  await writeFile(entryPath, lines.join("\n"), "utf8");

  // Bundle with esbuild owned by this adapter
  const unsupported: string[] = [];
  const result = await esbuildBuild({
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
        setup(buildInstance) {
          buildInstance.onResolve({ filter: /^@\// }, (args) => ({
            errors: [
              {
                text:
                  `"${args.path}" cannot be resolved from a module file. The @/ alias is available inside ` +
                  `<script> blocks only; in ${relative(projectRoot, args.importer).replace(/\\/g, "/")} use a relative import.`,
              },
            ],
          }));
          buildInstance.onResolve({ filter: /^file:/ }, (args) => {
            const resolved = fileURLToPath(args.path);
            for (const owner of owners.get(args.importer) ?? []) addOwner(resolved, owner);
            return { path: resolved };
          });
          buildInstance.onResolve({ filter: /^\.\.?\// }, (args) => {
            const resolved = resolve(dirname(args.importer), args.path);
            for (const owner of owners.get(args.importer) ?? []) addOwner(resolved, owner);
            return undefined;
          });
          buildInstance.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
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
    throw new Error(`[bascik] --target cloudflare-${variant}: bundling failed:\n${result.errors.map((e) => `  ${e.location?.file ? `${e.location.file}: ` : ""}${e.text}`).join("\n")}`);
  }
  const workerCode = result.outputFiles?.[0]?.text ?? "";

  // Copy public files
  for (const rel of graph.publicFiles) {
    const from = join(distDir, rel);
    const to = join(publicDir, rel);
    if (!resolve(to).startsWith(publicDir + sep)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }

  const invocationRoutes = buildInvocationRoutes({
    base: graph.base,
    dynamicPagePaths: Object.keys(graph.pages),
    hasApiRoutes: graph.apiRoutes.length > 0,
  });

  let workerPath: string;
  if (variant === "pages") {
    workerPath = join(publicDir, "_worker.js");
    await writeFile(workerPath, workerCode, "utf8");
    await writeFile(
      join(publicDir, "_routes.json"),
      JSON.stringify({ version: 1, include: invocationRoutes.include, exclude: invocationRoutes.exclude }, null, 2),
      "utf8",
    );
  } else {
    workerPath = join(outDir, "worker.js");
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
    await writeFile(join(outDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`, "utf8");
  }

  const bundleBytes = Buffer.byteLength(workerCode, "utf8");
  return {
    workerPath,
    publicDir,
    bundleBytes,
    notes: [
      `compatibility date: ${CLOUDFLARE_COMPATIBILITY_DATE}`,
      `compatibility flags: ${CLOUDFLARE_COMPATIBILITY_FLAGS.join(", ")}`,
      `invocation routes: ${invocationRoutes.include.length} rules`,
    ],
  };
};
