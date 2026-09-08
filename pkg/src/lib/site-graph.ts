/**
 * @module site-graph
 *
 * Host-neutral representation of the built site graph (prompt 142).
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { BascikConfig } from "./config.ts";
import { getHttpPath } from "./paths.ts";
import { getImportRoot } from "./import-root.ts";
import { rewriteModuleSpecifiers, resolveScriptSrcPath } from "./module-specifiers.ts";
import { scanApiRouteFiles, buildApiRouteTree } from "./api-routes.ts";
import { withBasePath } from "./base-path.ts";
import { getHtmlAttributeValue } from "./html-patterns.ts";
import { SIDECAR_SCHEMA_VERSION, type ServerScriptEntry, type ServerScriptsSidecar } from "./server-sidecar.ts";
import { DEFAULT_SCRIPT_TIMEOUT_MS } from "./server-scripts.ts";
import { createHash } from "node:crypto";
import type {
  SiteGraph,
  SiteGraphPage,
  SiteGraphJob,
  SiteGraphApiRoute,
  DistPageSegment,
} from "./adapter-contract.ts";

export type { DistPageSegment };

const PLACEHOLDER_RE =
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*type=["']text\/bascik-server["'](?:[^>"']|"[^"]*"|'[^']*')*>\s*<\/script>/gi;

/** Split built placeholder HTML into static text and script ids, in document order. */
export const splitDistPageIntoSegments = (
  html: string,
): { segments: DistPageSegment[]; scriptIds: string[] } => {
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
 * path, its trailing-slash toggle, `/index`, and `.html` forms.
 */
export const pageAliasesFor = (httpPath: string, base: string): string[] => {
  const aliases: string[] = [];
  const push = (p: string) => {
    const withBase = withBasePath(p, base);
    if (!aliases.includes(withBase)) aliases.push(withBase);
  };
  push(httpPath);
  if (httpPath === "/") {
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

/** Authored public files that would shadow control files or static API routes. */
export const detectPublicCollisions = (input: {
  publicPaths: string[];
  apiRoutePaths: string[];
  controlFiles: string[];
}): string[] => {
  const problems: string[] = [];
  const control = new Set(input.controlFiles);
  for (const path of [...input.publicPaths].sort()) {
    if (control.has(path)) {
      problems.push(
        `[bascik] --target: authored file "${path}" collides with a generated control file. Rename it or remove it from directory.pages.`,
      );
    }
  }
  const staticApi = new Set(input.apiRoutePaths.filter((p) => !p.includes("[")).map((p) => p.replace(/^\/+/, "")));
  for (const path of input.publicPaths) {
    const withoutExt = path.replace(/\.[a-zA-Z0-9]+$/, "");
    if (staticApi.has(path) || staticApi.has(withoutExt)) {
      problems.push(`[bascik] --target: public file "${path}" shadows API route "/${path.replace(/\.[a-zA-Z0-9]+$/, "")}".`);
    }
  }
  return problems;
};

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
}

export const readSiteGraph = async (options: ReadSiteGraphOptions): Promise<SiteGraph> => {
  const { projectRoot, distDir, version } = options;
  const base = options.base ?? BascikConfig?.base ?? "/";
  const pagesDir = options.pagesDir ?? BascikConfig?.directory?.pages ?? "src/pages";
  const scriptTimeoutMs = options.scriptTimeoutMs ?? BascikConfig?.scripts?.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const apiTimeoutMs = options.apiTimeoutMs ?? BascikConfig?.http?.apiTimeout ?? 10000;
  const onServerScriptError = options.onServerScriptError ?? BascikConfig?.scripts?.onServerScriptError ?? "error";
  const importRoot = getImportRoot();

  // Read server sidecar
  const sidecarPath = join(distDir, ".bascik", "server-scripts.json");
  let sidecar: ServerScriptsSidecar | undefined;
  try {
    const raw = await readFile(sidecarPath, "utf8");
    sidecar = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (sidecar && sidecar.schema !== undefined && sidecar.schema !== SIDECAR_SCHEMA_VERSION) {
    throw new Error(
      `[bascik] --target: sidecar schema ${sidecar.schema} is not understood (expected ${SIDECAR_SCHEMA_VERSION}). Run \`bascik --build\` again.`,
    );
  }
  const sidecarScripts: Record<string, ServerScriptEntry> = sidecar?.scripts ?? {};

  const distFiles = await readDistFiles(distDir);
  const publicFiles: string[] = [];
  const pages: Record<string, SiteGraphPage> = {};
  let custom500: string | undefined;

  for (const rel of distFiles) {
    if (rel.startsWith(".bascik/")) continue;
    if (!isPublicAssetPath(rel)) continue;
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
          entry.sourceFile ? relative(projectRoot, entry.sourceFile).replace(/\\/g, "/") : rel
        }${entry.sourceLine ? `:${entry.sourceLine}` : ""}`;
        const containingDir = entry.sourceFile ? dirname(resolve(projectRoot, entry.sourceFile)) : projectRoot;

        if (entry.modulePath) {
          const modulePath = resolveScriptSrcPath(entry.modulePath, containingDir, importRoot);
          jobs[id] = {
            id,
            mode: entry.mode,
            source: { kind: "module", path: modulePath },
            owner,
          };
        } else {
          const rewritten = rewriteModuleSpecifiers(entry.source, containingDir, { importRoot });
          jobs[id] = {
            id,
            mode: entry.mode,
            source: { kind: "inline", code: rewritten, stagedPath: "" },
            owner,
          };
        }
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
  const apiDirPath = resolve(projectRoot, options.apiDir ?? BascikConfig?.directory?.api ?? "src/api");
  const apiFiles = await scanApiRouteFiles(apiDirPath);
  const rawApiRoutes = apiFiles.length ? buildApiRouteTree(apiFiles, apiDirPath, base) : [];
  const apiRoutes: SiteGraphApiRoute[] = rawApiRoutes.map((r) => ({
    path: r.path,
    filePath: r.filePath,
    paramNames: r.paramNames,
    isDynamic: r.isDynamic,
  }));

  const hashOf = (str: string) => createHash("sha256").update(str).digest("hex").slice(0, 16);
  const release = `${version}+${hashOf(
    JSON.stringify({ pages: Object.keys(pages).sort(), api: apiRoutes.map((r) => r.path), files: publicFiles.sort() }),
  )}`;

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
  };
};
