import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";

export interface PageCspHashes {
  scripts: string[];
  styles: string[];
}

export type CspHashesManifest = Record<string, PageCspHashes>;

class CspHashCollector {
  private pageHashes = new Map<string, { scripts: Set<string>; styles: Set<string> }>();

  recordPage(pageUrlPath: string, emittedHtml: string): void {
    const scripts = new Set<string>();
    const styles = new Set<string>();

    // Collect inline script hashes
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRegex.exec(emittedHtml)) !== null) {
      const openTag = match[1];
      const body = match[2];

      // Exclude external scripts (<script src="...">)
      if (/\bsrc\s*=/i.test(openTag)) continue;

      // Exclude non-executable / placeholder types (such as text/bascik-server)
      const typeMatch = openTag.match(/\btype\s*=\s*["']?([^"'\s>]+)["']?/i);
      if (typeMatch) {
        const typeVal = typeMatch[1].toLowerCase();
        if (typeVal === "text/bascik-server") {
          continue;
        }
      }

      const hash = `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;
      scripts.add(hash);
    }

    // Collect inline style hashes
    const styleRegex = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
    while ((match = styleRegex.exec(emittedHtml)) !== null) {
      const body = match[2];
      const hash = `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;
      styles.add(hash);
    }

    this.pageHashes.set(pageUrlPath, { scripts, styles });
  }

  getManifest(): CspHashesManifest {
    const sortedPageKeys = Array.from(this.pageHashes.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result: CspHashesManifest = {};
    for (const key of sortedPageKeys) {
      const { scripts, styles } = this.pageHashes.get(key)!;
      result[key] = {
        scripts: Array.from(scripts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        styles: Array.from(styles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      };
    }
    return result;
  }

  clear(): void {
    this.pageHashes.clear();
  }

  async writeCspHashes(): Promise<string | null> {
    if (!BascikConfig.generate?.cspHashes) {
      return null;
    }

    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const cspPath = join(outDir, ".bascik", "csp-hashes.json");
    await mkdir(dirname(cspPath), { recursive: true });

    const manifest = this.getManifest();
    const content = JSON.stringify(manifest, null, 2);
    await writeFile(cspPath, content, "utf8");
    return cspPath;
  }
}

export const cspHashCollector = new CspHashCollector();
