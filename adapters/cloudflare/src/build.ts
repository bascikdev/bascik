/**
 * @module build
 *
 * Cloudflare adapter build implementation.
 */

import {
  pageAliasesFor,
  type AdapterBuildContext,
  type AdapterBuildResult,
  type SiteGraphJob,
} from "@bascik/bascik/adapter";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_COMPATIBILITY_FLAGS,
  PAGES_ROUTES_LIMIT,
  classifyNodeBuiltin,
  formatUnsupportedImport,
} from "./compat.js";
import { resolveWorkerName } from "./config.js";
import { buildCspHeadersRules, countHeadersRules } from "./csp-headers.js";
import { build as esbuildBuild } from "esbuild";
import { manifestHasComponents } from "@bascik/bascik/runtime";

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
  /** A static 404.html exists; its URLs must reach the worker to answer 404. */
  hasStaticNotFoundPage?: boolean;
}): InvocationRoutes => {
  const include = new Set<string>();
  for (const path of input.dynamicPagePaths)
    for (const alias of pageAliasesFor(path, input.base)) include.add(alias);
  if (input.hasStaticNotFoundPage)
    for (const alias of pageAliasesFor("/404", input.base)) include.add(alias);
  if (input.hasApiRoutes) include.add(withBasePath("/api/*", input.base));
  include.add(withBasePath("/_routes.json", input.base));
  include.add(withBasePath("/_worker.js", input.base));
  const sorted = Array.from(include).sort();
  if (sorted.length > PAGES_ROUTES_LIMIT) {
    return {
      include: [withBasePath("/*", input.base)],
      exclude: [],
      overflowed: true,
    };
  }
  return { include: sorted, exclude: [], overflowed: false };
};

const CONTROL_FILES: Record<string, string[]> = {
  pages: ["_worker.js", "_routes.json"],
  workers: ["wrangler.jsonc", "worker.js"],
};
const ASSET_CONTROL_FILES = new Set(["_headers", "_redirects"]);

export const detectControlCollisions = (
  publicPaths: string[],
  variant: string,
): string[] => {
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

const NO_COMPONENTS = "bascik-no-components";

/**
 * component-host.ts's exports for a site without components: nothing to
 * render. Output scoping stays in runtime.ts, since page jobs carry a scope
 * without any renderable manifest.
 */
const COMPONENT_HOST_STUB = "export const componentExecution = () => null;";

export const build = async (
  context: AdapterBuildContext,
): Promise<AdapterBuildResult> => {
  const { graph, distDir, outDir, projectRoot, variant = "workers" } = context;
  if (variant !== "pages" && variant !== "workers") {
    throw new Error(
      `[bascik] --target cloudflare: unknown variant "${variant}". Valid variants are "pages" and "workers".`,
    );
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

  // A dynamic /404 page already answers 404 from the worker. A static one is
  // served by the asset layer, which answers 200 at its own URL.
  const hasStaticNotFoundPage =
    graph.publicFiles.includes("404.html") && graph.pages["/404"] === undefined;

  const here = fileURLToPath(import.meta.url);
  const runtimeFile = resolve(
    here,
    `../runtime${here.endsWith(".ts") ? ".ts" : ".js"}`,
  );

  const lines: string[] = [];
  lines.push(
    `import { createCloudflareWorker } from ${JSON.stringify(runtimeFile)};`,
  );

  const specifierOf = (job: SiteGraphJob): string =>
    job.source.kind === "module" ? job.source.path : job.source.stagedPath;
  // `outputScope` and `owner` are written only when given, so a site
  // without component scripts emits the entry it always did. The owner goes
  // with component jobs only: the Worker's log of a failing one names the
  // component file from it, since the bundled stack never does.
  const jobLiteral = (
    id: string,
    mode: SiteGraphJob["mode"],
    outputScope: string | undefined,
    specifier: string,
    owner?: string,
  ): string =>
    // codeql[js/bad-code-sanitization] Emits a standalone JS module (never inline HTML), and JSON.stringify yields valid JS string literals.
    `${JSON.stringify(id)}: { id: ${JSON.stringify(id)}, mode: ${JSON.stringify(mode)}, ${outputScope ? `outputScope: ${JSON.stringify(outputScope)}, ` : ""}${owner ? `owner: ${JSON.stringify(owner)}, ` : ""}load: () => import(${JSON.stringify(specifier)}) }`;

  // Request-time components (prompt 157): the manifest and the component
  // scripts it names, emitted only when the manifest has a component the
  // renderer can expand (the runtime's own predicate, so the bundle never
  // carries a renderer the Worker would never call). A static site, or one
  // whose components are all unsupported, keeps its entry byte for byte.
  // The scripts are owned by their component file, so an unsupported import
  // is reported there.
  const components = manifestHasComponents(graph.components?.manifest)
    ? graph.components
    : undefined;
  let manifestLiteral: string | undefined;
  if (components) {
    const manifestScopes = new Map<string, string | undefined>();
    for (const entry of Object.values(components.manifest.components))
      for (const job of entry.jobs) manifestScopes.set(job.id, job.outputScope);
    const componentJobLiterals: string[] = [];
    for (const [id, job] of Object.entries(components.jobs)) {
      const specifier = specifierOf(job);
      addOwner(specifier, job.owner);
      componentJobLiterals.push(
        jobLiteral(
          id,
          job.mode,
          job.outputScope ?? manifestScopes.get(id),
          specifier,
          job.owner,
        ),
      );
    }
    manifestLiteral = JSON.stringify(components.manifest);
    lines.push(`const componentManifest = ${manifestLiteral};`);
    lines.push(
      `const componentJobs = { ${componentJobLiterals.join(",\n  ")} };`,
    );
  }

  const pageLiterals: string[] = [];
  for (const [httpPath, page] of Object.entries(graph.pages).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const jobLiterals: string[] = [];
    for (const [id, job] of Object.entries(page.jobs)) {
      const specifier = specifierOf(job);
      addOwner(specifier, job.owner);
      jobLiterals.push(jobLiteral(id, job.mode, job.outputScope, specifier));
    }
    pageLiterals.push(
      `${JSON.stringify(httpPath)}: { path: ${JSON.stringify(httpPath)}, is404: ${page.is404}, segments: ${JSON.stringify(page.segments)}, jobs: { ${jobLiterals.join(", ")} } }`,
    );
  }

  const routeLiterals = graph.apiRoutes.map((r) => {
    addOwner(r.filePath, `API route ${r.path}`);
    // codeql[js/bad-code-sanitization] Emits a standalone JS module (never inline HTML), and JSON.stringify yields valid JS string literals.
    return `{ path: ${JSON.stringify(r.path)}, filePath: ${JSON.stringify(relative(projectRoot, r.filePath).replace(/\\/g, "/"))}, paramNames: ${JSON.stringify(r.paramNames)}, isDynamic: ${r.isDynamic}, load: () => import(${JSON.stringify(r.filePath)}) }`;
  });

  lines.push(`const graph = {`);
  lines.push(`  base: ${JSON.stringify(graph.base)},`);
  lines.push(`  scriptTimeoutMs: ${graph.scriptTimeoutMs},`);
  lines.push(`  apiTimeoutMs: ${graph.apiTimeoutMs},`);
  lines.push(
    `  onServerScriptError: ${JSON.stringify(graph.onServerScriptError)},`,
  );
  lines.push(`  release: ${JSON.stringify(graph.release)},`);
  if (graph.custom500 !== undefined)
    lines.push(`  custom500: ${JSON.stringify(graph.custom500)},`);
  if (hasStaticNotFoundPage) lines.push(`  staticNotFoundPage: true,`);
  lines.push(`  pages: { ${pageLiterals.join(",\n    ")} },`);
  lines.push(`  apiRoutes: [ ${routeLiterals.join(",\n    ")} ],`);
  if (components)
    lines.push(
      `  components: { manifest: componentManifest, jobs: componentJobs },`,
    );
  // Opt-in contentSecurityPolicy: the policy and the hashes of the pages
  // the Worker renders (static pages get _headers rules below).
  const csp = graph.contentSecurityPolicy;
  if (csp) {
    const workerHashes: Record<string, unknown> = {};
    for (const path of Object.keys(graph.pages))
      if (csp.hashes[path]) workerHashes[path] = csp.hashes[path];
    lines.push(
      `  contentSecurityPolicy: { policy: ${JSON.stringify(csp.policy)}, hashes: ${JSON.stringify(workerHashes)} },`,
    );
  }
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
          // A site whose manifest has nothing to render never renders a
          // component, so its Worker gets a stub in place of the component
          // host (prompt 157): no renderer and no `node:crypto` in its
          // bundle. (Not byte for byte the bundle before prompt 157:
          // runtime.ts itself changed.)
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
          buildInstance.onResolve({ filter: /^file:/ }, (args) => {
            const resolved = fileURLToPath(args.path);
            for (const owner of owners.get(args.importer) ?? [])
              addOwner(resolved, owner);
            return { path: resolved };
          });
          buildInstance.onResolve({ filter: /^\.\.?\// }, (args) => {
            const resolved = resolve(dirname(args.importer), args.path);
            for (const owner of owners.get(args.importer) ?? [])
              addOwner(resolved, owner);
            return undefined;
          });
          buildInstance.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
            const kind = classifyNodeBuiltin(args.path);
            if (kind === "not-builtin") return undefined;
            if (kind === "provided")
              return {
                path: args.path.startsWith("node:")
                  ? args.path
                  : `node:${args.path}`,
                external: true,
              };
            const ownerList = [...(owners.get(args.importer) ?? [])];
            unsupported.push(
              formatUnsupportedImport({
                specifier: args.path,
                importer: args.importer,
                projectRoot,
                owners: ownerList,
              }),
            );
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });

  if (unsupported.length) throw new Error([...new Set(unsupported)].join("\n"));
  if (result.errors.length) {
    throw new Error(
      `[bascik] --target cloudflare-${variant}: bundling failed:\n${result.errors.map((e) => `  ${e.location?.file ? `${e.location.file}: ` : ""}${e.text}`).join("\n")}`,
    );
  }
  const workerCode = result.outputFiles?.[0]?.text ?? "";

  // Copy public files. The asset layer maps a request URL straight to a file
  // under public/, and every URL of a non-root base site carries the prefix,
  // so assets are staged below it. Control files stay at the public root,
  // where the platform reads them.
  const assetRoot =
    graph.base && graph.base !== "/"
      ? join(publicDir, ...graph.base.split("/").filter(Boolean))
      : publicDir;
  for (const rel of graph.publicFiles) {
    const from = join(distDir, rel);
    const to = join(ASSET_CONTROL_FILES.has(rel) ? publicDir : assetRoot, rel);
    if (!resolve(to).startsWith(publicDir + sep)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }

  // Static pages are served without the Worker: their CSP header goes into
  // public/_headers, after the author's own rules.
  if (csp) {
    const headersPath = join(publicDir, "_headers");
    let authored = "";
    try {
      authored = await readFile(headersPath, "utf8");
    } catch {
      authored = "";
    }
    const rules = buildCspHeadersRules({
      policy: csp.policy,
      hashes: csp.hashes,
      staticRoutes: csp.staticRoutes,
      base: graph.base,
      authoredRules: countHeadersRules(authored),
    });
    await writeFile(
      headersPath,
      authored === "" ? rules : `${authored.replace(/\s*$/, "")}\n\n${rules}`,
      "utf8",
    );
  }

  const invocationRoutes = buildInvocationRoutes({
    base: graph.base,
    dynamicPagePaths: Object.keys(graph.pages),
    hasApiRoutes: graph.apiRoutes.length > 0,
    hasStaticNotFoundPage,
  });

  let workerPath: string;
  if (variant === "pages") {
    workerPath = join(publicDir, "_worker.js");
    await writeFile(workerPath, workerCode, "utf8");
    await writeFile(
      join(publicDir, "_routes.json"),
      JSON.stringify(
        {
          version: 1,
          include: invocationRoutes.include,
          exclude: invocationRoutes.exclude,
        },
        null,
        2,
      ),
      "utf8",
    );
  } else {
    workerPath = join(outDir, "worker.js");
    await writeFile(workerPath, workerCode, "utf8");

    // Discover authored user config and resolve worker name in priority order:
    // 1. Environment variables (CLOUDFLARE_WORKER_NAME, WORKER_NAME, CF_PAGES_PROJECT_NAME)
    // 2. Authored wrangler.jsonc / wrangler.json / wrangler.toml in project root
    // 3. Project package.json "name"
    // 4. Fallback to "bascik-site"
    const { workerName, discoveredConfig } =
      await resolveWorkerName(projectRoot);

    const authoredFlags = Array.isArray(
      discoveredConfig?.values?.compatibility_flags,
    )
      ? discoveredConfig.values.compatibility_flags.filter(
          (f): f is string => typeof f === "string" && f.trim().length > 0,
        )
      : [];

    const wrangler = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: workerName,
      main: "worker.js",
      compatibility_date:
        (discoveredConfig?.values?.compatibility_date as string | undefined) ??
        CLOUDFLARE_COMPATIBILITY_DATE,
      compatibility_flags: [
        ...new Set([...authoredFlags, ...CLOUDFLARE_COMPATIBILITY_FLAGS]),
      ],
      assets: {
        directory: "./public",
        binding: "ASSETS",
        not_found_handling: "404-page",
        run_worker_first: invocationRoutes.include,
      },
    };
    await writeFile(
      join(outDir, "wrangler.jsonc"),
      `${JSON.stringify(wrangler, null, 2)}\n`,
      "utf8",
    );
  }

  const bundleBytes = Buffer.byteLength(workerCode, "utf8");
  const notes = [
    `compatibility date: ${CLOUDFLARE_COMPATIBILITY_DATE}`,
    `compatibility flags: ${CLOUDFLARE_COMPATIBILITY_FLAGS.join(", ")}`,
    `invocation routes: ${invocationRoutes.include.length} rules`,
  ];
  // The manifest is part of the bundle; its share of bundleBytes is shown so
  // a growing component library is visible against the Worker size limit.
  if (components && manifestLiteral !== undefined) {
    const count = Object.keys(components.manifest.components).length;
    notes.push(
      `component manifest: ${Buffer.byteLength(manifestLiteral, "utf8")} bytes (${count} ${count === 1 ? "component" : "components"})`,
    );
  }
  return {
    workerPath,
    publicDir,
    bundleBytes,
    notes,
    // The runtime renders component tags in script output (prompt 157).
    components: true,
  };
};
