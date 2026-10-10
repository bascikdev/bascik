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

// Whole-attribute-name match: `data-bascik-server-foo` is NOT a directive.
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`, "i");

const isExtractableScript = (openTag: string): boolean =>
  !DIRECTIVE_SCRIPT_RE.test(openTag) &&
  isJavaScriptScript(openTag);

/**
 * Whether the nearest `<` before `index` is more recent than the nearest `>`.
 * Each backward scan stops at the previous script match's closing `>` at the
 * latest, so the total cost across one scan of the page stays linear.
 */
const followsUnclosedTag = (html: string, index: number): boolean =>
  index > 0 && html.lastIndexOf("<", index - 1) > html.lastIndexOf(">", index - 1);

/**
 * Split shielded, comment-free `html` into the markup that stays in place and
 * the extractable script elements, in one scan. Building the remainder from
 * slices of a single match list guarantees that exactly the scripts that are
 * hoisted are the ones removed.
 *
 * A `<script` that follows an unclosed `<` (more recent than any `>`) is not
 * a tag start: in `<scr<script>a()</script>ipt>b()</script>` the browser sees
 * one `scr<script` tag and runs nothing. Removing it would join `<scr` and
 * `ipt>` into a new, executable `<script>`. Such a script is left in place,
 * which keeps the document as authored. Because every removal happens in a
 * closed context, joined text can never start a new tag at the seam.
 */
const partitionExtractableScripts = (html: string): { remainder: string; scripts: string[] } => {
  const parts: string[] = [];
  const scripts: string[] = [];
  let cursor = 0;
  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    if (!isExtractableScript(match[1])) continue;
    if (followsUnclosedTag(html, match.index)) continue;
    parts.push(html.slice(cursor, match.index));
    scripts.push(match[0]);
    cursor = match.index + match[0].length;
  }
  if (scripts.length === 0) return { remainder: html, scripts };
  parts.push(html.slice(cursor));
  return { remainder: parts.join(""), scripts };
};

/**
 * Remove HTML comments from shielded `html`. A `<!--` that follows an unclosed
 * `<` is tag text, not a comment: the browser reads `<scr<!-- c -->ipt>` as one
 * `scr<!--` tag. Removing it would join `<scr` and `ipt>` into a new,
 * executable `<script>`, so it is kept. Every removal happens in a closed
 * context, so the text joined at the seam can never extend a tag name.
 */
const removeComments = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, (comment: string, offset: number) =>
    followsUnclosedTag(html, offset) ? comment : "");

export const extractScriptTags = (htmlString: string): string => {
  const shielded = shieldSensitiveContent(htmlString);
  const html = removeComments(shielded.html);
  const { scripts } = partitionExtractableScripts(html);
  if (!scripts.length) return "";
  return shielded.restore(scripts.join("\n").trim());
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
  let html = removeComments(shielded.html);
  const { remainder, scripts } = partitionExtractableScripts(html);
  const scriptTags = scripts.join("\n").trim();
  if (scriptTags) {
    html = remainder.trim();
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
