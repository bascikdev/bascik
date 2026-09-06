/**
 * @module ownership
 *
 * Durable source-to-output ownership inventory for targeted builds (prompt 101).
 *
 * A targeted build (`bascik --build --only …`) runs in a FRESH CLI process whose
 * process-local collectors and in-memory route caches are empty. Prompt 100 gave
 * each page a single accounting owner (`writeTranspiledPage`) but left the
 * *metadata* writers (`server-scripts.json`, `manifest.json`, `csp-hashes.json`)
 * merging additively, and the removed-route knowledge only in the in-memory
 * `templateToGeneratedRelativePaths` map. Resulting P0 defect:
 *   - untouched B's server-sidecar entry is dropped when only A is rebuilt, and
 *   - a route removed from a dynamic template leaves its HTML, manifest entry,
 *     and CSP entry behind in a fresh process.
 *
 * This module persists a **versioned source-to-output ownership inventory** at
 * `dist/.bascik/ownership.json`. Every output file and sidecar script is owned
 * by exactly one source page. For a targeted build the inventory lets us:
 *   - **exactly replace rebuilt owners** (a page rebuilt now owns exactly the
 *     outputs and scripts it produced this process),
 *   - **retain untouched owners** (anything not rebuilt keeps its prior
 *     outputs and scripts, so B's sidecar entry survives),
 *   - **delete obsolete outputs for rebuilt owners only** (route/script removal
 *     prunes prior outputs that no rebuilt owner still produces), and
 *   - **reconcile HTML, sidecar, manifest, and CSP from the SAME transaction**,
 *     so metadata never disagrees about what is on disk.
 *
 * Ownership is never inferred from filename prefixes or mutable traversal
 * order; it is read from the durable inventory and updated only by the
 * in-process tracker during a build.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { getHttpPath } from "./paths.ts";

/** Bumped when the on-disk ownership schema changes incompatibly. */
export const OWNERSHIP_SCHEMA = 1;
/** Bumped when the file format version changes. */
export const OWNERSHIP_VERSION = "1";

export interface OwnershipOutput {
  /** dist-relative output path (forward slashes), e.g. `a.html`, `blog/one.html`. */
  file: string;
  /** HTTP route key used by csp-hashes.json, e.g. `/a`, `/blog/one`. */
  route: string;
}

export interface OwnershipEntry {
  /** absolute source path that produced the outputs/scripts. */
  source: string;
  /** source path relative to the pages dir, e.g. `pages/a.html`. */
  relSource: string;
  /** dist-relative outputs owned by this source. */
  outputs: OwnershipOutput[];
  /** sidecar script ids owned by this source. */
  scripts: string[];
}

export interface OwnershipInventory {
  version: string;
  schema: number;
  /** keyed by absolute source path. */
  owners: Record<string, OwnershipEntry>;
}

export const isTargetedBuild = (): boolean =>
  Boolean(BascikConfig.isBuild && BascikConfig.only && BascikConfig.only.length > 0);

const outDir = (): string => resolve(process.cwd(), BascikConfig.directory.out);
const ownershipPath = (): string => join(outDir(), ".bascik", "ownership.json");

/** dist-relative key for a page's output file (mirrors the manifest key). */
export const toOutputFileKey = (distRelPath: string): string => {
  const abs = resolve(process.cwd(), distRelPath);
  return relative(outDir(), abs).replace(/\\/g, "/");
};

/** Convert an output file key (e.g. `blog/one.html`) to its HTTP route. */
export const outputRouteForKey = (fileKey: string): string => {
  // getHttpPath expects a `pages/…` relative page path. For directory index
  // files this yields the trailing-slash route getHttpPath produces.
  return getHttpPath(`pages/${fileKey}`);
};

/**
 * In-process tracker collecting each rebuilt owner's outputs and scripts during
 * a single build. `writeTranspiledPage` records an output; the page publishing
 * paths record the owner's sidecar script ids (for server/stream scripts).
 */
class OwnershipTracker {
  private owners = new Map<
    string,
    { entry: OwnershipEntry; outputs: Map<string, OwnershipOutput>; scripts: Set<string> }
  >();

  private ensure(sourceAbs: string, relSource: string) {
    let o = this.owners.get(sourceAbs);
    if (!o) {
      o = {
        entry: { source: sourceAbs, relSource, outputs: [], scripts: [] },
        outputs: new Map(),
        scripts: new Set(),
      };
      this.owners.set(sourceAbs, o);
    }
    return o;
  }

  /**
   * Mark an owner as rebuilt with an EMPTY output/script set. Used when a
   * dynamic template now emits zero routes: no page job is produced, so no
   * `writeTranspiledPage` would record it, but a zero-route template is still
   * an authoritative rebuild of that owner and must prune its prior outputs.
   */
  recordOwner(sourceAbs: string, relSource: string): void {
    this.ensure(sourceAbs, relSource);
  }

  /** Record one emitted output owned by `sourceAbs`. */
  recordOutput(sourceAbs: string, relSource: string, fileKey: string, route: string): void {
    this.ensure(sourceAbs, relSource).outputs.set(fileKey, { file: fileKey, route });
  }

  /** Record one sidecar script id owned by `sourceAbs`. */
  recordScript(sourceAbs: string, relSource: string, scriptId: string): void {
    this.ensure(sourceAbs, relSource).scripts.add(scriptId);
  }

  getEntries(): Record<string, OwnershipEntry> {
    const result: Record<string, OwnershipEntry> = {};
    // Sort owner keys so the serialized inventory is independent of page
    // traversal / worker dispatch order (requirement: never infer ownership
    // from mutable traversal order).
    const sources = Array.from(this.owners.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const source of sources) {
      const o = this.owners.get(source)!;
      const outputs = Array.from(o.outputs.values()).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
      const scripts = Array.from(o.scripts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      result[source] = { source, relSource: o.entry.relSource, outputs, scripts };
    }
    return result;
  }

  clear(): void {
    this.owners.clear();
  }
}

export const ownershipTracker = new OwnershipTracker();

/** Fresh, empty inventory ready to be filled by a full build. */
export const emptyInventory = (): OwnershipInventory => ({
  version: OWNERSHIP_VERSION,
  schema: OWNERSHIP_SCHEMA,
  owners: {},
});

/**
 * Read the persisted ownership inventory. Returns `null` when it is missing,
 * corrupt, or carries an incompatible schema/version — each of which is treated
 * as "no reliable ownership", i.e. the safe first-targeted-build behavior.
 */
export const readOwnershipInventory = async (): Promise<OwnershipInventory | null> => {
  try {
    const raw = await readFile(ownershipPath(), "utf8");
    const parsed = JSON.parse(raw) as OwnershipInventory;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schema !== OWNERSHIP_SCHEMA ||
      parsed.version !== OWNERSHIP_VERSION ||
      !parsed.owners ||
      typeof parsed.owners !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

/** Validate a candidate inventory before it is written. */
export const validateInventory = (inv: OwnershipInventory): void => {
  if (!inv || typeof inv !== "object") {
    throw new Error("[bascik] ownership: refusing to write an invalid ownership inventory");
  }
  if (inv.schema !== OWNERSHIP_SCHEMA || inv.version !== OWNERSHIP_VERSION) {
    throw new Error("[bascik] ownership: refusing to write an incompatible ownership inventory");
  }
  if (!inv.owners || typeof inv.owners !== "object") {
    throw new Error("[bascik] ownership: refusing to write an inventory without owners");
  }
  for (const [source, entry] of Object.entries(inv.owners)) {
    if (!entry || typeof entry !== "object" || entry.source !== source) {
      throw new Error(`[bascik] ownership: corrupt owner entry for ${source}`);
    }
    if (!Array.isArray(entry.outputs) || !Array.isArray(entry.scripts)) {
      throw new Error(`[bascik] ownership: corrupt owner entry for ${source}`);
    }
  }
};

export interface ReconcileResult {
  /** The full next inventory (rebuilt owners replaced, untouched retained). */
  inventory: OwnershipInventory;
  /**
   * dist-relative output files that are no longer owned by any owner and should
   * be deleted. Only ever derived from rebuilt owners' prior outputs that their
   * new output set no longer contains (never from filename prefixes).
   */
  obsoleteOutputs: string[];
  /** True when no valid prior inventory existed (safe additive fallback). */
  degradedToAdditive: boolean;
}

/**
 * Merge prior ownership with the in-process tracker's rebuilt owners.
 *
 * - Rebuilt owners (in `tracker`) are **exactly** their current outputs/scripts.
 * - Untouched prior owners (not rebuilt) are retained as-is.
 * - Removed outputs are computed as: for each rebuilt owner, its prior outputs
 *   minus its current outputs. A source page can only shed outputs when it is
 *   actually rebuilt and therefore provides authoritative new ownership.
 *
 * When there is no valid prior inventory (`prior` is null), every owner present
 * is treated as rebuilt and nothing can be pruned (`obsoleteOutputs = []`):
 * that is the explicit safe first-targeted-build behavior.
 */
export const reconcileOwnership = (
  prior: OwnershipInventory | null,
  current: Record<string, OwnershipEntry>,
): ReconcileResult => {
  const next: Record<string, OwnershipEntry> = {};
  const obsolete = new Set<string>();

  if (!prior) {
    for (const entry of Object.values(current)) {
      next[entry.source] = entry;
    }
    return { inventory: { ...emptyInventory(), owners: next }, obsoleteOutputs: [], degradedToAdditive: true };
  }

  const rebuiltSources = new Set(Object.keys(current));
  const nextOutputs = new Set<string>();

  // Retain untouched owners, then overlay rebuilt owners with exact replacements.
  for (const [source, entry] of Object.entries(prior.owners)) {
    if (rebuiltSources.has(source)) continue;
    next[source] = entry;
    for (const out of entry.outputs) nextOutputs.add(out.file);
  }
  for (const [source, entry] of Object.entries(current)) {
    next[source] = entry;
    for (const out of entry.outputs) nextOutputs.add(out.file);
  }

  // Obsolete outputs come only from rebuilt owners' prior outputs that the new
  // output set no longer contains, i.e. a route/script removed by the current,
  // authoritative build of that owner.
  for (const source of rebuiltSources) {
    const priorOwner = prior.owners[source];
    if (!priorOwner) continue;
    for (const out of priorOwner.outputs) {
      if (!nextOutputs.has(out.file)) {
        obsolete.add(out.file);
      }
    }
  }

  const inv: OwnershipInventory = {
    ...emptyInventory(),
    owners: next,
  };
  return {
    inventory: inv,
    obsoleteOutputs: Array.from(obsolete),
    degradedToAdditive: false,
  };
};

/**
 * Stage one JSON artifact: write to a temp sibling and validate the serialized
 * JSON without touching the target. Returns a commit handle. Used so a targeted
 * build can stage EVERY metadata file and validate them before renaming any of
 * them over the previous valid artifact set.
 */
export const stageJsonArtifact = async (
  targetPath: string,
  content: unknown,
): Promise<() => Promise<void>> => {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(content, null, 2);
  const base = resolve(targetPath).split(/[\\/]/).pop();
  const tmp = join(dir, `.${base}.${process.pid}.tmp`);
  // Validation before commit: the staged bytes must parse back to a JSON object
  // equal in shape to what we intended to publish.
  const reparsed = JSON.parse(payload) as unknown;
  if (!reparsed || typeof reparsed !== "object") {
    throw new Error("[bascik] ownership: staged artifact failed validation");
  }
  await writeFile(tmp, payload, "utf8");
  return async () => {
    try {
      await rename(tmp, targetPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => { });
      throw err;
    }
  };
};

/**
 * Atomically write a single JSON artifact (stage then immediately commit).
 * Used for the ownership inventory and for full builds where there is no prior
 * artifact set to preserve as a transaction.
 */
export const atomicWriteJson = async (targetPath: string, content: unknown): Promise<void> => {
  const commit = await stageJsonArtifact(targetPath, content);
  await commit();
};

/** Delete an obsolete dist-relative output, tolerating a missing file. */
export const pruneOutputFile = async (fileKey: string): Promise<void> => {
  const abs = resolve(outDir(), fileKey);
  try {
    await rm(abs, { force: true, recursive: false });
  } catch (err) {
    // A non-existent file is fine; any other failure is surfaced but does not
    // roll back already-committed metadata (documented rollback contract).
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[bascik] warning: could not prune stale output "${fileKey}": ${(err as Error).message}`);
    }
  }
};

/** Persist an ownership inventory (used by finalize and directly in tests). */
export const writeOwnershipInventory = async (inv: OwnershipInventory): Promise<void> => {
  validateInventory(inv);
  await atomicWriteJson(ownershipPath(), inv);
};

// ─── Artifact finalization (single ownership transaction) ────────────────────

import {
  manifestCollector,
  type BuildManifest,
  type ManifestEntry,
} from "./manifest.ts";
import { cspHashCollector, type CspHashesManifest } from "./csp-hashes.ts";
import {
  serverSidecarRegistry,
  type ServerScriptEntry,
  type ServerScriptsSidecar,
  SIDECAR_SCHEMA_VERSION,
} from "./server-sidecar.ts";

const manifestPath = (): string => join(outDir(), ".bascik", "manifest.json");
const cspPath = (): string => join(outDir(), ".bascik", "csp-hashes.json");
const sidecarPath = (): string => join(outDir(), ".bascik", "server-scripts.json");

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const pageOutputSet = (inv: OwnershipInventory): Set<string> =>
  new Set(Object.values(inv.owners).flatMap((o) => o.outputs.map((out) => out.file)));

/**
 * Reconcile the final manifest for a targeted build from the SAME ownership
 * transaction. Page files follow ownership: a page output survives only when a
 * current owner still produces it (rebuilt owner exact replacement / untouched
 * owner retained), so a removed route is pruned. Non-page files (raw-copied
 * assets, sitemap, robots, and the `.bascik/*` metadata files) are retained
 * from prior and overlaid with anything re-produced this process.
 */
const reconcileManifest = (
  inv: OwnershipInventory,
  prior: BuildManifest | null,
  current: Record<string, ManifestEntry>,
  priorInventory: OwnershipInventory | null,
): Record<string, ManifestEntry> => {
  const ownedNow = pageOutputSet(inv);
  const ownedBefore = priorInventory ? pageOutputSet(priorInventory) : new Set<string>();
  const allPageFiles = new Set([...ownedBefore, ...ownedNow]);
  const allFiles = new Set([...Object.keys(prior?.files ?? {}), ...Object.keys(current)]);
  const result: Record<string, ManifestEntry> = {};
  for (const k of allFiles) {
    if (allPageFiles.has(k)) {
      // A page-output file survives only if still owned now.
      if (ownedNow.has(k)) result[k] = current[k] ?? prior?.files?.[k];
      continue;
    }
    // Non-page artifact: keep prior (e.g. sitemap/robots not regenerated in a
    // targeted build) overlaid with whatever this process re-produced.
    result[k] = current[k] ?? prior?.files?.[k];
  }
  return result;
};

const reconcileCsp = (
  inv: OwnershipInventory,
  prior: CspHashesManifest | null,
  current: CspHashesManifest,
  priorInventory: OwnershipInventory | null,
): CspHashesManifest => {
  const ownedNow = new Set(Object.values(inv.owners).flatMap((o) => o.outputs.map((out) => out.route)));
  const ownedBefore = priorInventory
    ? new Set(Object.values(priorInventory.owners).flatMap((o) => o.outputs.map((out) => out.route)))
    : new Set<string>();
  const allPageRoutes = new Set([...ownedBefore, ...ownedNow]);
  const allRoutes = new Set([...Object.keys(prior ?? {}), ...Object.keys(current)]);
  const result: CspHashesManifest = {};
  for (const r of allRoutes) {
    if (allPageRoutes.has(r)) {
      // A page route survives only if still owned now; a removed route is
      // pruned even though a stale empty prior entry remains.
      if (ownedNow.has(r)) result[r] = current[r] ?? prior?.[r];
      continue;
    }
    result[r] = current[r] ?? prior?.[r];
  }
  return result;
};

/**
 * Reconcile the final server-scripts sidecar for a targeted build from the SAME
 * ownership transaction. Only scripts owned by an owner survive; a rebuilt
 * owner's scripts come from THIS process, an untouched owner's scripts are
 * carried over from the prior sidecar so their request-time placeholders keep
 * resolving.
 */
const reconcileSidecar = (
  inv: OwnershipInventory,
  prior: ServerScriptsSidecar | null,
  current: Record<string, ServerScriptEntry>,
): ServerScriptsSidecar | null => {
  const owned = new Set(Object.values(inv.owners).flatMap((o) => o.scripts));
  if (owned.size === 0 && !prior?.scripts) {
    return null;
  }
  const result: Record<string, ServerScriptEntry> = {};
  for (const id of owned) {
    const entry = current[id] ?? prior?.scripts?.[id];
    if (entry) result[id] = { ...entry, mode: entry.mode ?? "server" };
  }
  return {
    version: prior?.version ?? "unknown",
    schema: SIDECAR_SCHEMA_VERSION,
    scripts: result,
  };
};

/**
 * Finalize all build artifacts from a single ownership transaction.
 *
 * Full build: dist/ was cleaned at startup, so `prior` is empty; the inventory
 * is exactly the current tracker and metadata is written freshly (no merge).
 *
 * Targeted build:
 *   1. Reconcile ownership (rebuilt replaced, untouched retained, obsolete
 *      computed for rebuilt owners only).
 *   2. Reconcile manifest, CSP, and sidecar from that SAME inventory.
 *   3. Stage and atomically commit each metadata file (validate before rename).
 *   4. Write the new ownership inventory.
 *   5. Only AFTER metadata commits, delete obsolete outputs.
 *
 * A failure at any staging/commit step aborts BEFORE deleting outputs, so the
 * previous valid artifact + metadata set is never broken by a failed targeted
 * build (the rollback/partial-failure contract). Corrupt or missing ownership
 * degrades to the safe additive fallback with a warning.
 */
export const finalizeOwnedArtifacts = async (
  version: string,
  options: { forTargetedBuild: boolean },
): Promise<void> => {
  const currentEntries = ownershipTracker.getEntries();
  const priorInventory = await readOwnershipInventory();

  let result: ReconcileResult;
  if (!options.forTargetedBuild) {
    result = {
      inventory: { ...emptyInventory(), owners: currentEntries },
      obsoleteOutputs: [],
      degradedToAdditive: false,
    };
  } else {
    result = reconcileOwnership(priorInventory, currentEntries);
    if (result.degradedToAdditive) {
      console.warn(
        "[bascik] warning: no compatible ownership inventory found; this targeted build " +
        "merged additively and could not prune outputs removed outside this process. " +
        "A fresh ownership inventory was written; run a full build to reconcile the whole site.",
      );
    }
  }

  const inv = result.inventory;
  validateInventory(inv);

  const currentManifest = manifestCollector.getFiles();
  const currentCsp = cspHashCollector.getManifest();
  const currentSidecar = serverSidecarRegistry.getAllScripts();

  const priorManifest = await readJsonIfPresent<BuildManifest>(manifestPath());
  const priorCsp = await readJsonIfPresent<CspHashesManifest>(cspPath());
  const priorSidecar = await readJsonIfPresent<ServerScriptsSidecar>(sidecarPath());

  // ── Stage EVERY artifact and validate it BEFORE any rename ──────────────
  const commits: Array<() => Promise<void>> = [];

  if (BascikConfig.generate?.manifest) {
    const files = reconcileManifest(inv, priorManifest, currentManifest, priorInventory);
    commits.push(await stageJsonArtifact(manifestPath(), { version, files }));
  }

  if (BascikConfig.generate?.cspHashes) {
    const csp = reconcileCsp(inv, priorCsp, currentCsp, priorInventory);
    commits.push(await stageJsonArtifact(cspPath(), csp));
  }

  const sidecar = reconcileSidecar(inv, priorSidecar, currentSidecar);
  if (sidecar) {
    commits.push(await stageJsonArtifact(sidecarPath(), sidecar));
  }

  commits.unshift(await stageJsonArtifact(ownershipPath(), inv));

  // ── Commit. All artifacts are already validated on disk as temp siblings,
  // so a failure during writing/validation happened before the loop below and
  // left the previous valid artifact set untouched. Each rename is atomic per
  // file; a rename failure throws and aborts before obsolete-output pruning. ──
  for (const commit of commits) {
    await commit();
  }

  // ── Prune obsolete outputs only AFTER metadata commit ────────────────────
  for (const fileKey of result.obsoleteOutputs) {
    await pruneOutputFile(fileKey);
  }
};