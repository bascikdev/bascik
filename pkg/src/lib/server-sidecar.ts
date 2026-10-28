import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  STREAM_ATTR_NAME,
  getHtmlAttributeValue,
  scanRequestScripts,
} from "./html-patterns.ts";
import { directiveSourceColumn } from "./directive-source.ts";
import { replaceSpans } from "./element-content-scan.ts";
import { OUTPUT_SCOPE_ATTRIBUTE } from "./output-scope.ts";

/**
 * How a request-time script participates in the response (prompt 65).
 * `server`: resolves before headers are sent (a failure can be a 500).
 * `stream`: the response does not wait for it; its output is written when
 * it resolves, in document order, after the response has committed.
 */
export type ServerScriptMode = "server" | "stream";

export interface ServerScriptEntry {
  id: string;
  mode: ServerScriptMode;
  source: string;
  modulePath?: string;
  sourceFile?: string;
  /** The line the script's body starts on in `sourceFile`. */
  sourceLine?: number;
  /** The column the body starts at on that line. Absent in sidecars written before it was recorded. */
  sourceColumn?: number;
  /**
   * The component's encoded `data-bascik-output-scope` value for a server or
   * stream script written inside a component (prompt 157): its output is
   * spliced in after scoping, so the runner applies the component's class and
   * element names to it the way a build script's output receives them.
   * Absent for page-level scripts.
   */
  outputScope?: string;
}

export interface ServerScriptsSidecar {
  version: string;
  /**
   * Sidecar schema version. Bumped when `mode` was added (2) and again when
   * `outputScope` and component-level `component_script_*` entries were added
   * (3, prompt 157); older sidecars are rejected with a rebuild message.
   */
  schema?: number;
  scripts: Record<string, ServerScriptEntry>;
}

export const SIDECAR_SCHEMA_VERSION = 3;

/**
 * Prefix of the ids of server and stream scripts staged from a component
 * template rather than a page (prompt 157). Each is
 * `component_script_<hex(name::ordinal)>` and belongs to the synthetic
 * sidecar owner `components`, regenerated on every build that writes a
 * component manifest.
 */
export const COMPONENT_SCRIPT_ID_PREFIX = "component_script_";

export const isComponentScriptId = (id: string): boolean =>
  id.startsWith(COMPONENT_SCRIPT_ID_PREFIX);

/**
 * True when `scripts` holds at least one page-owned entry (a `server_script_*`
 * id staged from a page). The component manifest exists exactly for such
 * releases: a server or stream script that runs is what can return a
 * component tag (prompt 157, D1).
 */
export const sidecarHasPageEntries = (
  scripts: Record<string, unknown> | undefined | null,
): boolean =>
  Boolean(scripts) &&
  Object.keys(scripts as Record<string, unknown>).some(
    (id) => !isComponentScriptId(id),
  );

export interface SidecarLoadResult {
  /** Whether a sidecar file was present at the resolved path. */
  present: boolean;
  /** Every script entry registered from the sidecar (empty when present but script-less, or when absent). */
  scripts: Record<string, ServerScriptEntry>;
}

class ServerSidecarRegistry {
  private scripts = new Map<string, ServerScriptEntry>();
  private loadedSidecar: Record<string, ServerScriptEntry> | null = null;
  /**
   * Distinguishes "no sidecar file" (a genuinely static release, always
   * consistent) from "sidecar present and validated" (whose required entries
   * the production boot boundary checks against placeholder references).
   */
  private sidecarPresent = false;

  /**
   * `true` once a sidecar file was parsed and validated. `false` when no sidecar
   * has been loaded (a static release without server scripts) or after `clear()`.
   */
  isSidecarPresent(): boolean {
    return this.sidecarPresent;
  }

  recordScript(
    id: string,
    source: string,
    modulePath?: string,
    sourceFile?: string,
    sourceLine?: number,
    mode: ServerScriptMode = "server",
    sourceColumn?: number,
    outputScope?: string,
  ): void {
    this.scripts.set(id, {
      id,
      mode,
      source,
      modulePath,
      sourceFile,
      sourceLine,
      sourceColumn,
      ...(outputScope !== undefined ? { outputScope } : {}),
    });
  }

  recordScripts(scripts: Record<string, ServerScriptEntry>): void {
    for (const [id, entry] of Object.entries(scripts)) {
      this.scripts.set(id, { ...entry, mode: entry.mode ?? "server" });
    }
  }

  getScript(id: string): ServerScriptEntry | undefined {
    if (this.loadedSidecar && this.loadedSidecar[id]) {
      return this.loadedSidecar[id];
    }
    return this.scripts.get(id);
  }

  getAllScripts(): Record<string, ServerScriptEntry> {
    const result: Record<string, ServerScriptEntry> = {};
    for (const [id, entry] of this.scripts.entries()) {
      result[id] = entry;
    }
    return result;
  }

  clear(): void {
    this.scripts.clear();
    this.loadedSidecar = null;
    this.sidecarPresent = false;
  }

  async loadSidecar(sidecarPath?: string): Promise<SidecarLoadResult> {
    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const targetPath =
      sidecarPath ?? join(outDir, ".bascik", "server-scripts.json");
    let parsed: ServerScriptsSidecar;
    try {
      const content = await readFile(targetPath, "utf8");
      parsed = JSON.parse(content) as ServerScriptsSidecar;
    } catch (err) {
      this.loadedSidecar = null;
      this.sidecarPresent = false;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Optional sidecar: a static release with no server scripts is valid.
        return { present: false, scripts: {} };
      }
      throw new Error(
        `[bascik] --server: Failed to load server scripts sidecar from ${targetPath}: ${(err as Error).message}`,
      );
    }
    const scriptsRaw = parsed.scripts ?? {};
    if (
      typeof scriptsRaw !== "object" ||
      scriptsRaw === null ||
      Array.isArray(scriptsRaw)
    ) {
      this.loadedSidecar = null;
      this.sidecarPresent = false;
      throw new Error(
        `[bascik] --server: server scripts sidecar at ${targetPath} has a malformed "scripts" member. ` +
          `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
      );
    }
    // Schema incompatibility: an unknown version means the runtime and the
    // sidecar disagree about the entry contract.
    if (
      parsed.schema !== undefined &&
      parsed.schema !== SIDECAR_SCHEMA_VERSION
    ) {
      this.loadedSidecar = null;
      this.sidecarPresent = false;
      throw new Error(
        `[bascik] --server: server scripts sidecar at ${targetPath} uses schema ${parsed.schema}, ` +
          `but this runtime understands schema ${SIDECAR_SCHEMA_VERSION}. ` +
          `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
      );
    }
    const scripts = scriptsRaw as Record<string, ServerScriptEntry>;
    // Every entry must carry its mode; a sidecar written before `mode`
    // existed cannot tell a buffered script from a streamed one.
    for (const [id, entry] of Object.entries(scripts)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        this.loadedSidecar = null;
        this.sidecarPresent = false;
        throw new Error(
          `[bascik] --server: server scripts sidecar at ${targetPath} has a null or malformed entry "${id}". ` +
            `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
        );
      }
      if (entry.mode !== "server" && entry.mode !== "stream") {
        this.loadedSidecar = null;
        this.sidecarPresent = false;
        throw new Error(
          `[bascik] --server: server scripts sidecar at ${targetPath} is stale (entry "${id}" has no mode). ` +
            `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
        );
      }
    }
    this.loadedSidecar = scripts;
    this.sidecarPresent = true;
    return { present: true, scripts };
  }

  async writeSidecar(version: string = "unknown"): Promise<string | null> {
    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const sidecarPath = join(outDir, ".bascik", "server-scripts.json");

    // Even if no scripts were registered, if server-scripts.json exists or is requested, we write the sidecar
    if (this.scripts.size === 0) {
      return null;
    }

    await mkdir(dirname(sidecarPath), { recursive: true });

    const sortedKeys = Array.from(this.scripts.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const scripts: Record<string, ServerScriptEntry> = {};
    for (const key of sortedKeys) {
      scripts[key] = this.scripts.get(key)!;
    }

    const sidecar: ServerScriptsSidecar = {
      version,
      schema: SIDECAR_SCHEMA_VERSION,
      scripts,
    };

    const content = JSON.stringify(sidecar, null, 2);
    await writeFile(sidecarPath, content, "utf8");
    return sidecarPath;
  }
}

export const serverSidecarRegistry = new ServerSidecarRegistry();

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const STREAM_ATTR_RE = new RegExp(String.raw`\s${STREAM_ATTR_NAME}`, "i");

/**
 * Replace every `<script data-bascik-server>` and `<script data-bascik-stream>`
 * tag in `html` with an inert placeholder and record each script's source and
 * mode in the serverSidecarRegistry (and the optional `outMap`). `mintId`
 * names the entry for the N-th script found; `defaultSourceFile` names the
 * file when the tag carries no `data-bascik-source-file` stamp.
 */
const extractScriptsToSidecar = (
  html: string,
  mintId: (ordinal: number) => string,
  outMap: Record<string, ServerScriptEntry> | undefined,
  defaultSourceFile: string | undefined,
  recordInRegistry = true,
): string => {
  let scriptOrdinal = 0;
  // Whole-attribute-name boundary: a placeholder's `data-bascik-server-id` must
  // never re-match, or re-running this over placeholdered HTML would record the
  // empty placeholder body over the real source.
  // `scanRequestScripts` finds the matches of
  // `<script\b((?:[^>"']|"[^"]*"|'[^']*')*\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)${SCRIPT_END_TAG}`
  // (flags `gi`) in linear time; the regex took cubic time.
  const replace = (
    match: string,
    openAttrs: string,
    scriptContent: string,
  ): string => {
    // A stream placeholder legitimately carries `data-bascik-stream` as a
    // mode marker. It is already extracted; leave it alone.
    if (/type=["']text\/bascik-server["']/i.test(`<script${openAttrs}>`))
      return match;
    scriptOrdinal++;
    const id = mintId(scriptOrdinal);
    const openTag = `<script${openAttrs}>`;
    const mode: ServerScriptMode = STREAM_ATTR_RE.test(openTag)
      ? "stream"
      : "server";
    const srcPath = getHtmlAttributeValue(openTag, "src");
    const annotatedSourceFile = getHtmlAttributeValue(
      openTag,
      "data-bascik-source-file",
    );
    const scriptSourceFile = annotatedSourceFile
      ? decodeURIComponent(annotatedSourceFile)
      : defaultSourceFile;
    const annotatedSourceLine = getHtmlAttributeValue(
      openTag,
      "data-bascik-source-line",
    );
    const sourceLine = annotatedSourceLine
      ? Number.parseInt(annotatedSourceLine, 10)
      : undefined;
    const sourceColumn = directiveSourceColumn(openTag);
    // The component's output scope travels with the entry, never with the
    // placeholder: the emitted page is unchanged and the runner reads it
    // from the sidecar when it splices the script's output in.
    const outputScope =
      getHtmlAttributeValue(openTag, OUTPUT_SCOPE_ATTRIBUTE) ?? undefined;
    if (recordInRegistry)
      serverSidecarRegistry.recordScript(
        id,
        scriptContent,
        srcPath,
        scriptSourceFile,
        sourceLine,
        mode,
        sourceColumn,
        outputScope,
      );
    if (outMap) {
      outMap[id] = {
        id,
        mode,
        source: scriptContent,
        modulePath: srcPath,
        sourceFile: scriptSourceFile,
        sourceLine,
        ...(sourceColumn !== undefined ? { sourceColumn } : {}),
        ...(outputScope !== undefined ? { outputScope } : {}),
      };
    }
    const marker = mode === "stream" ? " data-bascik-stream" : "";
    return `<script type="text/bascik-server" data-bascik-server-id="${id}"${marker}></script>`;
  };
  return replaceSpans(html, scanRequestScripts(html, false), (match, found) =>
    replace(
      match,
      html.slice(found.start + 7, found.contentStart - 1),
      html.slice(found.contentStart, found.contentEnd),
    ),
  );
};

/**
 * Replace all <script data-bascik-server> and <script data-bascik-stream> tags
 * in `html` with inert placeholders and record each script's source and mode
 * in the serverSidecarRegistry (and optional outMap). Stream placeholders carry
 * a `data-bascik-stream` marker so the mode is recoverable from the HTML alone;
 * the sidecar entry remains the source of truth and the marker is a
 * consistency check.
 */
export const extractServerScriptsToSidecar = (
  html: string,
  pagePath: string = "page",
  outMap?: Record<string, ServerScriptEntry>,
  sourceFile?: string,
): string =>
  extractScriptsToSidecar(
    html,
    (ordinal) =>
      `server_script_${Buffer.from(`${pagePath}::${ordinal}`).toString("hex")}`,
    outMap,
    sourceFile,
  );

/**
 * The same extraction for a component's scoping template (prompt 157): the
 * N-th server or stream script of component `componentName` is staged once
 * as `component_script_<hex(name::ordinal)>`, so a request-time render of the
 * component resolves its placeholder through the sidecar like a page does.
 * The source file and line come from the template's directive stamps.
 * With `record: false` the entries go into `outMap` only, for a caller that
 * records them once it knows they are wanted.
 */
export const extractComponentScriptsToSidecar = (
  template: string,
  componentName: string,
  outMap?: Record<string, ServerScriptEntry>,
  { record = true }: { record?: boolean } = {},
): string =>
  extractScriptsToSidecar(
    template,
    (ordinal) =>
      `${COMPONENT_SCRIPT_ID_PREFIX}${Buffer.from(`${componentName}::${ordinal}`).toString("hex")}`,
    outMap,
    undefined,
    record,
  );
