import {
  scanElementContents,
  scanOpeningTags,
} from "./element-content-scan.ts";
import { createContentShield, shieldElementContents } from "./shielding.ts";
import { trimTrailingSlashes } from "./slashes.ts";

const URL_ATTRIBUTES = new Set([
  "action",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
]);

const SRCSET_ATTRIBUTES = new Set(["imagesrcset", "srcset"]);
const URL_META_PROPERTIES = new Set(["og:image", "og:url", "twitter:image"]);
const joinBasePath = (value: string, base: string): string =>
  `${base}${value.slice(1)}`;

export const shouldRewriteBasePath = (value: string, base: string): boolean =>
  base !== "/" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.startsWith(base);

export const withBasePath = (value: string, base: string): string =>
  shouldRewriteBasePath(value, base) ? joinBasePath(value, base) : value;

export const stripBasePath = (
  pathname: string,
  base: string,
): string | null => {
  if (base === "/") return pathname;
  const prefix = base.slice(0, -1);
  if (pathname === prefix || pathname === base) return "/";
  return pathname.startsWith(base) ? pathname.slice(prefix.length) : null;
};

export const composeSiteUrl = (
  siteUrl: string,
  base: string,
  pathname: string,
): string => {
  const normalizedSiteUrl = trimTrailingSlashes(siteUrl);
  const normalizedPathname = pathname.startsWith("/")
    ? pathname
    : `/${pathname}`;
  return `${normalizedSiteUrl}${withBasePath(normalizedPathname, base)}`;
};

export const rewriteSrcsetBasePaths = (
  srcset: string,
  base: string,
): string => {
  if (base === "/") return srcset;

  let result = "";
  let position = 0;
  while (position < srcset.length) {
    const whitespaceStart = position;
    while (/\s/.test(srcset[position] ?? "")) position++;
    result += srcset.slice(whitespaceStart, position);
    if (position >= srcset.length) break;

    if (srcset[position] === ",") {
      result += srcset[position++];
      continue;
    }

    const urlStart = position;
    const isDataUrl =
      srcset.slice(position, position + 5).toLowerCase() === "data:";
    while (
      position < srcset.length &&
      !/\s/.test(srcset[position]) &&
      (isDataUrl || srcset[position] !== ",")
    ) {
      position++;
    }
    result += withBasePath(srcset.slice(urlStart, position), base);

    const descriptorStart = position;
    while (position < srcset.length && srcset[position] !== ",") position++;
    result += srcset.slice(descriptorStart, position);
    if (srcset[position] === ",") result += srcset[position++];
  }
  return result;
};

const rewriteImageSetContents = (contents: string, base: string): string =>
  contents.replace(
    /(["'])(\/[^"']*)\1/g,
    (match, quote: string, value: string) =>
      shouldRewriteBasePath(value, base)
        ? `${quote}${joinBasePath(value, base)}${quote}`
        : match,
  );

const rewriteImageSetFunctions = (css: string, base: string): string => {
  const imageSetPattern = /(?:-webkit-)?image-set\(/gi;
  let result = "";
  let lastIndex = 0;

  while (imageSetPattern.exec(css) !== null) {
    let position = imageSetPattern.lastIndex;
    let depth = 1;
    let quote = "";
    while (position < css.length && depth > 0) {
      const character = css[position];
      if (quote) {
        if (character === "\\") position++;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth++;
      } else if (character === ")") {
        depth--;
      }
      position++;
    }
    if (depth !== 0) break;

    result += css.slice(lastIndex, imageSetPattern.lastIndex);
    result += rewriteImageSetContents(
      css.slice(imageSetPattern.lastIndex, position - 1),
      base,
    );
    result += ")";
    lastIndex = position;
    imageSetPattern.lastIndex = position;
  }

  return lastIndex === 0 ? css : result + css.slice(lastIndex);
};

export const rewriteCssBasePaths = (css: string, base: string): string => {
  if (base === "/") return css;

  let result = css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/gi,
    (
      match,
      doubleValue: string | undefined,
      singleValue: string | undefined,
      unquotedValue: string | undefined,
    ) => {
      const value = doubleValue ?? singleValue ?? unquotedValue ?? "";
      const quote =
        doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : "";
      return shouldRewriteBasePath(value, base)
        ? `url(${quote}${joinBasePath(value, base)}${quote})`
        : match;
    },
  );
  result = result.replace(
    /(@import\s+)(["'])([^"']+)\2/gi,
    (match, prefix: string, quote: string, value: string) =>
      shouldRewriteBasePath(value, base)
        ? `${prefix}${quote}${joinBasePath(value, base)}${quote}`
        : match,
  );
  return rewriteImageSetFunctions(result, base);
};

const getAttributeValue = (
  tag: string,
  attribute: string,
): string | undefined => {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const pattern = new RegExp(
    `\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+?))(?=\\s|\\/>|>|$)`,
    "i",
  );
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};

const rewriteTagAttributes = (tag: string, base: string): string => {
  const tagName = /^<\s*([a-zA-Z][\w:-]*)/.exec(tag)?.[1].toLowerCase() ?? "";
  const metaProperty =
    tagName === "meta"
      ? (
          getAttributeValue(tag, "property") ?? getAttributeValue(tag, "name")
        )?.toLowerCase()
      : undefined;

  // In document order, so the attribute matches below (also in order) check
  // them with one forward pointer instead of a search per match.
  const stringRanges: Array<{ start: number; end: number }> = [];
  let scanIdx = 0;
  let strChar: string | null = null;
  let strStart = -1;
  while (scanIdx < tag.length) {
    if (strChar) {
      if (tag[scanIdx] === strChar) {
        stringRanges.push({ start: strStart, end: scanIdx });
        strChar = null;
      }
    } else if (tag[scanIdx] === '"' || tag[scanIdx] === "'") {
      strChar = tag[scanIdx];
      strStart = scanIdx;
    }
    scanIdx++;
  }

  let range = 0;
  return tag.replace(
    /\s([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+?))(?=\s|\/>|>|$)/g,
    (
      match,
      rawName: string,
      _rawValue: string,
      doubleValue: string | undefined,
      singleValue: string | undefined,
      unquotedValue: string | undefined,
      offset: number,
    ) => {
      while (range < stringRanges.length && stringRanges[range].end <= offset)
        range++;
      if (range < stringRanges.length && offset > stringRanges[range].start)
        return match;
      const name = rawName.toLowerCase();
      const value = doubleValue ?? singleValue ?? unquotedValue ?? "";
      let rewritten = value;

      if (URL_ATTRIBUTES.has(name)) {
        rewritten = withBasePath(value, base);
      } else if (SRCSET_ATTRIBUTES.has(name)) {
        rewritten = rewriteSrcsetBasePaths(value, base);
      } else if (name === "style") {
        rewritten = rewriteCssBasePaths(value, base);
      } else if (
        name === "content" &&
        metaProperty &&
        URL_META_PROPERTIES.has(metaProperty)
      ) {
        rewritten = withBasePath(value, base);
      }

      if (rewritten === value) return match;
      const quote =
        doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : "";
      return ` ${rawName}=${quote}${rewritten}${quote}`;
    },
  );
};

export const rewriteHtmlBasePaths = (html: string, base: string): string => {
  if (base === "/") return html;

  const commentShield = createContentShield(html);
  const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
    commentShield.hide(comment),
  );
  // Since request-time rendering, each expanded usage is rebased on every
  // request and can carry visitor text, so the stylesheet and opening-tag
  // searches are linear scans. They find what
  // /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)/gi
  // and /<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g
  // found; those regexes were quadratic on openers that cannot reach a `>`.
  let withCss = "";
  let cursor = 0;
  for (const style of scanElementContents(withoutComments, "style", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    withCss +=
      withoutComments.slice(cursor, style.start) +
      rewriteTagAttributes(
        withoutComments.slice(style.start, style.contentStart),
        base,
      ) +
      rewriteCssBasePaths(
        withoutComments.slice(style.contentStart, style.contentEnd),
        base,
      );
    cursor = style.contentEnd;
  }
  withCss += withoutComments.slice(cursor);
  const shielded = shieldElementContents(withCss, [
    "script",
    "style",
    "textarea",
    "title",
  ]);
  let rewritten = "";
  cursor = 0;
  for (const [start, end] of scanOpeningTags(shielded.html)) {
    rewritten +=
      shielded.html.slice(cursor, start) +
      rewriteTagAttributes(shielded.html.slice(start, end), base);
    cursor = end;
  }
  rewritten += shielded.html.slice(cursor);
  return commentShield.restore(shielded.restore(rewritten));
};

export const rewriteManifestBasePaths = (
  source: string,
  base: string,
): string => {
  if (base === "/") return source;

  try {
    const manifest = JSON.parse(source) as Record<string, unknown>;
    for (const key of ["start_url", "scope"] as const) {
      if (typeof manifest[key] === "string") {
        manifest[key] = withBasePath(manifest[key], base);
      }
    }
    if (Array.isArray(manifest.icons)) {
      for (const icon of manifest.icons) {
        if (icon && typeof icon === "object" && typeof icon.src === "string") {
          icon.src = withBasePath(icon.src, base);
        }
      }
    }
    return JSON.stringify(manifest);
  } catch (error) {
    console.warn(
      `[bascik] Could not rewrite web app manifest base paths: ${(error as Error).message}`,
    );
    return source;
  }
};
