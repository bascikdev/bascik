/**
 * @module html-minifier
 * Built-in lightweight, safe HTML minifier for Bascik.
 *
 * Strips HTML comments, collapses redundant whitespace while preserving
 * whitespace between inline HTML elements, preserves <pre> and <textarea>
 * contents verbatim, and consolidates script tags at the end of the output.
 *
 * Which comments and scripts exist is decided by the spec-following scan in
 * html-scanner.ts, never by a regex: removing or moving only what the browser
 * parses as a comment or script keeps every script that ran running, and
 * never makes text or dead markup run.
 */

import { createContentShield } from "./shielding.ts";
import {
  readStartTagAttributes,
  removeHtmlRanges,
  scanHtml,
  type HtmlRange,
  type TagAttribute,
} from "./html-scanner.ts";

// The end tag follows the HTML script-data rules: `</script` closes the element
// when followed by whitespace, `/`, or `>`, and anything up to `>` is ignored
// (`</script >`, `</script\t\n foo>`, `</script/>`).
const SCRIPT_TAG_PATTERN = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script(?:[\s/][^>]*)?>)/gi;

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
const isTagNameCode = (code: number): boolean =>
  (code >= 97 && code <= 122) || // a-z
  (code >= 65 && code <= 90) || // A-Z
  (code >= 48 && code <= 57) || // 0-9
  code === 45; // -

const buildSensitiveMask = (html: string): string => {
  if (!html.includes("<")) return html;
  const n = html.length;
  // Reuse the exact same search representation for every raw-text block.
  // Rebuilding it per block makes code-example-heavy pages quadratic in size.
  // Keep it lazy so ordinary markup pays no full-input normalization cost.
  let lowercaseHtml: string | undefined;
  // Blanked ranges are found in ascending, non-overlapping order, so the mask
  // is assembled from source slices and space runs in one pass.
  const parts: string[] = [];
  let copiedUntil = 0;
  const blank = (start: number, end: number): void => {
    if (end <= start) return;
    parts.push(html.slice(copiedUntil, start), " ".repeat(end - start));
    copiedUntil = end;
  };
  let trailingBlank = 0;
  let i = html.indexOf("<");
  while (i !== -1) {
    // HTML comment
    if (html.startsWith("!--", i + 1)) {
      const end = html.indexOf("-->", i + 4);
      const commentEnd = end === -1 ? n : end + 3;
      blank(i, commentEnd);
      i = html.indexOf("<", commentEnd);
      continue;
    }
    // Opening tag: check for script/pre/textarea/style
    let nameStart = i + 1;
    const isClosingTag = nameStart < n && html.charCodeAt(nameStart) === 47; // /
    if (isClosingTag) nameStart++;
    let nameEnd = nameStart;
    while (nameEnd < n && isTagNameCode(html.charCodeAt(nameEnd))) nameEnd++;
    const nameLength = nameEnd - nameStart;
    const tagName = !isClosingTag && nameLength >= 3 && nameLength <= 8
      ? html.slice(nameStart, nameEnd).toLowerCase()
      : "";
    if (tagName === "script" || tagName === "pre" || tagName === "textarea" || tagName === "style") {
      // Find the end of the opening tag (skip attributes, respecting quotes)
      let j = nameEnd;
      while (j < n && html[j] !== ">") {
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j];
          j++;
          while (j < n && html[j] !== q) j++;
        }
        j++;
      }
      const bodyStart = j < n ? j + 1 : n; // position after ">"
      // Find the matching close tag
      const closeTag = `</${tagName}`;
      lowercaseHtml ??= html.toLowerCase();
      const closeIdx = lowercaseHtml.indexOf(closeTag, bodyStart);
      if (closeIdx === -1) {
        i = html.indexOf("<", bodyStart);
        continue;
      }
      // Blank out from after the open tag's ">" to the start of close tag.
      // Characters whose lowercase form is longer (U+0130) shift the index
      // past the source end; the mask keeps the historical trailing spaces.
      blank(bodyStart, Math.min(closeIdx, n));
      if (closeIdx > n) trailingBlank = closeIdx - n;
      i = html.indexOf("<", closeIdx);
      continue;
    }
    i = html.indexOf("<", i + 1);
  }
  if (copiedUntil === 0 && trailingBlank === 0) return html;
  parts.push(html.slice(copiedUntil), " ".repeat(trailingBlank));
  return parts.join("");
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

  // Collect ranges to shield from the masked string; offsets index the
  // original `htmlString`.
  const ranges: Array<{ start: number; end: number }> = [];

  // script bodies
  let scriptMatch: RegExpExecArray | null;
  const scriptRe = new RegExp(SCRIPT_TAG_PATTERN.source, "gi");
  while ((scriptMatch = scriptRe.exec(masked)) !== null) {
    const bodyStart = scriptMatch.index + scriptMatch[1].length;
    const bodyEnd = bodyStart + scriptMatch[2].length;
    ranges.push({ start: bodyStart, end: bodyEnd });
  }

  // Raw-text blocks. Their bodies were blanked in the mask, so locate their
  // opening and closing tags with an index scan instead of a body-matching
  // regex. This preserves styles containing `<!-- ... -->` and lets a <pre>
  // retain a nested script without treating that script as an extractable one.
  const rawTextTagRe = /<(pre|textarea|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let rawTextMatch: RegExpExecArray | null;
  while ((rawTextMatch = rawTextTagRe.exec(masked)) !== null) {
    const tagName = rawTextMatch[1];
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "gi");
    closeRe.lastIndex = rawTextTagRe.lastIndex;
    const closeMatch = closeRe.exec(masked);
    if (!closeMatch) continue;
    ranges.push({ start: rawTextMatch.index, end: closeMatch.index + closeMatch[0].length });
    rawTextTagRe.lastIndex = closeMatch.index + closeMatch[0].length;
  }

  // Tokens are assigned in descending start order.
  ranges.sort((a, b) => b.start - a.start);

  // Malformed markup can produce overlapping ranges, for example a <pre> the
  // mask closes at `</prex` while the range scan closes it at a later `</pre>`.
  // Keep the earliest-starting range of each overlapping run; a range it
  // contains is already shielded as part of it. `kept` is ascending.
  const kept: Array<{ start: number; end: number }> = [];
  let keptEnd = -1;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const range = ranges[k];
    if (range.start < keptEnd) continue;
    kept.push(range);
    keptEnd = range.end;
  }
  if (kept.length === 0) return { html: htmlString, restore: shield.restore };

  const tokens = new Array<string>(kept.length);
  for (let k = kept.length - 1; k >= 0; k--) {
    tokens[k] = shield.hide(htmlString.slice(kept[k].start, kept[k].end));
  }
  // Assemble once instead of re-slicing the whole page for every range.
  const parts: string[] = [];
  let cursor = 0;
  for (let k = 0; k < kept.length; k++) {
    parts.push(htmlString.slice(cursor, kept[k].start), tokens[k]);
    cursor = kept[k].end;
  }
  parts.push(htmlString.slice(cursor));

  return { html: parts.join(""), restore: shield.restore };
};

/**
 * Test-only access to the shielding internals, used by the differential
 * parity tests in html-minifier-shield.test.ts. Never read on production paths.
 */
export const __htmlMinifierInternalsForTests = {
  SCRIPT_TAG_PATTERN,
  buildSensitiveMask,
  shieldSensitiveContent,
};

const DIRECTIVE_ATTRIBUTES = new Set(["data-bascik-build", "data-bascik-server", "data-bascik-routes", "data-bascik-stream"]);

/** JavaScript MIME type essences (WHATWG MIME Sniffing). */
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);

type ScriptKind = "classic" | "module" | "processed" | "inert";

/**
 * How the browser treats a script, from its tokenized attributes (WHATWG
 * "prepare the script element"): a classic or module script runs; an import
 * map or speculation rules are processed in place; any other type is a data
 * block. Bascik directive scripts never reach the browser as written.
 */
const scriptKind = (attributes: TagAttribute[]): ScriptKind => {
  if (attributes.some((attribute) => DIRECTIVE_ATTRIBUTES.has(attribute.name))) return "inert";
  // The tokenizer drops repeated attributes, so the first one counts.
  const type = attributes.find((attribute) => attribute.name === "type");
  const language = attributes.find((attribute) => attribute.name === "language");
  let typeString: string;
  if (type ? type.value === "" : !language || language.value === "") typeString = "text/javascript";
  else if (type) typeString = type.value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  else typeString = `text/${language!.value}`;
  const lower = typeString.toLowerCase();
  if (JAVASCRIPT_MIME_TYPES.has(lower)) return "classic";
  if (lower === "module") return "module";
  if (lower === "importmap" || lower === "speculationrules") return "processed";
  return "inert";
};

interface MinificationPlan {
  /** The document without its comments and hoisted scripts. */
  remainder: string;
  /** Hoisted script elements, verbatim, in document order. */
  scripts: string[];
  /** Where in `remainder` the hoisted scripts still run when placed. */
  insertAt: number;
}

/**
 * Decide, from one spec-following scan of the original document, which
 * comments to drop and which scripts to hoist.
 *
 * - Comments are dropped everywhere except inside `<pre>`, whose content stays
 *   verbatim. Comment-like text in raw text or RCDATA (a `<script>` or
 *   `<style>` body, `<textarea>`, `<title>`, `<noscript>`) is not a comment.
 * - Ordinary JavaScript scripts are hoisted. Scripts inside `<template>` (inert
 *   until cloned), SVG or MathML (parsed differently), or `<pre>` stay where
 *   they are, as does anything after the point the scan cannot follow.
 *   Execution order is kept: a script that is processed in place (one of
 *   those, or an import map) keeps every earlier script before it, so those
 *   are not hoisted either. Data blocks and Bascik directive scripts stay put
 *   and do not affect order.
 * - Hoisted scripts are placed at the end, unless the document ends inside
 *   markup where an appended script would not run, such as an unclosed tag,
 *   comment, `<template>`, or `<textarea>`. They then go just before it.
 */
const planMinification = (htmlString: string): MinificationPlan => {
  const removals: HtmlRange[] = [];
  const candidates: HtmlRange[] = [];
  /** End of the last script that runs where it stands; nothing before it may move after it. */
  let keepBefore = 0;
  const { insertionPoint } = scanHtml(htmlString, {
    comment(comment) {
      if (!comment.inPre) removals.push(comment);
    },
    script(script) {
      // A script cut off by the end of the input never runs; it stays as is.
      if (script.inTemplate || !script.terminated) return;
      const kind = scriptKind(readStartTagAttributes(htmlString, script.start));
      if (kind === "inert") return;
      if ((kind === "classic" || kind === "module") && !script.inForeign && !script.inPre) candidates.push(script);
      else keepBefore = Math.max(keepBefore, script.end);
    },
  });
  const hoisted = candidates.filter((script) => script.start >= keepBefore);
  const { html, index } = removeHtmlRanges(htmlString, [...removals, ...hoisted], insertionPoint);
  return { remainder: html, scripts: hoisted.map((script) => htmlString.slice(script.start, script.end)), insertAt: index };
};

export const extractScriptTags = (htmlString: string): string =>
  planMinification(htmlString).scripts.join("\n").trim();

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

/** Collapse whitespace outside `<pre>`, `<textarea>`, `<style>`, and script bodies. */
const collapseWhitespace = (htmlString: string): string => {
  const shielded = shieldSensitiveContent(htmlString);
  let html = shielded.html;
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
  return shielded.restore(html);
};

export const minifyHtml = (htmlString: string): string => {
  const { remainder, scripts, insertAt } = planMinification(htmlString);
  if (scripts.length === 0) return collapseWhitespace(remainder);
  const scriptTags = scripts.join("\n").trim();
  if (insertAt >= remainder.length) return `${collapseWhitespace(remainder.trim())}\n${scriptTags}`;
  // The document ends inside markup where an appended script would not run.
  // Place the scripts just before it; the line breaks keep the text on either
  // side from joining with them.
  const head = collapseWhitespace(remainder.slice(0, insertAt).trim());
  return `${head}\n${scriptTags}\n${collapseWhitespace(remainder.slice(insertAt))}`;
};
