import { maskCssSyntax } from "./css-tokenizer.ts";
import { replaceSpans, scanOpeningTags } from "./element-content-scan.ts";

/**
 * `html.replace(/<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g, replace)`
 * in linear time.
 */
const replaceOpeningTags = (
  html: string,
  replace: (openingTag: string) => string,
): string =>
  replaceSpans(
    html,
    scanOpeningTags(html).map(([start, end]) => ({ start, end })),
    replace,
  );
import {
  createContentShield,
  maskElementContents,
  shieldElementContents,
} from "./shielding.ts";

const shieldComments = (
  html: string,
): {
  html: string;
  restore: (value: string) => string;
} => {
  const shield = createContentShield(html);
  return {
    html: html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
      shield.hide(comment),
    ),
    restore: shield.restore,
  };
};

const shieldHtmlScanningContexts = (
  html: string,
): {
  html: string;
  restore: (value: string) => string;
} => {
  const rawText = shieldElementContents(html, ["script", "style", "textarea"]);
  const comments = shieldComments(rawText.html);
  return {
    html: comments.html,
    restore: (value) => rawText.restore(comments.restore(value)),
  };
};

/** Collect the set of original ID values declared in the component HTML. */
export const collectDeclaredIds = (html: string): Set<string> => {
  const { html: shieldedHtml } = shieldComments(
    maskElementContents(html, ["script", "style", "textarea"]),
  );
  const declaredIds = new Set<string>();
  // The opening tags `/<[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g`
  // finds, in linear time.
  for (const [tagStart, tagEnd] of scanOpeningTags(shieldedHtml)) {
    const idMatch = shieldedHtml
      .slice(tagStart, tagEnd)
      .match(
        /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+?))(?=\s|\/>|>|$)/i,
      );
    const rawUnquoted = idMatch?.[3];
    const unquoted = rawUnquoted?.endsWith("/")
      ? rawUnquoted.slice(0, -1)
      : rawUnquoted;
    const id = idMatch?.[1] ?? idMatch?.[2] ?? unquoted;
    if (id) declaredIds.add(id);
  }
  return declaredIds;
};

const replaceAttributeValue = (
  tag: string,
  attribute: string,
  replaceValue: (value: string) => string,
): string => {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const attributePattern = new RegExp(
    `(\\s${escapedAttribute}\\s*=\\s*)(?:(["'])([\\s\\S]*?)\\2|([^\\s"'=<>` +
      "`" +
      `]+?))(?=\\s|\\/>|>|$)`,
    "i",
  );
  return tag.replace(
    attributePattern,
    (
      full,
      prefix: string,
      quote: string | undefined,
      quotedVal: string | undefined,
      unquotedVal: string | undefined,
    ) => {
      if (quote !== undefined && quotedVal !== undefined) {
        const replaced = replaceValue(quotedVal);
        return replaced === quotedVal
          ? full
          : `${prefix}${quote}${replaced}${quote}`;
      }
      if (unquotedVal !== undefined) {
        const trailingSlash = unquotedVal.endsWith("/") ? "/" : "";
        const raw = trailingSlash ? unquotedVal.slice(0, -1) : unquotedVal;
        const replaced = replaceValue(raw);
        return replaced === raw
          ? full
          : `${prefix}"${replaced}"${trailingSlash}`;
      }
      return full;
    },
  );
};

const rewriteSingleId = (
  value: string,
  resolve: (originalId: string) => string | null,
): string => resolve(value) ?? value;

const rewriteIdList = (
  value: string,
  resolve: (originalId: string) => string | null,
): string => value.replace(/\S+/g, (id) => resolve(id) ?? id);

const rewriteFragment = (
  value: string,
  resolve: (originalId: string) => string | null,
): string => {
  if (!value.startsWith("#") || value.length === 1) return value;
  const resolved = resolve(value.slice(1));
  return resolved === null ? value : `#${resolved}`;
};

const rewriteUrlFragments = (
  value: string,
  resolve: (originalId: string) => string | null,
): string =>
  value.replace(
    /url\(\s*(["']?)#([^\s)"']+)\1\s*\)/gi,
    (url, _quote: string, id: string) => {
      const resolved = resolve(id);
      return resolved === null
        ? url
        : url.replace(`#${id}`, () => `#${resolved}`);
    },
  );

const SINGLE_ID_ATTRIBUTES = [
  "form",
  "list",
  "popovertarget",
  "commandfor",
  "aria-activedescendant",
  "aria-errormessage",
];

const ID_LIST_ATTRIBUTES = [
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-flowto",
  "aria-details",
  "itemref",
];

const SVG_PRESENTATION_ATTRIBUTES = [
  "fill",
  "stroke",
  "mask",
  "clip-path",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
];

/** Rewrite ID-holding attributes in HTML, using a resolver for declared IDs. */
const QUICK_ID_REF_RE =
  /\s(?:for|form|list|popovertarget|commandfor|aria-[\w-]+|itemref|headers|href|xlink:href|fill|stroke|mask|clip-path|filter|marker-[\w-]+|style)\s*=/i;

export const rewriteIdReferencesInHtml = (
  html: string,
  resolve: (originalId: string) => string | null,
): string => {
  if (!QUICK_ID_REF_RE.test(html)) return html;
  const { html: shieldedHtml, restore } = shieldHtmlScanningContexts(html);
  const rewritten = replaceOpeningTags(shieldedHtml, (openingTag) => {
    if (!QUICK_ID_REF_RE.test(openingTag)) return openingTag;
    const tagName = openingTag
      .match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/)?.[1]
      .toLowerCase();
    if (!tagName) return openingTag;
    let tag = openingTag;

    for (const attribute of SINGLE_ID_ATTRIBUTES) {
      if (tag.includes(attribute)) {
        tag = replaceAttributeValue(tag, attribute, (value) =>
          rewriteSingleId(value, resolve),
        );
      }
    }
    for (const attribute of ID_LIST_ATTRIBUTES) {
      if (tag.includes(attribute)) {
        tag = replaceAttributeValue(tag, attribute, (value) =>
          rewriteIdList(value, resolve),
        );
      }
    }

    if (tagName === "label") {
      tag = replaceAttributeValue(tag, "for", (value) =>
        rewriteSingleId(value, resolve),
      );
    } else if (tagName === "output") {
      tag = replaceAttributeValue(tag, "for", (value) =>
        rewriteIdList(value, resolve),
      );
    }
    if (tagName === "td" || tagName === "th") {
      tag = replaceAttributeValue(tag, "headers", (value) =>
        rewriteIdList(value, resolve),
      );
    }
    if (tagName === "a" || tagName === "area" || tagName === "use") {
      tag = replaceAttributeValue(tag, "href", (value) =>
        rewriteFragment(value, resolve),
      );
    }
    if (tagName === "use") {
      tag = replaceAttributeValue(tag, "xlink:href", (value) =>
        rewriteFragment(value, resolve),
      );
    }
    if (tag.includes("url(") || tag.includes("URL(")) {
      for (const attribute of SVG_PRESENTATION_ATTRIBUTES) {
        if (tag.includes(attribute)) {
          tag = replaceAttributeValue(tag, attribute, (value) =>
            rewriteUrlFragments(value, resolve),
          );
        }
      }
      if (tag.includes("style")) {
        tag = replaceAttributeValue(tag, "style", (value) =>
          rewriteUrlFragments(value, resolve),
        );
      }
    }
    return tag;
  });
  return restore(rewritten);
};

/** Rewrite img usemap fragments against scoped map name declarations. */
export const rewriteUsemapReferencesInHtml = (
  html: string,
  resolve: (originalName: string) => string | null,
): string => {
  if (!/usemap/i.test(html)) return html;
  const { html: shieldedHtml, restore } = shieldHtmlScanningContexts(html);
  const rewritten = replaceOpeningTags(shieldedHtml, (openingTag) => {
    if (!/^<\s*img(?:\s|\/?>)/i.test(openingTag)) return openingTag;
    return replaceAttributeValue(openingTag, "usemap", (value) =>
      rewriteFragment(value, resolve),
    );
  });
  return restore(rewritten);
};

/** Rewrite url(#id) fragments in a CSS string. */
export const rewriteIdReferencesInCss = (
  css: string,
  resolve: (originalId: string) => string | null,
): string => {
  // Mask comments and ordinary string literals so `content: "url(#local)"`
  // is preserved, while keeping genuine url("...") fragment references live
  // so `fill: url("#grad")` still scopes. Attribute-selector values are also
  // masked (their hashes are literal, not URL fragments).
  const { masked, restore } = maskCssSyntax(css, { keepUrlArguments: true });
  return restore(rewriteUrlFragments(masked, resolve));
};
