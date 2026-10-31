/**
 * @module javascript
 *
 * Component Attribute & Script Scoping
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `prefixElementAttribute` is the core scoping transform.  It is called once
 * per attribute type (id / name / class) per component instance, using the
 * same `instanceId` for id and name so that HTML and JS stay in sync.
 *
 * Class attributes intentionally use the component NAME as their scope key
 * (not the instanceId).  This means every instance of the same component on
 * a page shares identical scoped class names, which lets `deduplicateCss`
 * emit a single `<style>` block regardless of how many times the component
 * is used.  IDs and names still use the instanceId to guarantee unique DOM
 * identifiers across multiple instances.
 *
 * For EACH value of the targeted attribute in the component template:
 *
 *   id / name  → bascik__<name>__<instanceId>__<original>
 *   class      → bascik__<name>__<original>          (no instanceId)
 *
 * HTML pass  — rewrites every matching attribute value in the template HTML.
 *
 * JS pass    — rewrites DOM selector references in every <script> block:
 *
 *   id attribute:
 *     getElementById("x")        →  getElementById("bascik__...__x")
 *     querySelector("#x")        →  querySelector("#bascik__...__x")
 *     querySelectorAll("#x")     →  querySelectorAll("#bascik__...__x")
 *     querySelector("#x .child") →  querySelector("#bascik__...__x .child")
 *     closest("#x")              →  closest("#bascik__...__x")
 *     matches("#x")              →  matches("#bascik__...__x")
 *     setAttribute("id","x")     →  setAttribute("id","bascik__...__x")
 *
 *   name attribute:
 *     getElementsByName("x")     →  getElementsByName("bascik__...__x")
 *     setAttribute("name","x")   →  setAttribute("name","bascik__...__x")
 *
 *   class attribute:
 *     getElementsByClassName("x") → getElementsByClassName("bascik__...__x")
 *     querySelector(".x")        →  querySelector(".bascik__...__x")
 *     querySelectorAll(".x")     →  querySelectorAll(".bascik__...__x")
 *     querySelector(".x .y")     →  querySelector(".bascik__...__x .bascik__...__y")
 *     closest(".x")              →  closest(".bascik__...__x")
 *     matches(".x")              →  matches(".bascik__...__x")
 *     classList.add("x")         →  classList.add("bascik__...__x")
 *     classList.add("x","y")     →  classList.add("bascik__...__x","bascik__...__y")
 *     classList.remove("x")      →  classList.remove("bascik__...__x")
 *     classList.remove("x","y")  →  classList.remove("bascik__...__x","bascik__...__y")
 *     classList.toggle("x")      →  classList.toggle("bascik__...__x")
 *     classList.toggle("x",cond) →  classList.toggle("bascik__...__x",cond)
 *     classList.contains("x")    →  classList.contains("bascik__...__x")
 *     classList.replace("x","y") →  classList.replace("bascik__...__x","bascik__...__y")
 *     setAttribute("class","x")  →  setAttribute("class","bascik__...__x")
 *     el.className = "x"         →  el.className = "bascik__...__x"
 *     el.className = "x y"       →  el.className = "bascik__...__x bascik__...__y"
 *     el.className += " x"       →  el.className += " bascik__...__x"
 *
 * CSS pass  (class attribute only) — rewrites the component's .css file AND
 * any inline <style> tags in the HTML:
 *   .className       →  .bascik__...__className      (class prefixing)
 *   p { }            →  .bascik__...__el__p { }       (element → class)
 *   @keyframes name  →  @keyframes bascik__...__keyframe__name
 *   animation: name  →  animation: bascik__...__keyframe__name
 *   @layer name      →  @layer bascik__...__layer__name
 *   container-name:  →  container-name: bascik__...__container__name
 *   --var-name:      →  --bascik__...__var-name:      (custom properties)
 *   var(--var-name)  →  var(--bascik__...__var-name)
 *   [id] { }         →  (stripped — cannot be scoped without DOM wrapping)
 *
 * `namespaceScriptTags` wraps every `text/javascript` script in an IIFE so
 * that variables declared inside one component cannot leak into another.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { getUniqueId, minifyAttributeName } from "./names.ts";
import { BascikConfig } from "./config.ts";
import { findComponentRoot } from "./component-roots.ts";
import { COMPANION_SCRIPT_RE } from "./companion-scripts.ts";
import { scanHtml } from "./html-scanner.ts";
import {
  ANY_DIRECTIVE_ATTR_NAME,
  getHtmlAttributeValue,
  isBuildScriptOpenTag,
  isDirectiveScriptOpenTag,
  isRequestScriptOpenTag,
} from "./html-patterns.ts";
import {
  encodeOutputScope,
  OUTPUT_SCOPE_ATTRIBUTE,
  type OutputScope,
} from "./output-scope.ts";

/** Cheap probe: a template naming none of these directives has nothing to annotate. */
const OUTPUT_SCOPED_DIRECTIVE_PROBE = /data-bascik-(?:build|server|stream)/i;

/**
 * Add the output-scope annotation to each component build, server and stream
 * script. Their output is generated after component scoping (a build script's
 * at page time, a server or stream script's at request time, prompt 157), so
 * the annotation lets that output receive the same class and element names
 * as the template. Client scripts are scoped in place and never carry it.
 *
 * Script start tags come from the HTML tokenizer scan, not a text search:
 * `<script data-bascik-server>` written inside a client script's string, a
 * style, textarea or comment body, or another tag's quoted attribute value is
 * text, and splicing a double-quoted attribute into it would break that
 * script's JavaScript (PR 113 review). Where the scan stops following the
 * browser (see html-scanner.ts), later scripts stay unannotated: their output
 * keeps its authored class names, which is visible, rather than corrupting
 * text the compiler cannot classify.
 */
const annotateOutputScopedScripts = (
  html: string,
  encodedScope: string,
): string => {
  if (!OUTPUT_SCOPED_DIRECTIVE_PROBE.test(html)) return html;
  const insertAt: number[] = [];
  scanHtml(html, {
    token(token) {
      if (token.kind !== "tag" || token.isEndTag || token.name !== "script")
        return;
      const openTag = html.slice(token.start, token.end);
      if (openTag.includes(OUTPUT_SCOPE_ATTRIBUTE)) return;
      if (!isBuildScriptOpenTag(openTag) && !isRequestScriptOpenTag(openTag))
        return;
      // Before the closing `>`, the same place the attribute always went.
      insertAt.push(token.end - 1);
    },
  });
  if (insertAt.length === 0) return html;
  const attribute = ` ${OUTPUT_SCOPE_ATTRIBUTE}="${encodedScope}"`;
  let result = "";
  let last = 0;
  for (const index of insertAt) {
    result += html.slice(last, index) + attribute;
    last = index;
  }
  return result + html.slice(last);
};

/**
 * A `<script>` open tag carrying any Bascik directive (`build`, `server`,
 * `routes`, `stream`) as a WHOLE attribute name. Such scripts run in Node and
 * are never scoped or wrapped as browser JS. Whole-name matching means an
 * unrelated `data-bascik-server-foo` attribute leaves the script an ordinary
 * client script.
 */
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(
  String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`,
  "i",
);
import { getScriptType, isJavaScriptScript } from "./script-types.ts";
import { findJsLiteralSpans } from "./js-literal-spans.ts";
import { sourceLinePadding, takeScriptLine } from "./script-source-lines.ts";
import { isTypeScriptFile, transformBrowserTypeScript } from "./typescript.ts";
import {
  addElementClassesInHtml,
  addIdClassesInHtml,
  convertCssElementSelectorsToClasses,
  convertCssIdSelectorsToClasses,
  prefixKeyframes,
  removeIdSelectors,
  scopeCssCustomProperties,
  scopeLayerNames,
  scopeContainerNames,
  scopeViewTransitionNames,
  scopeCounterStyleNames,
  scopeAnchorNames,
  scopeInlineStyleTags,
  extractInlineStyles,
  resolveCssImportsSync,
  shieldCssStrings,
} from "./styles.ts";
import {
  createContentShield,
  shieldElementContents,
  shieldPreservedAttribute,
  stripPreserveDirectives,
} from "./shielding.ts";
import {
  collectDeclaredIds,
  rewriteIdReferencesInHtml,
  rewriteIdReferencesInCss,
  rewriteUsemapReferencesInHtml,
} from "./id-references.ts";
import type { BascikComponent } from "./types.ts";
import {
  createNamedOpenTagScanner,
  createOpenTagScanner,
  isRegexWhitespace,
  openTagsOf,
  replaceScannedElements,
  replaceSpans,
  scanElementContents,
  type ElementScanOptions,
  type OpenTagScanner,
} from "./element-content-scan.ts";

/** `<script(?=[\t\n\f\r />])...>` elements closed the way browsers close them (see `ElementScanOptions`). */
const SCRIPT_ELEMENT_SCAN: ElementScanOptions = {
  opener: "tag-space",
  closer: "attributes",
};

/**
 * `html.replace(/(<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script(?:[\t\n\f\r /][^>]*)?>)/gi, replace)`
 * in linear time.
 */
const replaceScriptElements = (
  html: string,
  replace: (match: string, open: string, body: string, close: string) => string,
): string =>
  replaceScannedElements(
    html,
    "script",
    SCRIPT_ELEMENT_SCAN,
    (open, body, close) => replace(open + body + close, open, body, close),
  );

/** `html` with each open tag `tags` finds replaced by `replace(tag)`. */
const replaceOpenTags = (
  html: string,
  tags: OpenTagScanner,
  replace: (tag: string) => string,
): string => replaceSpans(html, openTagsOf(tags), replace);

/** `[a-zA-Z0-9-]` */
const isTagNameCode = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a) ||
  code === 0x2d;

interface ScopedCssCacheEntry {
  css: string;
  allElementClasses: string[];
  allIdsConverted: { idName: string; className: string }[];
}

const scopedCssCache = new Map<string, ScopedCssCacheEntry>();
const cssDeclaredClassesCache = new Map<string, Set<string>>();

export const clearScopedCssCache = (): void => {
  scopedCssCache.clear();
  cssDeclaredClassesCache.clear();
};

export const __scopedCssCacheStatsForTests = {
  hits: 0,
  misses: 0,
  reset(): void {
    this.hits = 0;
    this.misses = 0;
  },
};

// A memo hit skips the name generation and CSS import planning that
// scoping-template.ts must observe, so its recording runs compute the CSS.
let bypassScopedCssCache = false;

/** Run `run` synchronously with `scopedCssCache` lookups disabled (entries are still stored). */
export const withScopedCssCacheBypassed = <T>(run: () => T): T => {
  const previous = bypassScopedCssCache;
  bypassScopedCssCache = true;
  try {
    return run();
  } finally {
    bypassScopedCssCache = previous;
  }
};

const rewriteIdReferencesInStyleTags = (
  html: string,
  resolve: (originalId: string) => string | null,
): { html: string; changed: boolean } => {
  const shielded = shieldElementContents(html, [
    "code",
    "pre",
    "script",
    "textarea",
  ]);
  let changed = false;
  // `(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)`
  // (flags `gi`), in linear time.
  const rewrittenHtml = replaceScannedElements(
    shielded.html,
    "style",
    { opener: "tag-space", closer: "attributes" },
    (openTag: string, css: string, closeTag: string) => {
      const rewrittenCss = rewriteIdReferencesInCss(css, resolve);
      changed ||= rewrittenCss !== css;
      return `${openTag}${rewrittenCss}${closeTag}`;
    },
  );
  return { html: shielded.restore(rewrittenHtml), changed };
};

/**
 * Extracts and replaces function calls that might contain nested parentheses.
 * Avoids the regex `[^)]*` bug where `classList.add(fn('foo'), 'bar')` fails.
 */
const replaceBalancedCall = (
  src: string,
  methodRegex: RegExp,
  replacer: (callBody: string) => string,
): string => {
  let result = "";
  let lastIndex = 0;
  // Ensure the regex has the 'g' flag so we can use lastIndex
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const regex = new RegExp(
    methodRegex.source,
    methodRegex.flags.includes("g")
      ? methodRegex.flags
      : methodRegex.flags + "g",
  );

  let match;
  while ((match = regex.exec(src)) !== null) {
    const startIndex = match.index + match[0].length;
    let depth = 1;
    let i = startIndex;
    let inString: string | null = null;
    let inRegex = false;
    let inRegexCharacterClass = false;
    let inLineComment = false;
    let inBlockComment = false;

    while (i < src.length && depth > 0) {
      const char = src[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === inString) inString = null;
      } else if (inRegex) {
        if (char === "\\") i++;
        else if (char === "[") inRegexCharacterClass = true;
        else if (char === "]") inRegexCharacterClass = false;
        else if (char === "/" && !inRegexCharacterClass) inRegex = false;
      } else if (inLineComment) {
        if (char === "\n" || char === "\r") inLineComment = false;
      } else if (inBlockComment) {
        if (char === "*" && src[i + 1] === "/") {
          inBlockComment = false;
          i++;
        }
      } else {
        if (char === '"' || char === "'" || char === "`") inString = char;
        else if (char === "/" && src[i + 1] === "/") {
          inLineComment = true;
          i++;
        } else if (char === "/" && src[i + 1] === "*") {
          inBlockComment = true;
          i++;
        } else if (char === "/") {
          const previous = src.slice(startIndex, i).match(/\S(?=\s*$)/)?.[0];
          if (!previous || /[([{=:;,!?&|+\-*%^~<>]/.test(previous)) {
            inRegex = true;
            inRegexCharacterClass = false;
          }
        } else if (char === "(") depth++;
        else if (char === ")") depth--;
      }
      i++;
    }

    const endIndex = i;
    const callText = src.substring(match.index, endIndex);
    const replacedText = replacer(callText);

    result += src.substring(lastIndex, match.index) + replacedText;
    lastIndex = endIndex;
    regex.lastIndex = endIndex;
  }

  result += src.substring(lastIndex);
  return result;
};
/**
 * Replaces attributes inside HTML tags, taking care to ignore attribute-like
 * substrings that appear inside other string attribute values (e.g. `data-foo='class="fake"'`).
 */
const replaceSafeAttr = (
  html: string,
  attrName: string,
  replacer: (fullMatch: string, prefix: string, quotedVal: string) => string,
  isScriptCodeAt: (index: number) => boolean = () => false,
): string => {
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const attrRegex = new RegExp(
    `(\\s${attrName}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'=<>` +
      "`" +
      `]+?)(?=\\s|\\/>|>|$)`,
    "gm",
  );
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const attrQuickCheck = new RegExp(`\\s${attrName}\\s*=`, "i");

  // This simple regex identifies tags loosely. It handles nested attributes
  // because we only process the attributes inside the matched tag brackets.
  // `/<[a-zA-Z0-9-]+(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/g`, in linear time.
  return replaceOpenTags(
    html,
    createOpenTagScanner(html, (start) => {
      let index = start + 1;
      while (isTagNameCode(html.charCodeAt(index))) index++;
      if (index === start + 1) return -1;
      const code = html.charCodeAt(index);
      if (code !== 0x3e && !isRegexWhitespace(code)) return -1;
      // `count<max && ok` in script code is a comparison, not a tag.
      if (isScriptCodeAt(start)) return -1;
      return code === 0x3e ? index : index + 1;
    }),
    (tagMatch) => {
      if (!attrQuickCheck.test(tagMatch)) return tagMatch;
      // First, find all proper string boundaries in this tag to ignore false matches.
      const stringRanges: Array<{ start: number; end: number }> = [];
      let j = 0;
      let strChar = null;
      let strStart = -1;
      while (j < tagMatch.length) {
        if (strChar) {
          if (tagMatch[j] === "\\") j++;
          else if (tagMatch[j] === strChar) {
            stringRanges.push({ start: strStart, end: j });
            strChar = null;
          }
        } else if (tagMatch[j] === '"' || tagMatch[j] === "'") {
          strChar = tagMatch[j];
          strStart = j;
        }
        j++;
      }

      let finalStr = "";
      let lastIdx = 0;
      let match;
      attrRegex.lastIndex = 0;
      while ((match = attrRegex.exec(tagMatch)) !== null) {
        const matchStart = match.index;
        // Is the " class=" part inside a string attribute value?
        const isInside = stringRanges.some(
          (r) => matchStart > r.start && matchStart < r.end,
        );
        if (!isInside) {
          finalStr +=
            tagMatch.substring(lastIdx, matchStart) +
            replacer(match[0], match[1], match[2]);
          lastIdx = matchStart + match[0].length;
        }
      }
      finalStr += tagMatch.substring(lastIdx);
      return finalStr;
    },
  );
};
/**
 * A lookup of whether an offset of `html` lies in the code of a JavaScript (or TypeScript)
 * `<script>` body, outside its string and template literals. Markup a script builds sits in
 * its literals; a `<` in its code is an operator (`count<max`) or a type argument. Script
 * bodies are scanned on the first lookup, so markup with no tag candidates costs nothing.
 */
const createScriptCodeLookup = (html: string): ((index: number) => boolean) => {
  let codeStarts: number[] | undefined;
  const codeEnds: number[] = [];
  const build = (): void => {
    codeStarts = [];
    if (!html.includes("<script")) return;
    for (const match of scanElementContents(
      html,
      "script",
      SCRIPT_ELEMENT_SCAN,
    )) {
      const openTag = html.slice(match.start, match.contentStart);
      if (
        !isJavaScriptScript(openTag) &&
        getScriptType(openTag) !== "text/typescript"
      )
        continue;
      const body = html.slice(match.contentStart, match.contentEnd);
      let cursor = match.contentStart;
      for (const span of findJsLiteralSpans(body)) {
        if (match.contentStart + span.start > cursor) {
          codeStarts.push(cursor);
          codeEnds.push(match.contentStart + span.start);
        }
        cursor = match.contentStart + span.end;
      }
      if (match.contentEnd > cursor) {
        codeStarts.push(cursor);
        codeEnds.push(match.contentEnd);
      }
    }
  };
  return (index) => {
    if (codeStarts === undefined) build();
    const starts = codeStarts!;
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (starts[mid] > index) high = mid - 1;
      else if (codeEnds[mid] <= index) low = mid + 1;
      else return true;
    }
    return false;
  };
};

export const prefixElementAttribute = (
  component: BascikComponent,
  attribute: "id" | "name" | "class",
  componentInstanceId: string | null = null,
  deduplicateCss: boolean = BascikConfig.scoping?.deduplicateCss !== false,
  preservedTags: string[] = [],
): BascikComponent => {
  if (!component.fileContent) return component;
  if (
    attribute === "id" &&
    !/\sid\s*=/i.test(component.fileContent) &&
    !component.fileContent.includes("data-bascik-preserve")
  ) {
    return component;
  }
  if (
    attribute === "name" &&
    !/\sname\s*=/i.test(component.fileContent) &&
    !component.fileContent.includes("data-bascik-preserve")
  ) {
    return component;
  }

  const { html: shieldedContent, restore } = shieldPreservedAttribute(
    component.fileContent,
    attribute,
    preservedTags,
  );
  component.fileContent = shieldedContent;
  const declaredIds =
    attribute === "id"
      ? collectDeclaredIds(component.fileContent)
      : new Set<string>();
  // All class/name/id attrs will get this ID.
  // Accept an externally provided ID so that a single component instance can
  // share one ID across all attribute types (id, name, class).
  const instanceId = componentInstanceId ?? getUniqueId(8);
  const componentInstanceName = `${component.name}__${instanceId}`;
  // When deduplicateCss is true (default): class attributes are scoped to the
  // component NAME only (no instanceId) so all instances share identical class
  // names, allowing CSS to be emitted once per component type.
  // When deduplicateCss is false: class attributes use the per-instance key
  // (same as id/name) so each instance gets unique class names — JS class-
  // selector queries like querySelector('.myClass') naturally target only the
  // current instance's elements, at the cost of per-instance CSS blocks.
  // IDs and names always keep the instanceId so multiple instances have unique DOM nodes.
  // One shared stylesheet cannot target different per-instance IDs, so these components opt out of deduplication.
  const scopeKey =
    attribute === "class" && deduplicateCss && !component.requiresPerInstanceCss
      ? component.name
      : componentInstanceName;
  const attributesToReplace: Array<{
    attributeName: string;
    obfuscatedAttributeName: string;
  }> = [];

  // For class attributes: extract all class names defined in the component's CSS
  // (companion .css and inline <style> tags). Only classes present in component CSS
  // are scoped; classes not in component CSS are treated as global classes. A component
  // with no stylesheet at all defines no classes, so none of its classes are scoped:
  // they belong to the site's global stylesheet. (`components.ts` leaves
  // `cssFileContent` unset for an empty or comment-only stylesheet, so "no stylesheet"
  // and "a stylesheet that defines nothing" must behave the same.)
  let scopedClassesSet: Set<string> | null = null;
  if (attribute === "class") {
    const cssSources: string[] = [];
    if (component.cssFileContent) {
      // Resolved once here, so the memo key below holds the imported contents.
      component.cssFileContent = resolveCssImportsSync(
        component.cssFileContent,
        component.fileName,
      );
      cssSources.push(component.cssFileContent);
    }
    if (component.fileContent && component.fileContent.includes("<style")) {
      const { css: inlineCss } = extractInlineStyles(component.fileContent);
      if (inlineCss)
        cssSources.push(resolveCssImportsSync(inlineCss, component.fileName));
    }
    const combinedCss = cssSources.join("\n");
    if (combinedCss) {
      const cachedSet = cssDeclaredClassesCache.get(combinedCss);
      if (cachedSet) {
        scopedClassesSet = cachedSet;
      } else {
        scopedClassesSet = new Set<string>();
        const { css: shieldedCss } = shieldCssStrings(combinedCss);
        for (const m of shieldedCss.matchAll(
          /(?<=\.)[a-zA-Z_][a-zA-Z0-9_-]*/g,
        )) {
          scopedClassesSet.add(m[0]);
        }
        cssDeclaredClassesCache.set(combinedCss, scopedClassesSet);
      }
    } else {
      scopedClassesSet = new Set<string>();
    }
  }

  // Shield <meta> elements from name-attribute scoping. The `name` attribute
  // on <meta> refers to a standardized metadata vocabulary (e.g. "viewport",
  // "description", "robots") and must never be mangled by the scoping pipeline.
  // Name scoping as a whole is opt-in (`scoping.attributes.name`); when it is
  // on, every other `name` is scoped per instance, `<details name>` included.
  const metaShield =
    attribute === "name" ? createContentShield(component.fileContent) : null;
  if (metaShield) {
    // `/<meta(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*(?:\/>|>)/gi`, in linear time.
    const html = component.fileContent;
    component.fileContent = replaceOpenTags(
      html,
      createNamedOpenTagScanner(html, "meta"),
      (tag) => metaShield.hide(tag),
    );
  }

  // Use replaceSafeAttr instead of a global regex to ignore `class="x"` inside `data-foo='class="x"'`.
  // Shield HTML comments and <textarea> content so commented-out markup and
  // form values are never rewritten, while keeping <script> bodies live so
  // static HTML string literals inside client, server, and stream scripts have
  // their class/id/name attributes scoped.
  const nonScriptRawShield = (() => {
    const commentShield = createContentShield(component.fileContent);
    const withoutComments = component.fileContent.includes("<!--")
      ? component.fileContent.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
          commentShield.hide(comment),
        )
      : component.fileContent;
    const rawElements = shieldElementContents(withoutComments, [
      "style",
      "textarea",
    ]);
    return {
      html: rawElements.html,
      restore: (value: string) =>
        commentShield.restore(rawElements.restore(value)),
    };
  })();
  const isScriptCodeAt = createScriptCodeLookup(nonScriptRawShield.html);
  let scopedAttrsHtml = nonScriptRawShield.restore(
    replaceSafeAttr(
      nonScriptRawShield.html,
      attribute,
      (fullMatch, prefix, quotedVal) => {
        const firstChar = quotedVal[0];
        const isQuoted = firstChar === '"' || firstChar === "'";
        const quote = isQuoted ? firstChar : '"';
        const match = isQuoted
          ? quotedVal.slice(1, -1)
          : quotedVal.endsWith("/")
            ? quotedVal.slice(0, -1)
            : quotedVal;
        const trailingSlash = !isQuoted && quotedVal.endsWith("/") ? "/" : "";
        if (!match) return fullMatch;
        const newInner = match
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((attributeName: string) => {
            if (
              attribute === "class" &&
              scopedClassesSet !== null &&
              !scopedClassesSet.has(attributeName)
            ) {
              return attributeName;
            }
            const name = `bascik__${scopeKey}__${attributeName}`;
            const obfuscatedAttributeName = minifyAttributeName(name);
            attributesToReplace.push({
              attributeName,
              obfuscatedAttributeName,
            });
            return obfuscatedAttributeName;
          })
          .join(" ");
        return `${prefix}${quote}${newInner}${quote}${trailingSlash}`;
      },
      isScriptCodeAt,
    ),
  );

  if (attribute === "id" && declaredIds.size > 0) {
    const scopedIds = new Map(
      attributesToReplace.map(({ attributeName, obfuscatedAttributeName }) => [
        attributeName,
        obfuscatedAttributeName,
      ]),
    );
    scopedAttrsHtml = rewriteIdReferencesInHtml(
      scopedAttrsHtml,
      (originalId) =>
        declaredIds.has(originalId)
          ? (scopedIds.get(originalId) ?? null)
          : null,
    );
    component.scopedIdNames = Object.fromEntries(scopedIds);
    const inlineStyles = scopedAttrsHtml.includes("<style")
      ? rewriteIdReferencesInStyleTags(
          scopedAttrsHtml,
          (originalId) => scopedIds.get(originalId) ?? null,
        )
      : { html: scopedAttrsHtml, changed: false };
    scopedAttrsHtml = inlineStyles.html;
    component.requiresPerInstanceCss = inlineStyles.changed;
    if (component.cssFileContent && /url\(/i.test(component.cssFileContent)) {
      const rewrittenCss = rewriteIdReferencesInCss(
        component.cssFileContent,
        (originalId) => scopedIds.get(originalId) ?? null,
      );
      component.requiresPerInstanceCss ||=
        rewrittenCss !== component.cssFileContent;
      component.cssFileContent = rewrittenCss;
    }
  }
  if (attribute === "name" && attributesToReplace.length > 0) {
    const scopedNames = new Map(
      attributesToReplace.map(({ attributeName, obfuscatedAttributeName }) => [
        attributeName,
        obfuscatedAttributeName,
      ]),
    );
    // usemap references <map name>, not an id declaration.
    scopedAttrsHtml = rewriteUsemapReferencesInHtml(
      scopedAttrsHtml,
      (originalName) => scopedNames.get(originalName) ?? null,
    );
  }

  // Discover class names used only in JS (never in a class= attr).
  // The CSS pass scopes every class name it finds, so JS-only classes would
  // otherwise be scoped in CSS but left unscoped in JS, making the two out of sync.
  // Covers: classList.*, querySelector-family (".cls"), className =, setAttribute("class",…)
  if (attribute === "class") {
    const knownClasses = new Set(
      attributesToReplace.map((a) => a.attributeName),
    );
    const addIfNew = (className: string): void => {
      if (scopedClassesSet !== null && !scopedClassesSet.has(className)) {
        return;
      }
      if (!knownClasses.has(className)) {
        attributesToReplace.push({
          attributeName: className,
          obfuscatedAttributeName: minifyAttributeName(
            `bascik__${scopeKey}__${className}`,
          ),
        });
        knownClasses.add(className);
      }
    };

    // `/<script(?=[\t\n\f\r />])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi`,
    // in linear time.
    for (const scriptMatch of scanElementContents(
      scopedAttrsHtml,
      "script",
      SCRIPT_ELEMENT_SCAN,
    )) {
      const openTag = scopedAttrsHtml.slice(
        scriptMatch.start + 7,
        scriptMatch.contentStart - 1,
      );
      if (DIRECTIVE_SCRIPT_RE.test(openTag)) continue;
      const src = scopedAttrsHtml.slice(
        scriptMatch.contentStart,
        scriptMatch.contentEnd,
      );

      // classList.add/remove/toggle/contains/replace — extract every quoted token
      replaceBalancedCall(
        src,
        /classList\.(?:add|remove|toggle|contains|replace)\s*\(/gm,
        (callText) => {
          for (const tokenMatch of callText.matchAll(/["']([^"']+)["']/g)) {
            addIfNew(tokenMatch[1]);
          }
          return callText;
        },
      );
      // querySelector / querySelectorAll / closest / matches — extract ".token" class tokens
      for (const callMatch of src.matchAll(
        /(?:querySelector(?:All)?|closest|matches)\s*\(\s*["']([^"']*)["']\s*\)/gm,
      )) {
        for (const tokenMatch of callMatch[1].matchAll(
          /(?<![a-zA-Z0-9_-])\.([a-zA-Z_][a-zA-Z0-9_-]*)/g,
        )) {
          addIfNew(tokenMatch[1]);
        }
      }

      // el.className = "x y" and el.className += " x"
      for (const assignMatch of src.matchAll(
        /\bclassName\s*\+?=\s*["']([^"']*)["']/gm,
      )) {
        for (const token of assignMatch[1].trim().split(/\s+/)) {
          if (token) addIfNew(token);
        }
      }

      // setAttribute("class", "x y")
      for (const attrMatch of src.matchAll(
        /setAttribute\s*\(\s*["']class["']\s*,\s*["']([^"']*)["']\s*\)/gm,
      )) {
        for (const token of attrMatch[1].trim().split(/\s+/)) {
          if (token) addIfNew(token);
        }
      }

      // getElementsByClassName("x y")
      for (const byClassMatch of src.matchAll(
        /getElementsByClassName\s*\(\s*["']([^"']*)["']\s*\)/gm,
      )) {
        for (const token of byClassMatch[1].trim().split(/\s+/)) {
          if (token) addIfNew(token);
        }
      }
    }
  }

  // Deduplicate attributesToReplace tokens before running the script rewrite loop
  const seenAttrMap = new Map<string, string>();
  for (const {
    attributeName,
    obfuscatedAttributeName,
  } of attributesToReplace) {
    if (!seenAttrMap.has(attributeName)) {
      seenAttrMap.set(attributeName, obfuscatedAttributeName);
    }
  }

  // Rewrite DOM selector references in script blocks to use the scoped attribute values.
  // One pass per pattern over whole tokens so a later attribute name never
  // matches inside an earlier generated name or a longer attribute name.
  const scopedHtml =
    seenAttrMap.size === 0
      ? scopedAttrsHtml
      : replaceScriptElements(
          scopedAttrsHtml,
          (match, open: string, body: string, close: string) => {
            if (DIRECTIVE_SCRIPT_RE.test(open)) return match;
            let updatedBody = body;

            const rewriteQuotedArg = (
              full: string,
              prefix: string,
              value: string,
              suffix: string,
            ): string => {
              const scoped = seenAttrMap.get(value);
              return scoped === undefined
                ? full
                : `${prefix}${scoped}${suffix}`;
            };

            const rewriteSelectorCalls = (prefix: string): void => {
              const escapedPrefix = prefix.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              // Every `.class` / `#id` token, including the later tokens of a compound
              // (`.card.active`, `button.btn`, `div#panel`): only an escaped prefix
              // (`.a\\.b`) is not a token. Attribute selectors (`[data-x=a.b]`) are
              // matched first and kept whole so a dot in their value is never a class.
              // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
              const tokenRegex = new RegExp(
                `\\[[^\\]]*\\]|(?<!\\\\)${escapedPrefix}([^\\s"'#.,>+~:[\\]()]+)(?![a-zA-Z0-9_-])`,
                "g",
              );
              updatedBody = updatedBody.replace(
                /((?:querySelector(?:All)?|closest|matches)\s*\(\s*['"][^'"]*['"]\s*\))/gm,
                (call) =>
                  call.replace(
                    tokenRegex,
                    (tokenMatch, name: string | undefined) => {
                      if (name === undefined) return tokenMatch;
                      const scoped = seenAttrMap.get(name);
                      return scoped === undefined
                        ? tokenMatch
                        : `${prefix}${scoped}`;
                    },
                  ),
              );
            };

            const rewriteSpaceSeparatedTokens = (value: string): string =>
              value.replace(/\S+/g, (token) => seenAttrMap.get(token) ?? token);

            if (attribute === "id") {
              updatedBody = updatedBody.replace(
                /(getElementById\s*\(\s*["'])([^"']+)(["']\s*\))/gm,
                rewriteQuotedArg,
              );
              rewriteSelectorCalls("#");
              updatedBody = updatedBody.replace(
                /(setAttribute\s*\(\s*["']id["']\s*,\s*["'])([^"']+)(["']\s*\))/gm,
                rewriteQuotedArg,
              );
            } else if (attribute === "name") {
              updatedBody = updatedBody.replace(
                /(getElementsByName\s*\(\s*["'])([^"']+)(["']\s*\))/gm,
                rewriteQuotedArg,
              );
              updatedBody = updatedBody.replace(
                /(setAttribute\s*\(\s*["']name["']\s*,\s*["'])([^"']+)(["']\s*\))/gm,
                rewriteQuotedArg,
              );
            } else if (attribute === "class") {
              updatedBody = updatedBody.replace(
                /(getElementsByClassName\s*\(\s*["'])([^"']*)(["']\s*\))/gm,
                (_full, prefix: string, classes: string, suffix: string) =>
                  `${prefix}${rewriteSpaceSeparatedTokens(classes)}${suffix}`,
              );
              rewriteSelectorCalls(".");
              const rewriteAllClassTokens = (call: string): string =>
                call.replace(
                  /(["'])([^"']+)\1/g,
                  (quoted, quote: string, name: string) => {
                    const scoped = seenAttrMap.get(name);
                    return scoped === undefined
                      ? quoted
                      : `${quote}${scoped}${quote}`;
                  },
                );
              const rewriteFirstClassToken = (call: string): string =>
                call.replace(
                  /(["'])([^"']+)\1/,
                  (quoted, quote: string, name: string) => {
                    const scoped = seenAttrMap.get(name);
                    return scoped === undefined
                      ? quoted
                      : `${quote}${scoped}${quote}`;
                  },
                );
              updatedBody = replaceBalancedCall(
                updatedBody,
                /classList\.(?:add|remove|replace)\s*\(/gm,
                rewriteAllClassTokens,
              );
              updatedBody = replaceBalancedCall(
                updatedBody,
                /classList\.(?:toggle|contains)\s*\(/gm,
                rewriteFirstClassToken,
              );
              updatedBody = updatedBody.replace(
                /(setAttribute\s*\(\s*["']class["']\s*,\s*["'])([^"']*)(["']\s*\))/gm,
                (_full, prefix: string, classes: string, suffix: string) =>
                  `${prefix}${rewriteSpaceSeparatedTokens(classes)}${suffix}`,
              );
              updatedBody = updatedBody.replace(
                /(\bclassName\s*\+?=\s*["'])([^"']*)(['"])/gm,
                (_full, prefix: string, classes: string, suffix: string) =>
                  `${prefix}${rewriteSpaceSeparatedTokens(classes)}${suffix}`,
              );
            }

            return `${open}${updatedBody}${close}`;
          },
        );
  component.fileContent = scopedHtml;

  // Restore shielded <meta> elements.
  if (metaShield) {
    component.fileContent = metaShield.restore(component.fileContent);
  }

  // CSS
  if (attribute === "class") {
    // Extract any inline <style> tags present in component.fileContent (e.g.
    // for in-memory or dynamically constructed components) into cssFileContent
    if (component.fileContent && component.fileContent.includes("<style")) {
      const { html: cleanedHtml, css: inlineCss } = extractInlineStyles(
        component.fileContent,
      );
      component.fileContent = cleanedHtml;
      if (inlineCss) {
        const resolvedInline = resolveCssImportsSync(
          inlineCss,
          component.fileName,
        );
        component.cssFileContent = component.cssFileContent
          ? `${component.cssFileContent}\n${resolvedInline}`
          : resolvedInline;
      }
    }

    // Collect element names and id names converted to classes from all CSS
    // sources so we can inject the generated classes into the HTML in one pass.
    let allElementClasses: string[] = [];
    let allIdsConverted: { idName: string; className: string }[] = [];

    if (component.cssFileContent) {
      if (component.scopedIdNames && /url\(/i.test(component.cssFileContent)) {
        const rewrittenCss = rewriteIdReferencesInCss(
          component.cssFileContent,
          (originalId) => component.scopedIdNames?.[originalId] ?? null,
        );
        component.requiresPerInstanceCss ||=
          rewrittenCss !== component.cssFileContent;
        component.cssFileContent = rewrittenCss;
      }
      // Memoization cache key: component name, scope key, minify identifiers, and CSS source.
      // Every source in `cssFileContent` has had its imports and any url(#id) fragments resolved,
      // so components whose CSS has no per-instance url(#id) references share one cache entry across instances.
      const cacheKey = `${component.name}::${scopeKey}::${Boolean(BascikConfig.minify?.identifiers)}::${component.cssFileContent}`;
      const cached = bypassScopedCssCache
        ? undefined
        : scopedCssCache.get(cacheKey);

      if (cached) {
        __scopedCssCacheStatsForTests.hits++;
        component.cssFileContent = cached.css;
        allElementClasses.push(...cached.allElementClasses);
        allIdsConverted.push(...cached.allIdsConverted);
      } else {
        __scopedCssCacheStatsForTests.misses++;
        // Handle basic replacement of classnames in css file.
        // Shield string literals and url(...) contents first so dots inside
        // them (file extensions, domains) are never mistaken for class selectors:
        //   url(./img.png)  must NOT become  url(./img.bascik__…__png)
        const { css: shieldedCss, restore: restoreCssStrings } =
          shieldCssStrings(component.cssFileContent);
        component.cssFileContent = restoreCssStrings(
          shieldedCss.replace(/(?<=\.)[a-z_][a-z0-9-_]*/gim, (className) => {
            return minifyAttributeName(`bascik__${scopeKey}__${className}`);
          }),
        );

        // Convert CSS hash-ID selectors (#id) to component-scoped class selectors
        // before element-selector conversion so descendant elements after #id
        // (e.g. `#panel p`, `#panel > h3`) are converted in Pass 4.
        const { css: idSelectorCss, idsConverted } =
          convertCssIdSelectorsToClasses(component.cssFileContent, scopeKey);
        component.cssFileContent = idSelectorCss;
        allIdsConverted.push(...idsConverted);

        const { css: elSelectorToClassCss, elementsConvertedClasses } =
          convertCssElementSelectorsToClasses(
            component.cssFileContent,
            scopeKey,
          );
        component.cssFileContent = elSelectorToClassCss;
        allElementClasses.push(...elementsConvertedClasses);

        component.cssFileContent = prefixKeyframes(
          component.cssFileContent,
          scopeKey,
        );

        // Strip the [id] attribute-selector form (cannot be scoped without wrapping).
        component.cssFileContent = removeIdSelectors(component.cssFileContent);

        // Scope CSS custom properties (--var-name declarations and var() references)
        component.cssFileContent = scopeCssCustomProperties(
          component.cssFileContent,
          scopeKey,
        );

        // Scope @layer names
        component.cssFileContent = scopeLayerNames(
          component.cssFileContent,
          scopeKey,
        );

        // Scope @container names
        component.cssFileContent = scopeContainerNames(
          component.cssFileContent,
          scopeKey,
        );

        // Scope view-transition-name values
        component.cssFileContent = scopeViewTransitionNames(
          component.cssFileContent,
          scopeKey,
        );

        // Scope @counter-style names
        component.cssFileContent = scopeCounterStyleNames(
          component.cssFileContent,
          scopeKey,
        );

        // Scope anchor-name / @position-try identifiers
        component.cssFileContent = scopeAnchorNames(
          component.cssFileContent,
          scopeKey,
        );

        scopedCssCache.set(cacheKey, {
          css: component.cssFileContent,
          allElementClasses: [...elementsConvertedClasses],
          allIdsConverted: [...idsConverted],
        });
      }
    }

    // Scope inline <style> tags in the component HTML and collect any
    // element/id classes they define.
    const inlineResult = scopeInlineStyleTags(component.fileContent, scopeKey);
    component.fileContent = inlineResult.html;
    allElementClasses.push(...inlineResult.elementsConvertedClasses);
    allIdsConverted.push(...inlineResult.idsConverted);

    // Inject element classes into the HTML once from all CSS sources combined.
    component.fileContent = addElementClassesInHtml(
      component.fileContent,
      scopeKey,
      allElementClasses,
    );

    // Inject id-derived classes onto elements with matching id attributes.
    component.fileContent = addIdClassesInHtml(
      component.fileContent,
      allIdsConverted,
      component.scopedIdNames,
    );

    // Component build scripts print markup at page time, after this pass.
    // Record the mapping so executeBuildScripts scopes that output the same way.
    if (
      scopedClassesSet &&
      (scopedClassesSet.size > 0 || allElementClasses.length > 0)
    ) {
      const scope: OutputScope = { classes: {}, elements: {} };
      for (const className of scopedClassesSet) {
        scope.classes[className] = minifyAttributeName(
          `bascik__${scopeKey}__${className}`,
        );
      }
      for (const element of new Set(allElementClasses)) {
        scope.elements[element] = minifyAttributeName(
          `bascik__${scopeKey}__el__${element}`,
        );
      }
      component.fileContent = annotateOutputScopedScripts(
        component.fileContent,
        encodeOutputScope(scope),
      );
    }
  }

  // Restore any inner content that was shielded from transforms.
  component.fileContent = restore(component.fileContent);
  if (attribute === "class") {
    component.fileContent = stripPreserveDirectives(component.fileContent);
  }

  return component;
};
export interface ComponentScriptInfo {
  relPath: string;
  code: string;
}

export interface ComponentScriptsResult {
  scriptMap: Map<string, ComponentScriptInfo>;
}

export interface ComponentScriptsOptions {
  /**
   * The component's HTML. A file that only directive scripts reference by `src=` is a
   * Node.js module, not a browser companion, so it is skipped; a file a browser
   * `<script src>` references is always claimed.
   */
  html?: string;
  /**
   * Every component HTML file. In flat layout a script whose name belongs to another
   * component (`card-header.ts` beside `card-header.html`) is left to that component
   * unless this one references it.
   */
  componentFileNames?: readonly string[];
}

/** Basenames of the `src=` values of `html`'s browser and directive scripts. */
const scriptSrcBasenames = (
  html: string,
): { browser: Set<string>; directive: Set<string> } => {
  const browser = new Set<string>();
  const directive = new Set<string>();
  if (!html.includes("<script")) return { browser, directive };
  for (const match of scanElementContents(
    html,
    "script",
    SCRIPT_ELEMENT_SCAN,
  )) {
    const openTag = html.slice(match.start, match.contentStart);
    const src = getHtmlAttributeValue(openTag, "src")?.trim();
    if (!src) continue;
    const name = basename(src.replace(/[?#].*$/, ""));
    (isDirectiveScriptOpenTag(openTag) ? directive : browser).add(name);
  }
  return { browser, directive };
};

/** Whether `nameWithoutExt` is `componentName`'s own name or one of its extras. */
const isNamedFor = (nameWithoutExt: string, componentName: string): boolean =>
  nameWithoutExt === componentName ||
  nameWithoutExt.startsWith(`${componentName}.`) ||
  nameWithoutExt.startsWith(`${componentName}-`) ||
  nameWithoutExt.startsWith(`${componentName}_`);

export const getComponentScripts = async (
  htmlFileName: string,
  scriptFileNames: string[],
  options: ComponentScriptsOptions = {},
): Promise<ComponentScriptsResult> => {
  const scriptMap = new Map<string, ComponentScriptInfo>();
  if (
    !htmlFileName ||
    !Array.isArray(scriptFileNames) ||
    scriptFileNames.length === 0
  ) {
    return { scriptMap };
  }

  const htmlDir = dirname(htmlFileName).replace(/\\/g, "/");
  // The root that actually contains this component decides flat vs subfolder
  // layout. With several roots, a global "first root" would silently fall back
  // to basename matching for every component in the other roots.
  const compDir = findComponentRoot(htmlFileName);
  const isSubfolder =
    compDir !== undefined &&
    htmlDir !== compDir &&
    htmlDir.startsWith(`${compDir}/`);
  const componentBaseName = basename(htmlFileName, ".html").toLowerCase();
  const referenced =
    options.html === undefined ? undefined : scriptSrcBasenames(options.html);
  // Longer component names this one's prefix rule would otherwise reach into.
  const siblingNames = (options.componentFileNames ?? [])
    .map((fileName) => basename(fileName, ".html").toLowerCase())
    .filter(
      (name) =>
        name !== componentBaseName && isNamedFor(name, componentBaseName),
    );

  const matchingScriptFiles = scriptFileNames.filter((scriptPath) => {
    const scriptDir = dirname(scriptPath).replace(/\\/g, "/");
    const scriptBaseName = basename(scriptPath);
    // A directive script's `src=` module runs in Node.js: never browser code.
    if (
      referenced &&
      referenced.directive.has(scriptBaseName) &&
      !referenced.browser.has(scriptBaseName)
    )
      return false;
    if (isSubfolder) {
      return scriptDir === htmlDir || scriptDir.startsWith(htmlDir + "/");
    }
    const nameWithoutExt = scriptBaseName
      .replace(COMPANION_SCRIPT_RE, "")
      .toLowerCase();
    if (!isNamedFor(nameWithoutExt, componentBaseName)) return false;
    if (referenced?.browser.has(scriptBaseName)) return true;
    return !siblingNames.some((sibling) => isNamedFor(nameWithoutExt, sibling));
  });

  matchingScriptFiles.sort((a, b) => {
    const aBase = basename(a).toLowerCase();
    const bBase = basename(b).toLowerCase();
    const aMain = aBase.replace(COMPANION_SCRIPT_RE, "") === componentBaseName;
    const bMain = bBase.replace(COMPANION_SCRIPT_RE, "") === componentBaseName;
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const scriptPath of matchingScriptFiles) {
    let code: string;
    try {
      code = (await readFile(scriptPath)).toString();
    } catch (err) {
      console.warn("warning: Failed to read script for %s", scriptPath, err);
      continue;
    }
    const relPath = relative(process.cwd(), scriptPath).replace(/\\/g, "/");
    // Referenced `.ts` browser scripts are transformed here, before scoping
    // and before any optional `minify.js` step, so raw TypeScript never
    // reaches the browser and the minifier only ever sees valid JavaScript.
    // The compiler is `scripts.typescript` (Node strip by default, a custom
    // function, or `false` to leave the file as authored). Transform errors
    // are authoring errors and must fail the component loudly, not degrade
    // to a missing script.
    if (isTypeScriptFile(scriptPath)) {
      code = await transformBrowserTypeScript(code, {
        sourcePath: relPath,
        kind: "companion",
        runtime: "browser",
      });
    }
    const baseName = basename(scriptPath);
    const info: ComponentScriptInfo = { relPath, code };

    scriptMap.set(baseName, info);
    scriptMap.set(`./${baseName}`, info);
    scriptMap.set(relPath, info);
  }

  return {
    scriptMap,
  };
};

export const namespaceScriptTags = (
  component: BascikComponent,
): BascikComponent => {
  if (!component.fileContent || !/<script\b/i.test(component.fileContent)) {
    return component;
  }
  // Script-looking examples in HTML comments are documentation, not browser
  // code. Shield comments before scanning for script tags so a fake opener in
  // a comment cannot be paired with a later real </script> and wrapped into an
  // invalid runtime script.
  const commentShield = createContentShield(component.fileContent);
  const commentMaskedContent = component.fileContent.includes("<!--")
    ? component.fileContent.replace(/<!--[\s\S]*?-->/g, (comment) =>
        commentShield.hide(comment),
      )
    : component.fileContent;

  // Only wrap <script> tags with no type or type="text/javascript"
  component.fileContent = commentShield.restore(
    replaceScriptElements(
      commentMaskedContent,
      (match, stampedOpen, code, close) => {
        // Server, stream, build, and routes scripts run in Node.js, never wrap in browser IIFE
        if (DIRECTIVE_SCRIPT_RE.test(stampedOpen)) return match;

        // The line the body starts on in the source file, recorded when the file was read.
        const { openTag: open, line: sourceLine } = takeScriptLine(stampedOpen);

        // Extract data-bascik-source attribute if present
        const sourceAttrMatch = open.match(
          /\bdata-bascik-source=["']([^"']+)["']/i,
        );
        const customSourcePath = sourceAttrMatch ? sourceAttrMatch[1] : null;

        // Clean data-bascik-source attribute from open tag
        const cleanOpen = open.replace(
          /\s*data-bascik-source=["']([^"']+)["']/i,
          "",
        );

        // Check for type attribute
        const type = getScriptType(cleanOpen);
        const isJsType = isJavaScriptScript(cleanOpen);

        const isExternal = /\s+src\s*=/i.test(cleanOpen);
        const shouldWrap =
          !isExternal && (type === undefined || type === "text/javascript");

        const targetPath =
          customSourcePath ||
          (component.fileName
            ? relative(process.cwd(), component.fileName).replace(/\\/g, "/")
            : null);

        if (isExternal) return `${open}${code}${close}`;

        // DevTools numbers a sourceURL script from the text right after `<script>`. Padding it by
        // the lines above it in the source file makes DevTools line N the file's line N.
        const startsOnNewLine = /^\r?\n/.test(code);
        const { padding, leading } = sourceLinePadding(
          targetPath ? sourceLine : undefined,
          startsOnNewLine ? "" : "\n",
        );

        if (!shouldWrap) {
          // If type is present and not text/javascript, leave unchanged.
          // If it is a JS type (like module), still add sourceURL if possible.
          if (isJsType && targetPath) {
            const sourceUrlComment = `\n//# sourceURL=${targetPath}`;
            const modulePadding = sourceLinePadding(sourceLine, "").padding;
            return `${cleanOpen}${modulePadding}${code}${sourceUrlComment}${close}`;
          }
          return `${open}${code}${close}`;
        }

        const trailing = code.endsWith("\n") ? "" : "\n";

        if (targetPath) {
          const sourceUrlComment = `\n//# sourceURL=${targetPath}`;
          return `${cleanOpen}${padding}(function() {${leading}${code}${trailing}})();${sourceUrlComment}${close}`;
        } else {
          return `${cleanOpen}(function() {${leading}${code}${trailing}})();${close}`;
        }
      },
    ),
  );
  return component;
};

// JavaScript minification is exported from js-minifier.ts.
