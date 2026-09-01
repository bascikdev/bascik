import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";

export interface ServerScriptEntry {
  id: string;
  source: string;
}

export interface ServerScriptsSidecar {
  version: string;
  scripts: Record<string, ServerScriptEntry>;
}

class ServerSidecarRegistry {
  private scripts = new Map<string, ServerScriptEntry>();
  private loadedSidecar: Record<string, ServerScriptEntry> | null = null;

  recordScript(id: string, source: string): void {
    this.scripts.set(id, { id, source });
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
 * and record each script's source in the serverSidecarRegistry.
 */
export const extractServerScriptsToSidecar = (
  html: string,
  pagePath: string = "page",
): string => {
  let scriptOrdinal = 0;
  return html.replace(
    /<script\b((?:[^>"']|"[^"]*"|'[^']*')*\sdata-bascik-server\b(?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi,
    (_match, _openAttrs, scriptContent) => {
      scriptOrdinal++;
      const id = `server_script_${Buffer.from(`${pagePath}::${scriptOrdinal}`).toString("hex")}`;
      serverSidecarRegistry.recordScript(id, scriptContent);
      return `<script type="text/bascik-server" data-bascik-server-id="${id}"></script>`;
    },
  );
};
