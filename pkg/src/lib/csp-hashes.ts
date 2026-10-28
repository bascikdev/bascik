import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { readStartTagAttributes, scanHtml } from "./html-scanner.ts";
import {
  scanAlternatives,
  scanElementContents,
  type ElementScanOptions,
} from "./element-content-scan.ts";
import type { PageCspHashes } from "./types.ts";

export type CspHashesManifest = Record<string, PageCspHashes>;

const sortHashes = (hashes: Iterable<string>): string[] =>
  Array.from(new Set(hashes)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Add `component` hashes to the entries of `routes` (prompt 157, D5). A page
 * whose server or stream script may return a component tag can render any
 * manifest component at request time, so its route lists every CSP-stable
 * component style hash and first-instance script hash in its own entry; no
 * new section. A named route without an entry gets one. Pure: returns a new
 * manifest, deduplicated and sorted like the collector's output.
 */
export const widenRouteCspHashes = (
  manifest: CspHashesManifest,
  routes: Iterable<string>,
  component: PageCspHashes,
): CspHashesManifest => {
  const widened: CspHashesManifest = { ...manifest };
  for (const route of routes) {
    const own = manifest[route] ?? { scripts: [], styles: [] };
    widened[route] = {
      scripts: sortHashes([...own.scripts, ...component.scripts]),
      styles: sortHashes([...own.styles, ...component.styles]),
    };
  }
  return widened;
};

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
  // The tokenizer finds scripts and styles in document order, so a `<!--`,
  // `<textarea>`, or `<title>` inside a script body stays JavaScript. Where it
  // cannot follow the browser it stops, and the rest of the page is scanned
  // with the regex fallback below, which can only add hashes.
  let pendingStyleBodyStart = -1;
  const { stoppedAt } = scanHtml(emittedHtml, {
    script: (script) => {
      if (!script.terminated) return;
      const attributes = readStartTagAttributes(emittedHtml, script.start);
      if (attributes.some((attribute) => attribute.name === "src")) return;
      const type = attributes
        .find((attribute) => attribute.name === "type")
        ?.value.trim()
        .toLowerCase();
      if (type === "text/bascik-server") return;
      const endTagStart = emittedHtml.lastIndexOf("</", script.end - 1);
      if (endTagStart < script.openTagEnd) return;
      scripts.add(
        sha256Source(emittedHtml.slice(script.openTagEnd, endTagStart)),
      );
    },
    token: (token) => {
      if (token.kind !== "tag" || token.name !== "style") return;
      if (!token.isEndTag) {
        // `<style/>` closes itself only in SVG and MathML; it has no body there.
        const selfClosing =
          token.inForeign && emittedHtml.charCodeAt(token.end - 2) === 0x2f;
        pendingStyleBodyStart = selfClosing ? -1 : token.end;
        return;
      }
      if (pendingStyleBodyStart === -1) return;
      styles.add(
        sha256Source(emittedHtml.slice(pendingStyleBodyStart, token.start)),
      );
      pendingStyleBodyStart = -1;
    },
  });
  if (stoppedAt < emittedHtml.length) {
    const rest = scanWithRegexFallback(emittedHtml.slice(stoppedAt));
    for (const hash of rest.scripts) scripts.add(hash);
    for (const hash of rest.styles) styles.add(hash);
  }
  return {
    scripts: Array.from(scripts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    styles: Array.from(styles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
};

/** `<name\b...>` elements closed the way browsers close them (see `ElementScanOptions`). */
const RAW_ELEMENT_SCAN: ElementScanOptions = {
  opener: "word-boundary",
  closer: "attributes",
};

const sha256Source = (body: string): string =>
  `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;

/**
 * Regex scan for the part of a page the tokenizer could not follow. It errs
 * toward hashing more: an extra hash permits nothing the page does not
 * contain, while a missing one blocks a script.
 */
const scanWithRegexFallback = (
  emittedHtml: string,
): { scripts: Set<string>; styles: Set<string> } => {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const uncommented = emittedHtml.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
    " ".repeat(comment.length),
  );
  // `/<(textarea|title|noscript|xmp)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1(?:[\t\n\f\r /][^>]*)?>)/gi`
  // with each element's content blanked, in linear time.
  let scannable = "";
  let cursor = 0;
  for (const match of scanAlternatives(
    uncommented,
    ["textarea", "title", "noscript", "xmp"].map((name) => ({
      kind: "element" as const,
      name,
      options: RAW_ELEMENT_SCAN,
    })),
  )) {
    scannable += `${uncommented.slice(cursor, match.contentStart)}${" ".repeat(match.contentEnd - match.contentStart)}`;
    cursor = match.contentEnd;
  }
  scannable += uncommented.slice(cursor);

  // Collect inline script hashes
  // End tags follow the HTML raw-text rules (`</script\n>` and `</script/>`
  // close the element), so the hashed body is exactly what the browser hashes.
  // A quoted attribute value may contain `>`, so the open tag is matched
  // quote-aware and the body starts where the browser's does.
  // `/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi`,
  // in linear time.
  const scriptMatches = scanElementContents(
    scannable,
    "script",
    RAW_ELEMENT_SCAN,
  );
  for (const match of scriptMatches) {
    const openTag = scannable.slice(match.start + 7, match.contentStart - 1);
    const body = scannable.slice(match.contentStart, match.contentEnd);

    // Exclude external scripts (<script src="...">). `src` must be a whole
    // attribute name: `data-src` does not make a script external.
    if (/(?:^|\s)src\s*=/i.test(openTag)) continue;

    // Exclude non-executable / placeholder types (such as text/bascik-server)
    const typeMatch = openTag.match(
      /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)["']?/i,
    );
    if (typeMatch) {
      const typeVal = typeMatch[1].toLowerCase();
      if (typeVal === "text/bascik-server") {
        continue;
      }
    }

    const hash = `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;
    scripts.add(hash);
  }

  // Blank script bodies before scanning for <style> so a literal `<style>` inside
  // a JavaScript string literal is never hashed as a stylesheet.
  let styleScannable = "";
  cursor = 0;
  for (const match of scriptMatches) {
    styleScannable += `${scannable.slice(cursor, match.start)}<script${scannable.slice(match.start + 7, match.contentStart)}${" ".repeat(match.contentEnd - match.contentStart)}</script>`;
    cursor = match.end;
  }
  styleScannable += scannable.slice(cursor);

  // Collect inline style hashes
  // `/<style\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/style(?:[\t\n\f\r /][^>]*)?>/gi`,
  // in linear time.
  for (const match of scanElementContents(
    styleScannable,
    "style",
    RAW_ELEMENT_SCAN,
  )) {
    const body = styleScannable.slice(match.contentStart, match.contentEnd);
    const hash = `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;
    styles.add(hash);
  }

  return { scripts, styles };
};

class CspHashCollector {
  private pageHashes = new Map<
    string,
    { scripts: Set<string>; styles: Set<string> }
  >();

  recordPage(pageUrlPath: string, emittedHtml: string): void {
    const { scripts, styles } = computePageCspHashes(emittedHtml);
    this.pageHashes.set(pageUrlPath, {
      scripts: new Set(scripts),
      styles: new Set(styles),
    });
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
        scripts: Array.from(scripts).sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
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

/** The regex fallback scan, for the linear-time tests. */
export const __cspRegexFallbackForTests = scanWithRegexFallback;
