/**
 * @module site-graph
 *
 * Host-neutral representation of the built site graph (prompt 142).
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { BascikConfig } from "./config.ts";
import { getHttpPath } from "./paths.ts";
import { getImportRoot } from "./import-root.ts";
import {
  rewriteModuleSpecifiers,
  resolveScriptSrcPath,
} from "./module-specifiers.ts";
import { scanApiRouteFiles, buildApiRouteTree } from "./api-routes.ts";
import {
  isPublicAssetPath,
  splitDistPageIntoSegments,
} from "./site-graph-paths.ts";
import {
  SIDECAR_SCHEMA_VERSION,
  sidecarHasPageEntries,
  type ServerScriptEntry,
  type ServerScriptsSidecar,
} from "./server-sidecar.ts";
import {
  readComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import { DEFAULT_SCRIPT_TIMEOUT_MS } from "./server-scripts.ts";
import { resolveResponseSecurity } from "./web-response.ts";
import { REQUEST_RENDER_LIMITS } from "./request-render.ts";
import type { RenderLimitsOptions, SecurityOptions } from "./types.ts";
import { createHash } from "node:crypto";
import type {
  ContentSecurityPolicyConfig,
  CspRouteHashes,
} from "./content-security-policy.ts";
import type {
  SiteGraph,
  SiteGraphComponents,
  SiteGraphContentSecurityPolicy,
  SiteGraphPage,
  SiteGraphJob,
  SiteGraphApiRoute,
  DistPageSegment,
} from "./adapter-contract.ts";
import { privateDirFor } from "./private-dir.ts";
import { compileDirectiveTypeScript } from "./typescript.ts";

export type { DistPageSegment };

export {
  splitDistPageIntoSegments,
  pageAliasesFor,
  isPublicAssetPath,
  detectPublicCollisions,
} from "./site-graph-paths.ts";

const readDistFiles = async (dir: string, base = ""): Promise<string[]> => {
  const entries = await readdir(join(dir, base), { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await readDistFiles(dir, rel)));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
};

export interface ReadSiteGraphOptions {
  projectRoot: string;
  distDir: string;
  version: string;
  base?: string;
  scriptTimeoutMs?: number;
  apiTimeoutMs?: number;
  onServerScriptError?: "error" | "warn" | "ignore";
  pagesDir?: string;
  apiDir?: string;
  contentSecurityPolicy?: ContentSecurityPolicyConfig;
  /** The build's `security` config (default: `BascikConfig.security`). */
  security?: Partial<SecurityOptions>;
  /** `scripts.stripAnsi` (default: `BascikConfig.scripts.stripAnsi`). */
  stripAnsi?: boolean;
  /** `scripts.renderLimits` (default: `BascikConfig.scripts.renderLimits`). */
  renderLimits?: Partial<RenderLimitsOptions>;
}

export const readSiteGraph = async (
  options: ReadSiteGraphOptions,
): Promise<SiteGraph> => {
  const { projectRoot, distDir, version } = options;
  const base = options.base ?? BascikConfig?.base ?? "/";
  const pagesDir =
    options.pagesDir ?? BascikConfig?.directory?.pages ?? "src/pages";
  const scriptTimeoutMs =
    options.scriptTimeoutMs ??
    BascikConfig?.scripts?.timeout ??
    DEFAULT_SCRIPT_TIMEOUT_MS;
  const apiTimeoutMs =
    options.apiTimeoutMs ?? BascikConfig?.http?.apiTimeout ?? 10000;
  const onServerScriptError =
    options.onServerScriptError ??
    BascikConfig?.scripts?.onServerScriptError ??
    "error";
  const importRoot = getImportRoot();
  // The build's security and render settings, for a host that has no
  // config of its own (the Worker): resolved here, so every host sends the
  // same headers and applies the same limits.
  const security = options.security ?? BascikConfig?.security;
  const responseSecurity = resolveResponseSecurity(security);
  const hideDotfiles = security?.hideDotfiles !== false;
  const stripAnsi =
    (options.stripAnsi ?? BascikConfig?.scripts?.stripAnsi) !== false;
  const renderLimits: RenderLimitsOptions = {
    ...REQUEST_RENDER_LIMITS,
    ...definedFields(BascikConfig?.scripts?.renderLimits),
    ...definedFields(options.renderLimits),
  };

  // Read server sidecar
  const sidecarPath = join(privateDirFor(distDir), "server-scripts.json");
  let sidecar: ServerScriptsSidecar | undefined;
  try {
    const raw = await readFile(sidecarPath, "utf8");
    sidecar = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (
    sidecar &&
    sidecar.schema !== undefined &&
    sidecar.schema !== SIDECAR_SCHEMA_VERSION
  ) {
    throw new Error(
      `[bascik] --target: sidecar schema ${sidecar.schema} is not understood (expected ${SIDECAR_SCHEMA_VERSION}). Run \`bascik --build\` again.`,
    );
  }
  const sidecarScripts: Record<string, ServerScriptEntry> =
    sidecar?.scripts ?? {};
  // An inline script marked type="text/typescript" is compiled here, as the
  // Node host compiles it before running it, so every host stages and
  // bundles JavaScript. A `.ts` src module is left to the bundler, which
  // reads TypeScript by its extension.
  const compiledSources = new Map<string, string>();
  for (const [id, entry] of Object.entries(sidecarScripts)) {
    if (!entry.typescript || entry.modulePath) continue;
    const sourceFile = entry.sourceFile
      ? relative(projectRoot, resolve(projectRoot, entry.sourceFile)).replace(
          /\\/g,
          "/",
        )
      : id;
    compiledSources.set(
      id,
      await compileDirectiveTypeScript(
        entry.source,
        sourceFile,
        "inline",
        entry.sourceLine !== undefined
          ? { line: entry.sourceLine, column: entry.sourceColumn ?? 1 }
          : undefined,
        // The source is the body as written, so it starts where the body does.
        entry.sourceLine !== undefined
          ? { line: entry.sourceLine, column: entry.sourceColumn ?? 1 }
          : undefined,
      ),
    );
  }

  // One host-neutral job from a sidecar entry: a `src=` module by path, an
  // inline script with its specifiers rewritten for staging.
  const jobFor = (
    id: string,
    entry: ServerScriptEntry,
    owner: string,
  ): SiteGraphJob => {
    // A component script's markup gets the component's element classes on
    // every host (prompt 157); the key is absent for page-level scripts.
    const scope = entry.outputScope ? { outputScope: entry.outputScope } : {};
    const containingDir = entry.sourceFile
      ? dirname(resolve(projectRoot, entry.sourceFile))
      : projectRoot;
    if (entry.modulePath) {
      const modulePath = resolveScriptSrcPath(
        entry.modulePath,
        containingDir,
        importRoot,
      );
      return {
        id,
        mode: entry.mode,
        source: { kind: "module", path: modulePath },
        owner,
        ...scope,
      };
    }
    const rewritten = rewriteModuleSpecifiers(
      compiledSources.get(id) ?? entry.source,
      containingDir,
      {
        importRoot,
      },
    );
    return {
      id,
      mode: entry.mode,
      source: { kind: "inline", code: rewritten, stagedPath: "" },
      owner,
      ...scope,
    };
  };

  // Page-owned entries mean the release renders component tags from script
  // output through .bascik/dist/components.json (prompt 157); a dist without
  // a compatible manifest is a stale build, as it is for `bascik --server`.
  // The manifest and the component scripts it names form the graph's
  // `components` section; they belong to no page, since any page's script
  // may return any component. A job the sidecar lacks is the same stale
  // build the production boot refuses.
  let components: SiteGraphComponents | undefined;
  if (sidecarHasPageEntries(sidecarScripts)) {
    const manifest: ComponentManifest | null =
      await readComponentManifest(distDir);
    if (!manifest) {
      throw new Error(
        `[bascik] --target: the sidecar has server-script entries but .bascik/dist/components.json is missing. Run \`bascik --build\` again.`,
      );
    }
    const jobs: Record<string, SiteGraphJob> = {};
    for (const component of Object.values(manifest.components)) {
      for (const job of component.jobs) {
        const entry = sidecarScripts[job.id];
        if (!entry) {
          throw new Error(
            `[bascik] --target: component script "${job.id}" of <${component.name}> (${component.filePath}) ` +
              `is listed in .bascik/dist/components.json but missing from the sidecar. Run \`bascik --build\` again.`,
          );
        }
        // The manifest records the component file project-relative; the
        // sidecar's path is whatever the builder listed (absolute on a real
        // build), so the owner is shown from the manifest when it has one.
        const sourceFile = job.sourceFile ?? entry.sourceFile;
        const shownFile = sourceFile
          ? (isAbsolute(sourceFile)
              ? relative(projectRoot, sourceFile)
              : sourceFile
            ).replace(/\\/g, "/")
          : component.filePath;
        const line = job.sourceLine ?? entry.sourceLine;
        jobs[job.id] = jobFor(
          job.id,
          entry,
          `${entry.mode} script in ${shownFile}${line ? `:${line}` : ""}`,
        );
      }
    }
    components = { manifest, jobs };
  }

  const distFiles = await readDistFiles(distDir);
  const publicFiles: string[] = [];
  const pages: Record<string, SiteGraphPage> = {};
  let custom500: string | undefined;

  for (const rel of distFiles) {
    if (rel.startsWith(".bascik/")) continue;
    if (!isPublicAssetPath(rel, hideDotfiles)) continue;
    if (/\.html?$/i.test(rel)) {
      const html = await readFile(join(distDir, rel), "utf8");
      const { segments, scriptIds } = splitDistPageIntoSegments(html);
      const httpPath = getHttpPath(rel, pagesDir);
      if (httpPath === "/500") custom500 = html;
      if (scriptIds.length === 0) {
        publicFiles.push(rel);
        continue;
      }
      const jobs: Record<string, SiteGraphJob> = {};
      for (const id of scriptIds) {
        const entry = sidecarScripts[id];
        if (!entry) {
          throw new Error(
            `[bascik] --target: page "${rel}" references server script "${id}" that is missing from the sidecar. Run \`bascik --build\` again.`,
          );
        }
        const owner = `${entry.mode} script in ${
          entry.sourceFile
            ? relative(projectRoot, entry.sourceFile).replace(/\\/g, "/")
            : rel
        }${entry.sourceLine ? `:${entry.sourceLine}` : ""}`;
        jobs[id] = jobFor(id, entry, owner);
      }

      pages[httpPath] = {
        path: httpPath,
        is404: httpPath === "/404",
        segments,
        jobs,
      };
      continue;
    }
    publicFiles.push(rel);
  }

  // Scan API routes
  const apiDirPath = resolve(
    projectRoot,
    options.apiDir ?? BascikConfig?.directory?.api ?? "src/api",
  );
  const apiFiles = await scanApiRouteFiles(apiDirPath);
  const rawApiRoutes = apiFiles.length
    ? buildApiRouteTree(apiFiles, apiDirPath, base)
    : [];
  const apiRoutes: SiteGraphApiRoute[] = rawApiRoutes.map((r) => ({
    path: r.path,
    filePath: r.filePath,
    paramNames: r.paramNames,
    isDynamic: r.isDynamic,
  }));

  const hashOf = (str: string) =>
    createHash("sha256").update(str).digest("hex").slice(0, 16);
  const release = `${version}+${hashOf(
    JSON.stringify({
      pages: Object.keys(pages).sort(),
      api: apiRoutes.map((r) => r.path),
      files: publicFiles.sort(),
    }),
  )}`;

  // Opt-in contentSecurityPolicy: the policy, every route's build hashes,
  // and the static pages a host serves without its runtime.
  let contentSecurityPolicy: SiteGraphContentSecurityPolicy | undefined;
  const policy =
    options.contentSecurityPolicy ?? BascikConfig?.contentSecurityPolicy;
  if (policy) {
    let hashes: Record<string, CspRouteHashes> = {};
    try {
      hashes = JSON.parse(
        await readFile(join(privateDirFor(distDir), "csp-hashes.json"), "utf8"),
      ) as Record<string, CspRouteHashes>;
    } catch {
      hashes = {};
    }
    const staticRoutes = publicFiles
      .filter((rel) => /\.html?$/i.test(rel))
      .map((rel) => getHttpPath(rel, pagesDir))
      .sort();
    contentSecurityPolicy = { policy, hashes, staticRoutes };
  }

  return {
    base,
    release,
    scriptTimeoutMs,
    apiTimeoutMs,
    onServerScriptError,
    publicFiles: publicFiles.sort(),
    pages,
    apiRoutes,
    custom500,
    importRoot,
    responseSecurity,
    hideDotfiles,
    stripAnsi,
    renderLimits,
    ...(components ? { components } : {}),
    ...(contentSecurityPolicy ? { contentSecurityPolicy } : {}),
  };
};

/** The fields of `obj` that are set, so an `undefined` never hides a default. */
const definedFields = <T extends object>(obj: T | undefined): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
