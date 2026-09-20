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
import { ANY_DIRECTIVE_ATTR_NAME } from "./html-patterns.ts";

const SCRIPT_TAG_PATTERN = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi;

/**
 * Build a same-length mask of `htmlString` where HTML comments and the bodies
 * of `<script>` elements are replaced with space characters. The mask is used
 * purely for locating tag boundaries; all index arithmetic is then applied to
 * the original string.
 *
 * The scan is linear and state-machine-based to handle the ambiguous
 * interaction between comment openers (`<!--`) and script string literals
 * (e.g. `const s = "<!--";`) correctly:
 *   - While inside a `<script>` body, `<!--` is NOT treated as a comment.
 *   - While inside a comment, `<script` is NOT treated as a tag opener.
 */
const buildSensitiveMask = (html: string): string => {
  if (!html.includes("<")) return html;
  const chars = html.split("");
  const n = chars.length;
  let i = 0;
  while (i < n) {
    // HTML comment
    if (chars[i] === "<" && html.startsWith("!--", i + 1)) {
      const end = html.indexOf("-->", i + 4);
      const commentEnd = end === -1 ? n : end + 3;
      for (let j = i; j < commentEnd; j++) chars[j] = " ";
      i = commentEnd;
      continue;
    }
    // Opening tag — check for script/pre/textarea/style
    if (chars[i] === "<") {
      // Parse tag name
      let nameStart = i + 1;
      if (nameStart < n && chars[nameStart] === "/") nameStart++;
      let nameEnd = nameStart;
      while (nameEnd < n && /[a-zA-Z0-9-]/.test(chars[nameEnd])) nameEnd++;
      const tagName = html.slice(nameStart, nameEnd).toLowerCase();
      if (tagName === "script" || tagName === "pre" || tagName === "textarea" || tagName === "style") {
        // Find the end of the opening tag (skip attributes, respecting quotes)
        let j = nameEnd;
        while (j < n && chars[j] !== ">") {
          if (chars[j] === '"' || chars[j] === "'") {
            const q = chars[j];
            j++;
            while (j < n && chars[j] !== q) j++;
          }
          j++;
        }
        const bodyStart = j < n ? j + 1 : n; // position after ">"
        // Find the matching close tag
        const closeTag = `</${tagName}`;
        const closeIdx = html.toLowerCase().indexOf(closeTag, bodyStart);
        if (closeIdx === -1) {
          i = bodyStart;
          continue;
        }
        // Blank out from after the open tag's ">" to the start of close tag
        for (let k = bodyStart; k < closeIdx; k++) chars[k] = " ";
        i = closeIdx;
        continue;
      }
    }
    i++;
  }
  return chars.join("");
};

const shieldSensitiveContent = (htmlString: string): {
  html: string;
  restore: (value: string) => string;
} => {
  const shield = createContentShield(htmlString);

  // Build a mask where comment and raw-text-element bodies are blanked out.
  // `<script>` or `<style>` references inside comments are invisible to the
  // regex scan below, and `<!--` inside script string literals is never
  // mistaken for a comment opener (script bodies are masked before comments).
  const masked = buildSensitiveMask(htmlString);

  let html = htmlString;

  // Collect ranges to shield from the masked string, apply right-to-left to
  // the real `html` so that earlier offsets remain valid.
  const ranges: Array<{ start: number; end: number }> = [];

  // script bodies
  let scriptMatch: RegExpExecArray | null;
  const scriptRe = new RegExp(SCRIPT_TAG_PATTERN.source, "gi");
  while ((scriptMatch = scriptRe.exec(masked)) !== null) {
    const bodyStart = scriptMatch.index + scriptMatch[1].length;
    const bodyEnd = bodyStart + scriptMatch[2].length;
    ranges.push({ start: bodyStart, end: bodyEnd });
  }

  // pre/textarea/style blocks (whole element)
  const blockRe = /<(pre|textarea|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(masked)) !== null) {
    ranges.push({ start: blockMatch.index, end: blockMatch.index + blockMatch[0].length });
  }

  // Sort descending by start so splicing doesn't shift later offsets.
  ranges.sort((a, b) => b.start - a.start);

  for (const { start, end } of ranges) {
    html = html.slice(0, start) + shield.hide(html.slice(start, end)) + html.slice(end);
  }

  return { html, restore: shield.restore };
};

// Whole-attribute-name match: `data-bascik-server-foo` is NOT a directive.
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`, "i");

const isExtractableScript = (openTag: string): boolean =>
  !DIRECTIVE_SCRIPT_RE.test(openTag) &&
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
