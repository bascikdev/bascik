/**
 * @module html-minifier
 * Built-in lightweight, safe HTML minifier for Bascik.
 *
 * Strips HTML comments, collapses redundant whitespace while preserving
 * whitespace between inline HTML elements, preserves <pre> and <textarea>
 * contents verbatim, and consolidates script tags at the end of the output.
 */

import { isJavaScriptScript } from "./script-types.ts";
import { createContentShield } from "./shielding.ts";

const SCRIPT_TAG_PATTERN = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script>)/gi;

const shieldSensitiveContent = (htmlString: string): {
  html: string;
  restore: (value: string) => string;
} => {
  const shield = createContentShield(htmlString);
  let html = htmlString.replace(
    /<(pre|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1>/gi,
    (match) => shield.hide(match),
  );
  html = html.replace(
    SCRIPT_TAG_PATTERN,
    (_match, open: string, body: string, close: string) =>
      `${open}${shield.hide(body)}${close}`,
  );
  return { html, restore: shield.restore };
};

const isExtractableScript = (openTag: string): boolean =>
  !/\b(?:data-bascik-build|data-bascik-server|data-bascik-routes)\b/i.test(openTag) &&
  isJavaScriptScript(openTag);

export const extractScriptTags = (htmlString: string): string => {
  const shielded = shieldSensitiveContent(htmlString);
  const html = shielded.html.replace(/<!--[\s\S]*?-->/g, "");
  const arr = [...html.matchAll(SCRIPT_TAG_PATTERN)]
    .filter((script) => isExtractableScript(script[1]));
  if (!arr.length) return "";
  return shielded.restore(arr
    .map((script) => script[0])
    .join("\n")
    .trim());
};

export const INLINE_TAGS = new Set([
  "a",

  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "mark",
  "meter",
  "output",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "textarea",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

// Helper to extract tag name backwards from index of `>`
const getPrevTagName = (str: string, gtIndex: number): string => {
  let i = gtIndex - 1;
  while (i >= 0 && str[i] !== "<") {
    i--;
  }
  if (i < 0) return "";
  let start = i + 1;
  if (str[start] === "/") start++;
  let end = start;
  while (end < gtIndex && /[a-zA-Z0-9-]/.test(str[end])) {
    end++;
  }
  return str.slice(start, end).toLowerCase();
};

// Helper to extract tag name forwards from index of `<`
const getNextTagName = (str: string, ltIndex: number): string => {
  let start = ltIndex + 1;
  if (start < str.length && str[start] === "/") start++;
  let end = start;
  while (end < str.length && /[a-zA-Z0-9-]/.test(str[end])) {
    end++;
  }
  return str.slice(start, end).toLowerCase();
};

export const minifyHtml = (htmlString: string): string => {
  const shielded = shieldSensitiveContent(htmlString);
  let html = shielded.html.replace(/<!--[\s\S]*?-->/g, "");
  const scriptTags = extractScriptTags(html);
  if (scriptTags) {
    html = html.replace(
      SCRIPT_TAG_PATTERN,
      (match, open: string) => isExtractableScript(open) ? "" : match,
    ).trim();
  }
  // Preserve content of whitespace-sensitive elements before collapsing whitespace.
  // Without this, code inside <pre> blocks has its newlines and indentation stripped,
  // breaking the visual display of code examples in the browser. Non-extracted scripts
  // (such as data-bascik-server or application/ld+json) are also preserved verbatim.
  html = html.replace(/\n/g, " ").replace(/\s\s+/g, " ");
  html = html.replace(/>\s+</g, (match, offset, fullString) => {
    const prevTag = getPrevTagName(fullString, offset);
    const nextStart = offset + match.length - 1;
    const nextTag = getNextTagName(fullString, nextStart);

    if (INLINE_TAGS.has(prevTag) && INLINE_TAGS.has(nextTag)) {
      return "> <";
    }
    return "><";
  });
  html = html.replace(
    />\s+(\x00BASCIK_SHIELD_\d+\x00)/g,
    (_match, token: string) => `>${token}`,
  );
  html = html.replace(
    /(\x00BASCIK_SHIELD_\d+\x00)\s+</g,
    (_match, token: string) => `${token}<`,
  );
  html = shielded.restore(html);
  if (scriptTags) {
    html += `\n${shielded.restore(scriptTags)}`;
  }
  return html;
};
