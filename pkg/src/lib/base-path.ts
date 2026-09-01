import { createContentShield, shieldElementContents } from "./shielding.ts";

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
const HTML_OPENING_TAG_PATTERN = /<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;

const joinBasePath = (value: string, base: string): string =>
  `${base}${value.slice(1)}`;

export const shouldRewriteBasePath = (value: string, base: string): boolean =>
  base !== "/" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.startsWith(base);

export const withBasePath = (value: string, base: string): string =>
  shouldRewriteBasePath(value, base) ? joinBasePath(value, base) : value;

export const stripBasePath = (pathname: string, base: string): string | null => {
  if (base === "/") return pathname;
  const prefix = base.slice(0, -1);
  if (pathname === prefix || pathname === base) return "/";
  return pathname.startsWith(base) ? pathname.slice(prefix.length) : null;
};

export const composeSiteUrl = (siteUrl: string, base: string, pathname: string): string => {
  let siteUrlEnd = siteUrl.length;
  while (siteUrlEnd > 0 && siteUrl[siteUrlEnd - 1] === "/") siteUrlEnd--;
  const normalizedSiteUrl = siteUrl.slice(0, siteUrlEnd);
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizedSiteUrl}${withBasePath(normalizedPathname, base)}`;
};

export const rewriteSrcsetBasePaths = (srcset: string, base: string): string => {
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
    const isDataUrl = srcset.slice(position, position + 5).toLowerCase() === "data:";
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
      shouldRewriteBasePath(value, base) ? `${quote}${joinBasePath(value, base)}${quote}` : match,
  );

const rewriteImageSetFunctions = (css: string, base: string): string => {
  const imageSetPattern = /(?:-webkit-)?image-set\(/gi;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = imageSetPattern.exec(css)) !== null) {
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
    (match, doubleValue: string | undefined, singleValue: string | undefined, unquotedValue: string | undefined) => {
      const value = doubleValue ?? singleValue ?? unquotedValue ?? "";
      const quote = doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : "";
      return (
        shouldRewriteBasePath(value, base)
          ? `url(${quote}${joinBasePath(value, base)}${quote})`
          : match
      );
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

const getAttributeValue = (tag: string, attribute: string): string | undefined => {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const pattern = new RegExp(
    `\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};

const rewriteTagAttributes = (tag: string, base: string): string => {
  const tagName = /^<\s*([a-zA-Z][\w:-]*)/.exec(tag)?.[1].toLowerCase() ?? "";
  const metaProperty = tagName === "meta"
    ? (getAttributeValue(tag, "property") ?? getAttributeValue(tag, "name"))?.toLowerCase()
    : undefined;

  return tag.replace(
    /\s([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g,
    (match, rawName: string, rawValue: string, doubleValue: string | undefined, singleValue: string | undefined, unquotedValue: string | undefined) => {
      const name = rawName.toLowerCase();
      const value = doubleValue ?? singleValue ?? unquotedValue ?? "";
      let rewritten = value;

      if (URL_ATTRIBUTES.has(name)) {
        rewritten = withBasePath(value, base);
      } else if (SRCSET_ATTRIBUTES.has(name)) {
        rewritten = rewriteSrcsetBasePaths(value, base);
      } else if (name === "style") {
        rewritten = rewriteCssBasePaths(value, base);
      } else if (name === "content" && metaProperty && URL_META_PROPERTIES.has(metaProperty)) {
        rewritten = withBasePath(value, base);
      }

      if (rewritten === value) return match;
      const quote = doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : "";
      return ` ${rawName}=${quote}${rewritten}${quote}`;
    },
  );
};

export const rewriteHtmlBasePaths = (html: string, base: string): string => {
  if (base === "/") return html;

  const commentShield = createContentShield(html);
  const withoutComments = html.replace(
    /<!--[\s\S]*?(?:-->|$)/g,
    (comment) => commentShield.hide(comment),
  );
  const withCss = withoutComments.replace(
    /(<style\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style>)/gi,
    (_match, open: string, css: string, close: string) =>
      `${rewriteTagAttributes(open, base)}${rewriteCssBasePaths(css, base)}${close}`,
  );
  const shielded = shieldElementContents(withCss, ["script", "style", "textarea", "title"]);
  const rewritten = shielded.html.replace(
    HTML_OPENING_TAG_PATTERN,
    (tag) => rewriteTagAttributes(tag, base),
  );
  return commentShield.restore(shielded.restore(rewritten));
};

export const rewriteManifestBasePaths = (source: string, base: string): string => {
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
    console.warn(`[bascik] Could not rewrite web app manifest base paths: ${(error as Error).message}`);
    return source;
  }
};