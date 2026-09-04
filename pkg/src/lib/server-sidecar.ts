import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { SERVER_ATTR_NAME, getHtmlAttributeValue } from "./html-patterns.ts";

export interface ServerScriptEntry {
  id: string;
  source: string;
  modulePath?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface ServerScriptsSidecar {
  version: string;
  scripts: Record<string, ServerScriptEntry>;
}

class ServerSidecarRegistry {
  private scripts = new Map<string, ServerScriptEntry>();
  private loadedSidecar: Record<string, ServerScriptEntry> | null = null;

  recordScript(
    id: string,
    source: string,
    modulePath?: string,
    sourceFile?: string,
    sourceLine?: number,
  ): void {
    this.scripts.set(id, { id, source, modulePath, sourceFile, sourceLine });
  }

  recordScripts(scripts: Record<string, ServerScriptEntry>): void {
    for (const [id, entry] of Object.entries(scripts)) {
      this.scripts.set(id, entry);
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
    try {
      const content = await readFile(targetPath, "utf8");
      const parsed = JSON.parse(content) as ServerScriptsSidecar;
      this.loadedSidecar = parsed.scripts ?? {};
    } catch (err) {
      this.loadedSidecar = null;
      throw new Error(
        `[bascik] --server: Failed to load server scripts sidecar from ${targetPath}: ${(err as Error).message}`,
      );
    }
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
      scripts,
    };

    const content = JSON.stringify(sidecar, null, 2);
    await writeFile(sidecarPath, content, "utf8");
    return sidecarPath;
  }
}

export const serverSidecarRegistry = new ServerSidecarRegistry();

/**
 * Replace all <script data-bascik-server> tags in `html` with inert placeholders
 * and record each script's source in the serverSidecarRegistry (and optional outMap).
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
    String.raw`<script\b((?:[^>"']|"[^"]*"|'[^']*')*\s${SERVER_ATTR_NAME}(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>`,
    "gi",
  );
  return html.replace(
    serverScriptRe,
    (_match, openAttrs, scriptContent) => {
      scriptOrdinal++;
      const id = `server_script_${Buffer.from(`${pagePath}::${scriptOrdinal}`).toString("hex")}`;
      const openTag = `<script${openAttrs}>`;
      const srcPath = getHtmlAttributeValue(openTag, "src");
      const annotatedSourceFile = getHtmlAttributeValue(openTag, "data-bascik-source-file");
      const scriptSourceFile = annotatedSourceFile
        ? decodeURIComponent(annotatedSourceFile)
        : sourceFile;
      const annotatedSourceLine = getHtmlAttributeValue(openTag, "data-bascik-source-line");
      const sourceLine = annotatedSourceLine ? Number.parseInt(annotatedSourceLine, 10) : undefined;
      serverSidecarRegistry.recordScript(id, scriptContent, srcPath, scriptSourceFile, sourceLine);
      if (outMap) {
        outMap[id] = {
          id,
          source: scriptContent,
          modulePath: srcPath,
          sourceFile: scriptSourceFile,
          sourceLine,
        };
      }
      return `<script type="text/bascik-server" data-bascik-server-id="${id}"></script>`;
    },
  );
};
