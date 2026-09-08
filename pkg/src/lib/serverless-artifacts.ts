/**
 * @module serverless-artifacts
 *
 * Orchestrates serverless artifact emission via HostingAdapter (prompts 133, 142).
 */

import { mkdir, writeFile, readdir, rm, realpath, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BascikConfig } from "./config.ts";
import { resolveAdapterTarget } from "./adapter-resolution.ts";
import { readSiteGraph, detectPublicCollisions } from "./site-graph.ts";
import { rewriteModuleSpecifiers } from "./module-specifiers.ts";
import { getImportRoot } from "./import-root.ts";
import type { DeployTarget } from "./cli.ts";
import type {
  SiteGraph,
  AdapterBuildContext,
  AdapterBuildResult,
} from "./adapter-contract.ts";

export type { DeployTarget };

export interface ServerlessBuildResult {
  target: string;
  adapter: string;
  outDir: string;
  publicDir: string;
  workerPath?: string;
  bundleBytes: number;
  dynamicPages: string[];
  apiRoutes: string[];
  publicFiles: number;
  release: string;
  notes?: string[];
}

export interface EmitServerlessOptions {
  version: string;
  projectRoot?: string;
  distDir?: string;
  base?: string;
  log?: (msg: string) => void;
}

const ident = (id: string) => `m_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const hashOf = (str: string) => createHash("sha256").update(str).digest("hex").slice(0, 16);

interface DistFileSnapshot {
  size: number;
  mtimeMs: number;
}

const snapshotDistInventory = async (distDir: string, outDir: string, root = distDir): Promise<Map<string, DistFileSnapshot>> => {
  const map = new Map<string, DistFileSnapshot>();
  if (!existsSync(root)) return map;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (resolve(full).startsWith(resolve(outDir))) continue;
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      const sub = await snapshotDistInventory(distDir, outDir, full);
      for (const [k, v] of sub) map.set(k, v);
    } else {
      map.set(resolve(full), { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return map;
};

const verifyDistNotModified = async (prior: Map<string, DistFileSnapshot>): Promise<void> => {
  for (const [path, snap] of prior) {
    try {
      const current = await lstat(path);
      if (current.size !== snap.size || current.mtimeMs !== snap.mtimeMs) {
        throw new Error(`[bascik] Adapter modified dist/ which is read-only for adapters: ${path}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`[bascik] Adapter modified dist/ which is read-only for adapters (deleted file): ${path}`);
      }
      throw err;
    }
  }
};

const assertWrittenPathsUnderOutDir = async (outDir: string, root = outDir): Promise<void> => {
  const canonicalOutDir = await realpath(outDir);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    const linkStat = await lstat(full);
    const canonicalPath = await realpath(full);
    if (!canonicalPath.startsWith(canonicalOutDir + sep) && canonicalPath !== canonicalOutDir) {
      throw new Error(`[bascik] Adapter wrote path outside target output directory: ${full}`);
    }
    if (linkStat.isDirectory()) {
      await assertWrittenPathsUnderOutDir(outDir, full);
    }
  }
};

export const emitServerlessArtifacts = async (
  target: string,
  options: EmitServerlessOptions,
): Promise<ServerlessBuildResult> => {
  const projectRoot = options.projectRoot ?? process.cwd();
  const distDir = options.distDir ?? resolve(projectRoot, BascikConfig?.directory?.out ?? "dist");
  const base = options.base ?? BascikConfig?.base ?? "/";
  const log = options.log ?? console.log;

  // 0. Clean outDir before assembling
  const targetDirName = target.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outDir = join(distDir, ".bascik", targetDirName);
  await rm(outDir, { recursive: true, force: true });

  // 1. Resolve adapter
  const resolved = await resolveAdapterTarget(target, projectRoot);
  const adapter = resolved.adapter!;

  // 2. Read host-neutral SiteGraph
  const graph: SiteGraph = await readSiteGraph({
    projectRoot,
    distDir,
    version: options.version,
    base,
  });

  // Verify public asset collision with static API routes
  const collisions = detectPublicCollisions({
    publicPaths: graph.publicFiles,
    apiRoutePaths: graph.apiRoutes.map((r) => r.path),
    controlFiles: [],
  });
  if (collisions.length) {
    throw new Error(collisions.join("\n"));
  }

  const stagingDir = join(outDir, ".staging");
  await mkdir(stagingDir, { recursive: true });

  // 3. Stage inline sources to outDir/.staging/*.mjs with rewritten module specifiers
  const importRoot = getImportRoot();
  for (const page of Object.values(graph.pages)) {
    for (const job of Object.values(page.jobs)) {
      if (job.source.kind === "inline") {
        const rewritten = rewriteModuleSpecifiers(job.source.code, projectRoot, { importRoot });
        const stagedFile = join(stagingDir, `${ident(job.id)}.${hashOf(rewritten)}.mjs`);
        await writeFile(stagedFile, rewritten, "utf8");
        job.source.stagedPath = stagedFile;
      }
    }
  }

  // Runtime entry path: resolve .js in dist/ or .ts in src/
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const runtimeEntry = resolve(dirname(fileURLToPath(import.meta.url)), `../runtime${ext}`);

  const context: AdapterBuildContext = {
    graph,
    distDir,
    outDir,
    projectRoot,
    variant: resolved.variant,
    log,
    runtimeEntry,
  };

  // Snapshot dist inventory before adapter execution
  const distSnapshot = await snapshotDistInventory(distDir, outDir);

  // 4. Invoke adapter
  let buildResult: AdapterBuildResult;
  try {
    buildResult = await adapter.build(context);
  } finally {
    // Core removes .staging after build resolves
    await rm(stagingDir, { recursive: true, force: true });
  }

  // Verify dist was not modified by the adapter
  await verifyDistNotModified(distSnapshot);

  // 5. Verify every written path in buildResult is under outDir
  if (
    buildResult.workerPath &&
    !resolve(buildResult.workerPath).startsWith(resolve(outDir) + sep) &&
    resolve(buildResult.workerPath) !== resolve(outDir)
  ) {
    throw new Error(`[bascik] Adapter wrote path outside target output directory: ${buildResult.workerPath}`);
  }
  if (
    buildResult.publicDir &&
    !resolve(buildResult.publicDir).startsWith(resolve(outDir) + sep) &&
    resolve(buildResult.publicDir) !== resolve(outDir)
  ) {
    throw new Error(`[bascik] Adapter wrote path outside target output directory: ${buildResult.publicDir}`);
  }
  await assertWrittenPathsUnderOutDir(outDir);

  // 6. Write build-info.json (host-neutral release metadata and notes)
  const buildInfo = {
    target,
    adapter: adapter.name,
    release: graph.release,
    bascikVersion: options.version,
    bundleBytes: buildResult.bundleBytes ?? 0,
    dynamicPages: Object.keys(graph.pages).sort(),
    apiRoutes: graph.apiRoutes.map((r) => r.path),
    publicFiles: graph.publicFiles.length,
    notes: buildResult.notes ?? [],
  };
  await writeFile(join(outDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

  return {
    target,
    adapter: adapter.name,
    outDir,
    publicDir: buildResult.publicDir,
    workerPath: buildResult.workerPath,
    bundleBytes: buildInfo.bundleBytes,
    dynamicPages: buildInfo.dynamicPages,
    apiRoutes: buildInfo.apiRoutes,
    publicFiles: buildInfo.publicFiles,
    release: graph.release,
    notes: buildResult.notes,
  };
};

export const formatServerlessSummary = (result: ServerlessBuildResult, projectRoot = process.cwd()): string => {
  const rel = (p: string) => relative(projectRoot, p).replace(/\\/g, "/");
  const kb = (result.bundleBytes / 1024).toFixed(1);
  const lines = [
    `✓ ${result.target} (${result.adapter}) bundle: ${rel(result.outDir)}/`,
    `  public tree: ${rel(result.publicDir)}/`,
  ];
  if (result.workerPath) {
    lines.push(`  worker: ${rel(result.workerPath)} (${kb} kB)`);
  }
  lines.push(`  dynamic pages: ${result.dynamicPages.length}, API routes: ${result.apiRoutes.length}`);
  if (result.notes) {
    for (const note of result.notes) {
      lines.push(`  note: ${note}`);
    }
  }
  return lines.join("\n");
};
