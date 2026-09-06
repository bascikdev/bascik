import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import type { PageCspHashes } from "./types.ts";

export type CspHashesManifest = Record<string, PageCspHashes>;

/**
 * Pure computation of inline script/style SHA-256 hashes from a page's final
 * emitted HTML. Extracted so the SAME computation can run at the single
 * defined point where the emitted representation exists, regardless of whether
 * the page was transpiled on the main thread or in a worker. The worker
 * computes from its local string BEFORE the bytes are transferred, so the main
 * thread never decodes large HTML purely for bookkeeping.
 */
export const computePageCspHashes = (emittedHtml: string): PageCspHashes => {
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

  return {
    scripts: Array.from(scripts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    styles: Array.from(styles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
};

class CspHashCollector {
  private pageHashes = new Map<string, { scripts: Set<string>; styles: Set<string> }>();

  recordPage(pageUrlPath: string, emittedHtml: string): void {
    const { scripts, styles } = computePageCspHashes(emittedHtml);
    this.pageHashes.set(pageUrlPath, { scripts: new Set(scripts), styles: new Set(styles) });
  }

  /**
   * Record precomputed hashes. The main thread uses this after a worker
   * returns the hashes it computed from its local emitted HTML, so nothing on
   * the main thread re-decodes the page purely for CSP bookkeeping.
   */
  recordComputed(pageUrlPath: string, hashes: PageCspHashes): void {
    this.pageHashes.set(pageUrlPath, {
      scripts: new Set(hashes.scripts),
      styles: new Set(hashes.styles),
    });
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

    // Prompt 101: the collector writes exactly what THIS process recorded. The
    // ownership reconciliation (preserve-and-prune in fresh targeted builds)
    // lives in `lib/ownership.ts` and is the single merge owner.
    const currentManifest = this.getManifest();

    const content = JSON.stringify(currentManifest, null, 2);
    await writeFile(cspPath, content, "utf8");
    return cspPath;
  }
}

export const cspHashCollector = new CspHashCollector();
