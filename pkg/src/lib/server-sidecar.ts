import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { SERVER_ATTR_NAME, STREAM_ATTR_NAME, getHtmlAttributeValue } from "./html-patterns.ts";

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
  sourceLine?: number;
}

export interface ServerScriptsSidecar {
  version: string;
  /**
   * Sidecar schema version. Bumped when `mode` was added; older sidecars
   * without it are rejected with a rebuild message.
   */
  schema?: number;
  scripts: Record<string, ServerScriptEntry>;
}

export const SIDECAR_SCHEMA_VERSION = 2;

class ServerSidecarRegistry {
  private scripts = new Map<string, ServerScriptEntry>();
  private loadedSidecar: Record<string, ServerScriptEntry> | null = null;

  recordScript(
    id: string,
    source: string,
    modulePath?: string,
    sourceFile?: string,
    sourceLine?: number,
    mode: ServerScriptMode = "server",
  ): void {
    this.scripts.set(id, { id, mode, source, modulePath, sourceFile, sourceLine });
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
  }

  async loadSidecar(sidecarPath?: string): Promise<void> {
    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const targetPath = sidecarPath ?? join(outDir, ".bascik", "server-scripts.json");
    let parsed: ServerScriptsSidecar;
    try {
      const content = await readFile(targetPath, "utf8");
      parsed = JSON.parse(content) as ServerScriptsSidecar;
    } catch (err) {
      this.loadedSidecar = null;
      throw new Error(
        `[bascik] --server: Failed to load server scripts sidecar from ${targetPath}: ${(err as Error).message}`,
      );
    }
    const scripts = parsed.scripts ?? {};
    // Every entry must carry its mode; a sidecar written before `mode`
    // existed cannot tell a buffered script from a streamed one.
    const missingMode = Object.values(scripts).find((entry) => entry.mode !== "server" && entry.mode !== "stream");
    if (missingMode) {
      this.loadedSidecar = null;
      throw new Error(
        `[bascik] --server: server scripts sidecar at ${targetPath} is stale (entry "${missingMode.id}" has no mode). ` +
        `Run \`bascik --build\` to regenerate dist/.bascik/server-scripts.json.`,
      );
    }
    this.loadedSidecar = scripts;
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
): string => {
  let scriptOrdinal = 0;
  // Whole-attribute-name boundary: a placeholder's `data-bascik-server-id` must
  // never re-match, or re-running this over placeholdered HTML would record the
  // empty placeholder body over the real source.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const serverScriptRe = new RegExp(
    String.raw`<script\b((?:[^>"']|"[^"]*"|'[^']*')*\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>`,
    "gi",
  );
  return html.replace(
    serverScriptRe,
    (match: string, openAttrs: string, scriptContent: string) => {
      // A stream placeholder legitimately carries `data-bascik-stream` as a
      // mode marker. It is already extracted; leave it alone.
      if (/type=["']text\/bascik-server["']/i.test(`<script${openAttrs}>`)) return match;
      scriptOrdinal++;
      const id = `server_script_${Buffer.from(`${pagePath}::${scriptOrdinal}`).toString("hex")}`;
      const openTag = `<script${openAttrs}>`;
      const mode: ServerScriptMode = STREAM_ATTR_RE.test(openTag) ? "stream" : "server";
      const srcPath = getHtmlAttributeValue(openTag, "src");
      const annotatedSourceFile = getHtmlAttributeValue(openTag, "data-bascik-source-file");
      const scriptSourceFile = annotatedSourceFile
        ? decodeURIComponent(annotatedSourceFile)
        : sourceFile;
      const annotatedSourceLine = getHtmlAttributeValue(openTag, "data-bascik-source-line");
      const sourceLine = annotatedSourceLine ? Number.parseInt(annotatedSourceLine, 10) : undefined;
      serverSidecarRegistry.recordScript(id, scriptContent, srcPath, scriptSourceFile, sourceLine, mode);
      if (outMap) {
        outMap[id] = {
          id,
          mode,
          source: scriptContent,
          modulePath: srcPath,
          sourceFile: scriptSourceFile,
          sourceLine,
        };
      }
      const marker = mode === "stream" ? " data-bascik-stream" : "";
      return `<script type="text/bascik-server" data-bascik-server-id="${id}"${marker}></script>`;
    },
  );
};
