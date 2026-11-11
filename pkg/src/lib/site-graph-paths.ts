/**
 * @module site-graph-paths
 *
 * The pure SiteGraph helpers `@bascik/bascik/adapter` exports (page
 * aliases, public-file rules, placeholder splitting). Kept apart from
 * site-graph.ts because that module reads the resolved config, and the
 * adapter entry must not load bascik.config on import (finding 16): the
 * entry imports these statically and site-graph.ts only on first use.
 */

import type { DistPageSegment } from "./adapter-contract.ts";
import { withBasePath } from "./base-path.ts";
import { createNamedOpenTagScanner } from "./element-content-scan.ts";
import { getHtmlAttributeValue } from "./html-patterns.ts";
import { isPrivatePathname } from "./route-matching.ts";

/**
 * Placeholder detection is split into two linear steps instead of one regex.
 * A single pattern with quote-aware attribute loops on both sides of a
 * literal `type="text/bascik-server"` is ambiguous about which loop consumes
 * a repeated attribute, so it backtracks polynomially on hostile input.
 * The open-tag pattern below has one loop whose alternatives each start with
 * a distinct character class, and the attribute is read afterward.
 */
const isPlaceholderOpenTag = (openTag: string): boolean =>
  getHtmlAttributeValue(openTag, "type")?.toLowerCase() ===
  "text/bascik-server";

const WHITESPACE_CHAR = /\s/;

/**
 * Match a whitespace-only placeholder body followed by a `</script>` end tag,
 * starting exactly at `from`. Returns the index just past the end tag's `>`,
 * or -1. Hand-written instead of a sticky regex so the cost is one forward
 * scan with no backtracking: whitespace, `</script`, then either `>` or a
 * whitespace/`/` character followed by everything up to the next `>`.
 */
const matchPlaceholderEndTag = (html: string, from: number): number => {
  let i = from;
  while (i < html.length && WHITESPACE_CHAR.test(html[i])) i++;
  if (html.slice(i, i + 8).toLowerCase() !== "</script") return -1;
  i += 8;
  if (html[i] === ">") return i + 1;
  if (i >= html.length || (html[i] !== "/" && !WHITESPACE_CHAR.test(html[i])))
    return -1;
  const close = html.indexOf(">", i + 1);
  return close === -1 ? -1 : close + 1;
};

/** Split built placeholder HTML into static text and script ids, in document order. */
export const splitDistPageIntoSegments = (
  html: string,
): { segments: DistPageSegment[]; scriptIds: string[] } => {
  const segments: DistPageSegment[] = [];
  const scriptIds: string[] = [];
  let cursor = 0;
  // The script open tags `/<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>/gi`
  // finds, in linear time.
  const openTags = createNamedOpenTagScanner(html, "script");
  let searchFrom = 0;
  for (
    let open = openTags.next(searchFrom);
    open !== null;
    open = openTags.next(searchFrom)
  ) {
    searchFrom = open.end;
    const openTag = html.slice(open.start, open.end);
    if (!isPlaceholderOpenTag(openTag)) continue;
    const end = matchPlaceholderEndTag(html, open.end);
    if (end === -1) continue;
    const id = getHtmlAttributeValue(openTag, "data-bascik-server-id");
    if (!id) continue;
    const index = open.start;
    if (index > cursor)
      segments.push({ kind: "static", text: html.slice(cursor, index) });
    segments.push({ kind: "script", id });
    scriptIds.push(id);
    cursor = end;
    searchFrom = cursor;
  }
  if (cursor < html.length || segments.length === 0)
    segments.push({ kind: "static", text: html.slice(cursor) });
  return { segments, scriptIds };
};

/**
 * Every request spelling the Node server resolves to a page: the canonical
 * path, its trailing-slash toggle, `/index`, and `.html` forms.
 */
export const pageAliasesFor = (httpPath: string, base: string): string[] => {
  const aliases: string[] = [];
  const push = (p: string) => {
    const withBase = withBasePath(p, base);
    if (!aliases.includes(withBase)) aliases.push(withBase);
  };
  push(httpPath);
  if (httpPath === "/") {
    if (base !== "/") aliases.push(base.replace(/\/$/, ""));
    push("/index");
    push("/index.html");
  } else if (httpPath.endsWith("/")) {
    push(httpPath.slice(0, -1));
    push(`${httpPath}index`);
    push(`${httpPath}index.html`);
  } else {
    push(`${httpPath}/`);
    push(`${httpPath}.html`);
  }
  return aliases;
};

/**
 * Whether a dist-relative path may be uploaded as a public static file.
 * `hideDotfiles` is `security.hideDotfiles`: off, dotfiles deploy, but
 * `.bascik/`, source maps and precompressed siblings never do.
 */
export const isPublicAssetPath = (
  distRelativePath: string,
  hideDotfiles = true,
): boolean => {
  const normalized = distRelativePath.replace(/\\/g, "/");
  if (isPrivatePathname(normalized, "/", hideDotfiles)) return false;
  if (normalized.endsWith(".map")) return false;
  if (/\.(br|gz)$/i.test(normalized) || /\.bmeta$/i.test(normalized))
    return false;
  return true;
};

/** Authored public files that would shadow control files or static API routes. */
export const detectPublicCollisions = (input: {
  publicPaths: string[];
  apiRoutePaths: string[];
  controlFiles: string[];
}): string[] => {
  const problems: string[] = [];
  const control = new Set(input.controlFiles);
  for (const path of [...input.publicPaths].sort()) {
    if (control.has(path)) {
      problems.push(
        `[bascik] --target: authored file "${path}" collides with a generated control file. Rename it or remove it from directory.pages.`,
      );
    }
  }
  const staticApi = new Set(
    input.apiRoutePaths
      .filter((p) => !p.includes("["))
      .map((p) => p.replace(/^\/+/, "")),
  );
  for (const path of input.publicPaths) {
    const withoutExt = path.replace(/\.[a-zA-Z0-9]+$/, "");
    if (staticApi.has(path) || staticApi.has(withoutExt)) {
      problems.push(
        `[bascik] --target: public file "${path}" shadows API route "/${path.replace(/\.[a-zA-Z0-9]+$/, "")}".`,
      );
    }
  }
  return problems;
};
