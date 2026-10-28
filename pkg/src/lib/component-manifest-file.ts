/**
 * @module component-manifest-file
 *
 * The component manifest as a file (prompt 157, D3): its types, its schema,
 * and how `dist/.bascik/components.json` is written, read and validated.
 * component-manifest.ts builds it during a build and re-exports all of this;
 * the prod server, `bascik --check` and the request-time renderer import
 * this module instead, so serving a release never loads the manifest
 * builder or the build pipeline behind it (build scripts, the scoping
 * recorder, the minifiers).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScopingTemplate } from "./scoping-instantiate.ts";
import type { ServerScriptMode } from "./server-sidecar.ts";
export const COMPONENT_MANIFEST_SCHEMA_VERSION = 1;

export type UnsupportedReason =
  | "attr-binding-to-scoped-attribute"
  | "instance-scoped-server-script"
  | "build-script-reads-page-context"
  | "attr-src-on-directive-script"
  | "scoping-template-unavailable";

/** A server or stream script of a component, staged once in the sidecar. */
export interface ManifestJob {
  id: string;
  mode: ServerScriptMode;
  /** 1-based position among the component's server and stream scripts. */
  ordinal: number;
  sourceFile?: string;
  sourceLine?: number;
  /** The encoded `data-bascik-output-scope` the runner applies to the job's output. */
  outputScope?: string;
}

/**
 * The component's stylesheet as the page pipeline emits it: `text` is the
 * exact bytes (dedupe -> base rewrite -> `minify.css`) and `hash` the CSP
 * hash of `<style>text</style>`. `perInstance` when the CSS embeds the
 * instance id (`url(#id)`, or `scoping.deduplicateCss: false`), in which case
 * it stays segmented in `template.cssFileContent`. Null without a stylesheet.
 */
export type ManifestCss =
  { text: string; hash: string } | { perInstance: true } | null;

/**
 * Why a component is left unexpanded at request time. `reason` is the D7
 * category a renderer and `bascik --check` key on; `detail` says what in
 * this component triggered it (several distinct refusals share a reason, and
 * the reason alone gives the author nothing to change); `line` is the
 * 1-based line of the offending open tag in `filePath` when one is known.
 */
export interface UnsupportedEntry {
  reason: UnsupportedReason;
  detail?: string;
  line?: number;
}

export const UNSUPPORTED_REASONS: ReadonlySet<string> =
  new Set<UnsupportedReason>([
    "attr-binding-to-scoped-attribute",
    "instance-scoped-server-script",
    "build-script-reads-page-context",
    "attr-src-on-directive-script",
    "scoping-template-unavailable",
  ]);

export interface ManifestEntry {
  name: string;
  /**
   * The component file as `bascik --check` and the dev server print it,
   * relative to its component root (`components/card/card.html`; a root
   * outside the project stays cwd-relative). Diagnostics only: every host
   * prints it as recorded, so Node and workerd name the file the same way.
   */
  filePath: string;
  template: ScopingTemplate | null;
  unsupported?: UnsupportedEntry;
  css: ManifestCss;
  jobs: ManifestJob[];
  /**
   * Whether every instance emits the same style block and the same client
   * script bodies, so one set of CSP hashes covers all of them (D5).
   */
  cspStable: { style: boolean; script: boolean };
  /** The first instance's client script hashes when `cspStable.script`. */
  scriptHashes: string[];
}

export interface ComponentManifest {
  schema: number;
  /** `minify.identifiers` at build time: picks the name hash at request time. */
  identifiers: boolean;
  minifyHtml: boolean;
  base: string;
  inheritAttributes: boolean;
  components: Record<string, ManifestEntry>;
}

/**
 * The CSP hashes any request-rendered instance of a manifest component can
 * contribute to a page (D5): the style hash of every component whose block
 * is the same for every instance, and the first-instance script hashes of
 * every component whose scripts are. Deduplicated and sorted.
 */
export const manifestCspHashes = (
  manifest: ComponentManifest,
): { scripts: string[]; styles: string[] } => {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const entry of Object.values(manifest.components)) {
    if (entry.unsupported) continue;
    if (entry.cspStable.style && entry.css && "hash" in entry.css)
      styles.add(entry.css.hash);
    if (entry.cspStable.script)
      for (const hash of entry.scriptHashes) scripts.add(hash);
  }
  const sorted = (hashes: Set<string>) =>
    [...hashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { scripts: sorted(scripts), styles: sorted(styles) };
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
};

/**
 * The manifest with every object's keys sorted, so `JSON.stringify` of it is
 * byte-identical across builds (D3 step 8). The ownership transaction stages
 * this through `stageJsonArtifact`; `writeComponentManifest` writes the same
 * bytes directly.
 */
export const sortedComponentManifest = (
  manifest: ComponentManifest,
): ComponentManifest => sortKeysDeep(manifest) as ComponentManifest;

export const componentManifestPath = (distDir: string): string =>
  join(distDir, ".bascik", "components.json");

export const writeComponentManifest = async (
  distDir: string,
  manifest: ComponentManifest,
): Promise<string> => {
  const path = componentManifestPath(distDir);
  await mkdir(join(distDir, ".bascik"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(sortedComponentManifest(manifest), null, 2),
    "utf8",
  );
  return path;
};

const rebuildHint =
  "Run `bascik --build` to regenerate dist/.bascik/components.json.";

/**
 * Read `dist/.bascik/components.json`. Null when absent (a static release
 * has none); a manifest of another schema or one that does not parse is a
 * stale build and throws the rebuild message, like the sidecar.
 */
export const readComponentManifest = async (
  distDir: string,
): Promise<ComponentManifest | null> => {
  const path = componentManifestPath(distDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `[bascik] component manifest at ${path} could not be read: ${(err as Error).message}. ${rebuildHint}`,
    );
  }
  let parsed: Partial<ComponentManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<ComponentManifest>;
  } catch (err) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (${(err as Error).message}). ${rebuildHint}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (not an object). ${rebuildHint}`,
    );
  }
  if (parsed.schema !== COMPONENT_MANIFEST_SCHEMA_VERSION) {
    // JSON.stringify keeps a string "1" distinguishable from the number 1.
    throw new Error(
      `[bascik] component manifest at ${path} uses schema ${JSON.stringify(parsed.schema)}, ` +
        `but this runtime understands schema ${COMPONENT_MANIFEST_SCHEMA_VERSION}. ${rebuildHint}`,
    );
  }
  if (
    !parsed.components ||
    typeof parsed.components !== "object" ||
    Array.isArray(parsed.components)
  ) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (no "components" member). ${rebuildHint}`,
    );
  }
  // Each entry is validated here, like the sidecar loader validates its
  // entries, so a hand-edited or truncated entry is a located rebuild message
  // and never a TypeError in whoever dereferences it (check.ts, phase 3's
  // renderer).
  for (const [name, entry] of Object.entries(parsed.components)) {
    const problem = manifestEntryProblem(entry);
    if (problem) {
      throw new Error(
        `[bascik] component manifest at ${path} is malformed (entry "${name}" ${problem}). ${rebuildHint}`,
      );
    }
  }
  return parsed as ComponentManifest;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What makes `entry` not a `ManifestEntry`, or null when it is one. */
const manifestEntryProblem = (entry: unknown): string | null => {
  if (!isPlainObject(entry)) return "is not an object";
  if (typeof entry.name !== "string") return 'has no "name"';
  if (typeof entry.filePath !== "string") return 'has no "filePath"';
  if (entry.template !== null && !isPlainObject(entry.template))
    return 'has a "template" that is neither an object nor null';
  if (entry.unsupported !== undefined) {
    if (!isPlainObject(entry.unsupported))
      return 'has a malformed "unsupported"';
    if (!UNSUPPORTED_REASONS.has(String(entry.unsupported.reason)))
      return `has an unknown unsupported reason ${JSON.stringify(entry.unsupported.reason)}`;
    if (
      entry.unsupported.detail !== undefined &&
      typeof entry.unsupported.detail !== "string"
    )
      return 'has a non-string "unsupported.detail"';
    if (
      entry.unsupported.line !== undefined &&
      typeof entry.unsupported.line !== "number"
    )
      return 'has a non-numeric "unsupported.line"';
  }
  if (entry.css !== null && !isPlainObject(entry.css))
    return 'has a "css" that is neither an object nor null';
  if (!Array.isArray(entry.jobs)) return 'has no "jobs" array';
  if (
    !isPlainObject(entry.cspStable) ||
    typeof entry.cspStable.style !== "boolean" ||
    typeof entry.cspStable.script !== "boolean"
  )
    return 'has no "cspStable" with boolean "style" and "script"';
  if (!Array.isArray(entry.scriptHashes)) return 'has no "scriptHashes" array';
  return null;
};
