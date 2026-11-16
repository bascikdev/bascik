import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isInlineStylesheet } from "./asset-filter.ts";
import { BascikConfig } from "./config.ts";
import { readStartTagAttributes, scanHtml } from "./html-scanner.ts";

/**
 * A `<link rel="stylesheet">` whose target is a stylesheet that
 * `assets.inlineStyles` inlines into every page. Inlined stylesheets are not
 * copied to the output, so such a link always answers 404.
 */
export interface InlinedStylesheetLink {
  /** The `href` as written. */
  href: string;
  /** Index of the link's `<`. */
  offset: number;
  /** The stylesheet file the `href` points at. */
  filePath: string;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const decodePath = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * The file under `directory.pages` that a stylesheet `href` points at, or
 * undefined for an external URL, a path outside the pages folder, or a
 * relative `href` when `fromFile` is unknown (a component, used by any page).
 * A root-relative `href` may carry the configured `base`, as built output does.
 */
const resolveStylesheetHref = (
  href: string,
  fromFile: string | undefined,
): string | undefined => {
  let path = href.trim().replace(/[?#].*$/s, "");
  if (!path || SCHEME_RE.test(path) || path.startsWith("//")) return undefined;
  path = decodePath(path.replace(/\\/g, "/"));
  const pagesRoot = resolve(process.cwd(), BascikConfig.directory.pages);
  let target: string;
  if (path.startsWith("/")) {
    const rawBase = BascikConfig.base || "/";
    const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
    if (base !== "/" && path.startsWith(base)) {
      path = `/${path.slice(base.length)}`;
    }
    target = join(pagesRoot, path);
  } else {
    if (!fromFile) return undefined;
    target = resolve(dirname(resolve(process.cwd(), fromFile)), path);
  }
  return target.startsWith(pagesRoot + sep) ? target : undefined;
};

const isStylesheetLink = (rel: string | undefined): boolean =>
  rel !== undefined &&
  rel
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .includes("stylesheet");

/**
 * Every `<link rel="stylesheet">` in `html` that points at a stylesheet
 * `assets.inlineStyles` inlines. `fromFile` is the page the markup belongs to,
 * for relative `href` values. Links inside `<template>` and SVG are skipped.
 */
export const findInlinedStylesheetLinks = (
  html: string,
  fromFile?: string,
): InlinedStylesheetLink[] => {
  if (!BascikConfig.assets?.inlineStyles) return [];
  if (!/<link/i.test(html)) return [];
  const found: InlinedStylesheetLink[] = [];
  scanHtml(html, {
    token(token) {
      if (
        token.kind !== "tag" ||
        token.isEndTag ||
        token.name !== "link" ||
        token.inTemplate ||
        token.inForeign
      ) {
        return;
      }
      const attributes = readStartTagAttributes(html, token.start);
      const value = (name: string) =>
        attributes.find((attribute) => attribute.name === name)?.value;
      const href = value("href");
      if (!isStylesheetLink(value("rel")) || href === undefined) return;
      const filePath = resolveStylesheetHref(href, fromFile);
      if (
        filePath === undefined ||
        !filePath.toLowerCase().endsWith(".css") ||
        !isInlineStylesheet(filePath) ||
        !existsSync(filePath)
      ) {
        return;
      }
      found.push({ href, offset: token.start, filePath });
    },
  });
  return found;
};

/** The message for a leftover link, shared by the build warning and `bascik --check`. */
export const inlinedStylesheetLinkMessage = (href: string): string =>
  `<link rel="stylesheet" href="${href}"> points at a stylesheet that assets.inlineStyles inlines into the page. ` +
  `Inlined stylesheets are not copied to the output, so this link answers 404. Remove the <link>.`;
