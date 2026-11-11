import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import {
  classifySpecifier,
  findModuleSpecifiers,
} from "./module-specifiers.ts";
import { isMainThread } from "node:worker_threads";
import {
  getComponentCss,
  extractInlineStyles,
  resolveCssImports,
} from "./styles.ts";
import { getComponentScripts } from "./javascript.ts";
import {
  COMPANION_SCRIPT_RE,
  TEST_COMPANION_SCRIPT_RE,
} from "./companion-scripts.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import {
  collectCssClasses,
  collectPreservedTargets,
  findPreservedCssTargets,
  findPreservedJsTargets,
} from "./preserved-targets.ts";
import { minifyHtml } from "./html-minifier.ts";
import { maskElementContents } from "./shielding.ts";
import { invalidComponentNameMessage } from "./component-name-validity.ts";
import { templateShapeProblems } from "./component-template-shape.ts";
import {
  transformTypeScriptScriptTags,
  TypeScriptTransformError,
  browserScriptSyntaxError,
  hasStaticModuleSyntax,
  isTypeScriptFile,
  unbundledImportError,
  unbundledModuleImports,
} from "./typescript.ts";
import { getScriptType, JAVASCRIPT_SCRIPT_TYPES } from "./script-types.ts";
import { stampScriptLines, withScriptLine } from "./script-source-lines.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import {
  BUILD_ATTR_NAME,
  BUILD_ONCE_ATTR_NAME,
  scriptDirectiveFinder,
  ROUTES_ATTR_NAME,
  SERVER_ATTR_NAME,
  STREAM_ATTR_NAME,
  isDirectiveScriptOpenTag,
} from "./html-patterns.ts";
import {
  compatibilityRules,
  findCompatibilityMatches,
} from "./compatibility-checker.ts";
import {
  cssBraceImbalanceMessage,
  findCssBraceImbalance,
} from "./css-brace-balance.ts";
import {
  ComponentCssSyntaxError,
  ComponentSyntaxError,
} from "./build-error.ts";
import { assertNoGeneratedIdClassCollisions } from "./generated-id-classes.ts";
import { stderr as colorErr } from "./colors.ts";
import {
  findMarkerAnchors,
  isRegexWhitespace,
  replaceSpans,
  scanElementContents,
  scanMarkedScripts,
} from "./element-content-scan.ts";
import {
  PLAUSIBLE_TAG_NAME,
  PRESERVE_WILDCARD_PATTERN,
} from "./config-validation.ts";
import type { BascikComponent, ComponentList } from "./types.ts";
import { decodeSource, stripBom } from "./source-text.ts";

// Component markup handling lives in the component-* modules; this module is its public entry.
export {
  createAttributeValueScanner,
  type AttributeValueCheckpoint,
  type ComponentSearchState,
} from "./component-attribute-scan.ts";
export {
  maskRawTextContent,
  maskRawTextContentWithClosure,
  spliceRawTextMask,
} from "./component-masking.ts";
export { __componentScanStatsForTests } from "./component-scan-stats.ts";
export { getFirstComponent, getTag, replaceTag } from "./component-tags.ts";
export {
  extractProps,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";
export {
  extractDefaultSlotContent,
  extractNamedSlotContent,
  replaceDefaultSlots,
  replaceNamedSlots,
} from "./component-slots.ts";
export {
  extractInheritableAttributes,
  mergeAttributesOntoRoot,
} from "./component-inheritance.ts";

/** Each compatibility rule's severity: `error` where the rules JSON says so, otherwise `warning`. */
const ruleSeverity = new Map(
  compatibilityRules.map((rule) => [rule.id, rule.severity ?? "warning"]),
);

// Warn if a component name shadows a native HTML element: every element of
// WHATWG HTML, the obsolete ones its parser still knows included, plus the
// <svg> and <math> roots of foreign content (web-standards.test.ts checks
// the set against @webref/elements).
export const NATIVE_HTML_ELEMENTS = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "basefont",
  "bdi",
  "bdo",
  "bgsound",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "isindex",
  "kbd",
  "keygen",
  "label",
  "legend",
  "li",
  "link",
  "listing",
  "main",
  "map",
  "mark",
  "marquee",
  "math",
  "menu",
  "menuitem",
  "meta",
  "meter",
  "multicol",
  "nav",
  "nextid",
  "nobr",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "plaintext",
  "pre",
  "progress",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "selectedcontent",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  "xmp",
]);

let componentListCache: ComponentList | null = null;
const componentCompatFingerprints = new Map<string, string>();

export const invalidateComponentListCache = () => {
  componentListCache = null;
};

// Absolute stylesheet path -> names of components whose CSS imported it at the
// last complete listing. Kept across cache invalidation: dev looks up an edited
// file here before the components are listed again.
let stylesheetImporters = new Map<string, Set<string>>();

/**
 * Names of components whose stylesheet (companion `.css` or inline `<style>`)
 * imports `filePath`, directly or through another import, as of the last
 * component listing. A missing imported file is included, so creating it later
 * also finds its importers.
 */
export const componentsImportingStylesheet = (filePath: string): string[] => [
  ...(stylesheetImporters.get(resolve(filePath)) ?? []),
];

const SRC_MARKER_RE = /\ssrc=["']([^"']+)["']/iy;

/**
 * `html.replace(regex, (match, preSrc, srcVal, postSrc, body) => ...)` for
 * `/<script(?=[\t\n\f\r />])((?:[^>"']|"[^"]*"|'[^']*')*?)\ssrc=["']([^"']+)["']((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi`:
 * quote-aware attributes around a whole-name `src` (never `data-src`). The
 * body is matched too: browsers ignore inline content when `src` is set, so a
 * body never stops the companion from being inlined. Linear, where the regex
 * took cubic time (`scanMarkedScripts`; the lazy first chain takes the first
 * `src` that lets the rest match, and a `src="a'` value is read as written).
 */
const replaceCompanionScriptTags = (
  html: string,
  replace: (
    match: string,
    preSrc: string,
    srcVal: string,
    postSrc: string,
    body: string,
  ) => string,
): string => {
  const markers = new Map<number, RegExpExecArray>();
  const anchors = findMarkerAnchors(html, /src=/gi, (index) => {
    if (index === 0 || !isRegexWhitespace(html.charCodeAt(index - 1)))
      return -1;
    SRC_MARKER_RE.lastIndex = index - 1;
    const marker = SRC_MARKER_RE.exec(html);
    if (marker === null) return -1;
    markers.set(index - 1, marker);
    return index - 1;
  });
  const matches = scanMarkedScripts(html, [
    {
      anchors,
      markerEnd: (anchor) => anchor + markers.get(anchor)![0].length,
      pick: "first",
    },
  ]);
  return replaceSpans(html, matches, (match, found) => {
    const marker = markers.get(found.marker)!;
    return replace(
      match,
      html.slice(found.start + 7, found.marker),
      marker[1],
      html.slice(found.marker + marker[0].length, found.contentStart - 1),
      html.slice(found.contentStart, found.contentEnd),
    );
  });
};

let anyComponentBuildScript = false;
// `<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*\s(?:${BUILD_ATTR_NAME}|${BUILD_ONCE_ATTR_NAME})(?=[\s=/>])`
// (flag `i`), in linear time.
const findComponentBuildScript = scriptDirectiveFinder(
  ["data-bascik-build", "data-bascik-build-once"],
  true,
);
const hasComponentBuildScript = (html: string): boolean =>
  findComponentBuildScript(html) !== -1;

/**
 * Whether any component, as of the last component listing, carries a
 * `data-bascik-build` script. Such a script may read any file, so a cache
 * clear (a watched input or asset edit) can change what the component
 * renders even though the component's own files did not change (prompt 157,
 * D6: the request-time manifest ran that script).
 */
export const componentsHaveBuildScripts = (): boolean =>
  anyComponentBuildScript;

/** Load all component HTML and CSS files from the configured components directory. */
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)(?:${BUILD_ATTR_NAME}|${BUILD_ONCE_ATTR_NAME})`,
  "i",
);
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_ONCE_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)${BUILD_ONCE_ATTR_NAME}`,
  "i",
);
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const SERVER_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)${SERVER_ATTR_NAME}`,
  "i",
);
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const ROUTES_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)${ROUTES_ATTR_NAME}`,
  "i",
);
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const STREAM_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)${STREAM_ATTR_NAME}`,
  "i",
);

const getLineAtOffset = (source: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
};

/**
 * Thrown when a component's `<style>` or companion stylesheet has an
 * unbalanced brace. The message names the file and line of the brace.
 */
const assertCssBracesBalanced = (
  css: string,
  displayPath: string,
  lineAt: (offset: number) => number,
  columnAt: (offset: number) => number,
): void => {
  const imbalance = findCssBraceImbalance(css);
  if (!imbalance) return;
  const line = lineAt(imbalance.offset);
  throw new ComponentCssSyntaxError(
    `[bascik] CSS error in ${displayPath}:${line}: ${cssBraceImbalanceMessage(imbalance)}`,
    { sourceFile: displayPath, line, column: columnAt(imbalance.offset) },
  );
};

/** 1-based column of `offset` in `text`. */
const columnAtOffset = (text: string, offset: number): number =>
  offset - text.lastIndexOf("\n", offset - 1);

/**
 * Relative (and `@/`) imports in a component's browser scripts (finding 25).
 * Bascik inlines the script into each page and does not bundle or publish
 * what it imports, so the browser resolves "./extra.js" against the page's
 * URL, not the component file, and the request fails at runtime.
 */
const relativeImportProblems = (
  scan: string,
  rawHtml: string,
  displayPath: string,
  componentDir: string,
  companionScripts:
    { scriptMap: Map<string, { relPath: string; code: string }> } | undefined,
): Array<{ where: string; message: string }> => {
  const problems: Array<{ where: string; message: string }> = [];
  const report = (
    code: string,
    where: (offset: number) => string,
    baseDir: string,
  ) => {
    if (!/\bimport\b/.test(code)) return;
    for (const { value, start } of findModuleSpecifiers(code)) {
      const kind = classifySpecifier(value);
      if (kind !== "relative" && kind !== "root") continue;
      const sibling =
        kind === "relative" &&
        existsSync(resolve(baseDir, value.replace(/[?#].*$/, "")));
      problems.push({
        where: where(start),
        message:
          `the import "${value}" resolves against the page URL, not the component file, because Bascik inlines this script into each page and does not bundle its imports` +
          (sibling ? "; the file beside the component is not published" : "") +
          `. Put the file in public/ and import its URL (such as "/js/${value.replace(/^(?:\.{1,2}\/|@\/)+/, "")}"), or bundle the script with a pipeline.exec step.`,
      });
    }
  };
  for (const match of scanElementContents(scan, "script", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    const openTag = scan.slice(match.start, match.contentStart);
    if (
      BUILD_DIRECTIVE_RE.test(openTag) ||
      SERVER_DIRECTIVE_RE.test(openTag) ||
      ROUTES_DIRECTIVE_RE.test(openTag) ||
      STREAM_DIRECTIVE_RE.test(openTag) ||
      /\ssrc\s*=/i.test(openTag)
    )
      continue;
    const type = getScriptType(openTag);
    if (type !== undefined && !JAVASCRIPT_SCRIPT_TYPES.has(type)) continue;
    report(
      rawHtml.slice(match.contentStart, match.contentEnd),
      (offset) =>
        `${displayPath}:${getLineAtOffset(rawHtml, match.contentStart + offset)}`,
      componentDir,
    );
  }
  const seen = new Set<string>();
  for (const { relPath, code } of companionScripts?.scriptMap.values() ?? []) {
    if (seen.has(relPath) || !/\.m?js$/i.test(relPath)) continue;
    seen.add(relPath);
    report(
      code,
      (offset) => `${relPath}:${getLineAtOffset(code, offset)}`,
      dirname(resolve(process.cwd(), relPath)),
    );
  }
  return problems;
};

/**
 * Thrown when a component's `<style>` or `<script>` is never closed. The
 * browser reads everything after it, the rest of the component and of the
 * page, as CSS or JavaScript, so the content disappears. `scan` is the
 * component with comments, `<textarea>`, and preserved elements masked to
 * same-length text, so its offsets are offsets in `rawHtml`.
 */
/**
 * Fail on a browser script that does not parse: an inline `<script>` (a
 * `type="module"` one with the module grammar) or a companion `.js`/`.mjs`
 * file. The browser would reject the whole block, so the component would
 * ship dead with a green build. TypeScript is parsed where it is stripped,
 * and directive scripts where they are compiled, so both are skipped here.
 */
const assertBrowserScriptsParse = async (
  scan: string,
  rawHtml: string,
  displayPath: string,
  companionScripts:
    { scriptMap: Map<string, { relPath: string; code: string }> } | undefined,
): Promise<void> => {
  for (const match of scanElementContents(scan, "script", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    const openTag = scan.slice(match.start, match.contentStart);
    if (
      BUILD_DIRECTIVE_RE.test(openTag) ||
      SERVER_DIRECTIVE_RE.test(openTag) ||
      ROUTES_DIRECTIVE_RE.test(openTag) ||
      STREAM_DIRECTIVE_RE.test(openTag) ||
      /\ssrc\s*=/i.test(openTag)
    ) {
      continue;
    }
    const type = getScriptType(openTag);
    if (type !== undefined && !JAVASCRIPT_SCRIPT_TYPES.has(type)) continue;
    const body = rawHtml.slice(match.contentStart, match.contentEnd);
    const problem = await browserScriptSyntaxError(
      body,
      displayPath,
      type === "module" ? "module" : "classic",
    );
    if (!problem) continue;
    const bodyStartLine = getLineAtOffset(rawHtml, match.contentStart);
    const line = bodyStartLine + problem.line - 1;
    const column =
      problem.line === 1
        ? columnAtOffset(rawHtml, match.contentStart) + problem.column - 1
        : problem.column;
    throw new ComponentSyntaxError(
      `[bascik] JavaScript error in ${displayPath}:${line}: ${problem.detail}. ` +
        "The browser would reject this whole <script>, so the build stops here.",
      { sourceFile: displayPath, line, column },
    );
  }
  const seen = new Set<string>();
  for (const { relPath, code } of companionScripts?.scriptMap.values() ?? []) {
    if (seen.has(relPath) || !/\.m?js$/i.test(relPath)) continue;
    seen.add(relPath);
    const problem = await browserScriptSyntaxError(
      code,
      relPath,
      /\.mjs$/i.test(relPath) ? "module" : "classic",
    );
    if (!problem) continue;
    throw new ComponentSyntaxError(
      `[bascik] JavaScript error in ${relPath}:${problem.line}: ${problem.detail}. ` +
        "The browser would reject this script, so the build stops here.",
      { sourceFile: relPath, line: problem.line, column: problem.column },
    );
  }
};

const assertRawTextElementsClosed = (
  scan: string,
  rawHtml: string,
  displayPath: string,
): void => {
  // `<style>` text in a closed script (a string) or `<script>` text in a
  // closed stylesheet is content, not a tag.
  const closed = ["style", "script"]
    .flatMap((name) =>
      scanElementContents(scan, name, {
        opener: "tag-space",
        closer: "attributes",
      }),
    )
    .sort((a, b) => a.start - b.start);
  // Merged into disjoint spans, so each lookup is a binary search.
  const spans: Array<[number, number]> = [];
  for (const { start, end } of closed) {
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  const insideClosed = (at: number): boolean => {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle][1] <= at) low = middle + 1;
      else high = middle;
    }
    return low < spans.length && spans[low][0] <= at;
  };
  for (const name of ["style", "script"]) {
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const opener = new RegExp(`<${name}(?=[\\t\\n\\f\\r />])`, "gi");
    for (const match of scan.matchAll(opener)) {
      const at = match.index;
      if (insideClosed(at)) continue;
      const line = getLineAtOffset(rawHtml, at);
      throw new ComponentSyntaxError(
        `[bascik] HTML error in ${displayPath}:${line}: <${name}> is never closed, so the browser reads ` +
          `the rest of the component and the page after it as ${name === "style" ? "CSS" : "JavaScript"} ` +
          `and that content disappears. Add </${name}> where the ${name === "style" ? "stylesheet" : "script"} ends.`,
        { sourceFile: displayPath, line, column: columnAtOffset(rawHtml, at) },
      );
    }
  }
};

const warnComponentCompatibility = async (
  rawHtml: string,
  fileName: string,
  componentCssFileNames: string[],
  companionScripts: Awaited<ReturnType<typeof getComponentScripts>> | undefined,
): Promise<void> => {
  const cssFileName = componentCssFileNames.find(
    (c) => c.replace(/\.css$/, ".html") === fileName,
  );
  let rawCss = "";
  if (cssFileName) {
    try {
      rawCss = stripBom(await readFile(cssFileName, "utf8"));
    } catch {
      rawCss = "";
    }
  }
  const companionFingerprint =
    companionScripts && companionScripts.scriptMap.size > 0
      ? [
          ...new Map(
            [...companionScripts.scriptMap.values()].map((s) => [
              s.relPath,
              s.code,
            ]),
          ).entries(),
        ]
          .map(([rel, code]) => `${rel}::${code}`)
          .join("\0")
      : "";
  const fingerprint = `${rawHtml}\0${rawCss}\0${companionFingerprint}`;
  if (componentCompatFingerprints.get(fileName) === fingerprint) {
    return;
  }

  const relHtml =
    relative(process.cwd(), fileName).replace(/\\/g, "/") || fileName;
  // Mask each comment to same-length whitespace (keeping its line breaks) so offsets
  // in the scanned text are offsets in rawHtml and every warning lands on its real line.
  const noComments = rawHtml.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  const nonCodeScan = maskElementContents(noComments, [
    "textarea",
    ...(BascikConfig.scoping?.preserve ?? ["code"])
      .map((t) => String(t))
      .filter(
        (t) => PLAUSIBLE_TAG_NAME.test(t) || PRESERVE_WILDCARD_PATTERN.test(t),
      ),
  ]);

  // An unclosed <style> or <script> swallows the rest of the page, and an
  // unbalanced brace would nest or drop other components' rules in the page
  // stylesheet: stop before the fingerprint is stored, so an unchanged broken
  // file fails again on the next listing.
  assertRawTextElementsClosed(nonCodeScan, rawHtml, relHtml);
  for (const styleMatch of scanElementContents(nonCodeScan, "style", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    assertCssBracesBalanced(
      nonCodeScan.slice(styleMatch.contentStart, styleMatch.contentEnd),
      relHtml,
      (offset) => getLineAtOffset(rawHtml, styleMatch.contentStart + offset),
      (offset) => columnAtOffset(rawHtml, styleMatch.contentStart + offset),
    );
  }
  if (cssFileName && rawCss) {
    assertCssBracesBalanced(
      rawCss,
      relative(process.cwd(), cssFileName).replace(/\\/g, "/") || cssFileName,
      (offset) => getLineAtOffset(rawCss, offset),
      (offset) => columnAtOffset(rawCss, offset),
    );
  }
  await assertBrowserScriptsParse(
    nonCodeScan,
    rawHtml,
    relHtml,
    companionScripts,
  );
  componentCompatFingerprints.set(fileName, fingerprint);

  for (const { where, message } of relativeImportProblems(
    nonCodeScan,
    rawHtml,
    relHtml,
    dirname(fileName),
    companionScripts,
  )) {
    console.warn(
      `${colorErr.tag("warn", "[bascik] warning")} in ${colorErr.cyan(where)}: ${message}`,
    );
  }
  for (const { offset, message } of templateShapeProblems(nonCodeScan)) {
    console.warn(
      `${colorErr.tag("warn", "[bascik] warning")} in ${colorErr.cyan(`${relHtml}:${getLineAtOffset(rawHtml, offset)}`)}: ${message}`,
    );
  }

  const seenWarnings = new Set<string>();
  const emitWarning = (
    displayPath: string,
    line: number,
    ruleId: string,
    message: string,
    suggestion: string,
  ) => {
    const key = `${displayPath}:${line}:${ruleId}:${message}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    if (componentWarningsSilenced) return;
    // The rule's own severity from the rules JSON, the one the language server and --check report.
    const severity = ruleSeverity.get(ruleId) ?? "warning";
    console.warn(
      `${colorErr.tag(severity === "error" ? "error" : "warn", `[bascik] ${severity}`)} ${colorErr.dim(`(${ruleId})`)} in ${colorErr.cyan(`${displayPath}:${line}`)}: ${message} ${colorErr.dim(suggestion)}`,
    );
  };

  // `(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style(?:[\t\n\f\r /][^>]*)?>`
  // (flags `gi`), in linear time.
  for (const styleMatch of scanElementContents(nonCodeScan, "style", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    const styleBody = nonCodeScan.slice(
      styleMatch.contentStart,
      styleMatch.contentEnd,
    );
    const styleOffset = styleMatch.contentStart;
    for (const m of findCompatibilityMatches(styleBody, "css")) {
      emitWarning(
        relHtml,
        getLineAtOffset(rawHtml, styleOffset + m.index),
        m.rule.id,
        m.rule.message,
        m.rule.suggestion,
      );
    }
  }

  // `(<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>`
  // (flags `gi`), in linear time.
  for (const scriptMatch of scanElementContents(nonCodeScan, "script", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    const openTag = nonCodeScan.slice(
      scriptMatch.start,
      scriptMatch.contentStart,
    );
    if (
      BUILD_DIRECTIVE_RE.test(openTag) ||
      SERVER_DIRECTIVE_RE.test(openTag) ||
      ROUTES_DIRECTIVE_RE.test(openTag) ||
      STREAM_DIRECTIVE_RE.test(openTag)
    ) {
      continue;
    }
    const typeMatch = openTag.match(
      /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
    );
    const typeVal = (
      typeMatch?.[1] ??
      typeMatch?.[2] ??
      typeMatch?.[3] ??
      ""
    ).toLowerCase();
    const isJs =
      !typeVal ||
      typeVal === "module" ||
      typeVal === "text/javascript" ||
      typeVal === "application/javascript" ||
      typeVal === "text/typescript";
    if (isJs) {
      const scriptBody = nonCodeScan.slice(
        scriptMatch.contentStart,
        scriptMatch.contentEnd,
      );
      const scriptOffset = scriptMatch.contentStart;
      for (const m of findCompatibilityMatches(scriptBody, "js")) {
        emitWarning(
          relHtml,
          getLineAtOffset(rawHtml, scriptOffset + m.index),
          m.rule.id,
          m.rule.message,
          m.rule.suggestion,
        );
      }
    }
  }

  if (cssFileName && rawCss) {
    const relCss =
      relative(process.cwd(), cssFileName).replace(/\\/g, "/") || cssFileName;
    for (const m of findCompatibilityMatches(rawCss, "css")) {
      emitWarning(
        relCss,
        getLineAtOffset(rawCss, m.index),
        m.rule.id,
        m.rule.message,
        m.rule.suggestion,
      );
    }
  }

  if (companionScripts && companionScripts.scriptMap.size > 0) {
    const visitedCompanions = new Set<string>();
    for (const scriptInfo of companionScripts.scriptMap.values()) {
      if (visitedCompanions.has(scriptInfo.relPath)) continue;
      visitedCompanions.add(scriptInfo.relPath);
      for (const m of findCompatibilityMatches(scriptInfo.code, "js")) {
        emitWarning(
          scriptInfo.relPath,
          getLineAtOffset(scriptInfo.code, m.index),
          m.rule.id,
          m.rule.message,
          m.rule.suggestion,
        );
      }
    }
  }

  warnPreservedTargets(
    noComments,
    nonCodeScan,
    rawHtml,
    relHtml,
    cssFileName,
    rawCss,
    companionScripts,
    emitWarning,
  );
};

/**
 * Warns for component CSS rules and client-script class queries that can only target preserved elements
 * (`scoping.preserve` tags, `data-bascik-preserve` elements, and their contents). Those keep their literal
 * class and id while the selectors are renamed, so the rule never applies and the query finds nothing.
 */
const warnPreservedTargets = (
  markup: string,
  nonCodeScan: string,
  rawHtml: string,
  relHtml: string,
  cssFileName: string | undefined,
  rawCss: string,
  companionScripts: Awaited<ReturnType<typeof getComponentScripts>> | undefined,
  emitWarning: (
    displayPath: string,
    line: number,
    ruleId: string,
    message: string,
    suggestion: string,
  ) => void,
): void => {
  const targets = collectPreservedTargets(
    markup,
    (BascikConfig.scoping?.preserve ?? ["code"]).map((t) => String(t)),
  );
  if (
    targets.classes.size === 0 &&
    targets.ids.size === 0 &&
    targets.tags.size === 0
  ) {
    return;
  }
  const relCss =
    cssFileName &&
    (relative(process.cwd(), cssFileName).replace(/\\/g, "/") || cssFileName);
  const styles = [
    ...scanElementContents(nonCodeScan, "style", {
      opener: "tag-space",
      closer: "attributes",
    }),
  ].map((match) => ({
    css: nonCodeScan.slice(match.contentStart, match.contentEnd),
    offset: match.contentStart,
  }));
  const cssClasses = new Set<string>();
  for (const { css } of styles) {
    for (const className of collectCssClasses(css)) cssClasses.add(className);
  }
  for (const className of collectCssClasses(rawCss)) cssClasses.add(className);

  for (const { css, offset } of styles) {
    for (const m of findPreservedCssTargets(css, targets)) {
      emitWarning(
        relHtml,
        getLineAtOffset(rawHtml, offset + m.index),
        "css-preserved-target",
        m.message,
        m.suggestion,
      );
    }
  }
  if (relCss) {
    for (const m of findPreservedCssTargets(rawCss, targets)) {
      emitWarning(
        relCss,
        getLineAtOffset(rawCss, m.index),
        "css-preserved-target",
        m.message,
        m.suggestion,
      );
    }
  }
  if (cssClasses.size === 0) return;
  for (const scriptMatch of scanElementContents(nonCodeScan, "script", {
    opener: "tag-space",
    closer: "attributes",
  })) {
    const openTag = nonCodeScan.slice(
      scriptMatch.start,
      scriptMatch.contentStart,
    );
    if (
      BUILD_DIRECTIVE_RE.test(openTag) ||
      SERVER_DIRECTIVE_RE.test(openTag) ||
      ROUTES_DIRECTIVE_RE.test(openTag) ||
      STREAM_DIRECTIVE_RE.test(openTag)
    ) {
      continue;
    }
    const typeVal = (
      /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
        .exec(openTag)
        ?.slice(1)
        .find((v) => v !== undefined) ?? ""
    ).toLowerCase();
    if (
      typeVal &&
      typeVal !== "module" &&
      typeVal !== "text/javascript" &&
      typeVal !== "application/javascript" &&
      typeVal !== "text/typescript"
    ) {
      continue;
    }
    const body = nonCodeScan.slice(
      scriptMatch.contentStart,
      scriptMatch.contentEnd,
    );
    for (const m of findPreservedJsTargets(body, targets, cssClasses)) {
      emitWarning(
        relHtml,
        getLineAtOffset(rawHtml, scriptMatch.contentStart + m.index),
        "js-preserved-target",
        m.message,
        m.suggestion,
      );
    }
  }
  if (companionScripts && companionScripts.scriptMap.size > 0) {
    const visited = new Set<string>();
    for (const scriptInfo of companionScripts.scriptMap.values()) {
      if (visited.has(scriptInfo.relPath)) continue;
      visited.add(scriptInfo.relPath);
      for (const m of findPreservedJsTargets(
        scriptInfo.code,
        targets,
        cssClasses,
      )) {
        emitWarning(
          scriptInfo.relPath,
          getLineAtOffset(scriptInfo.code, m.index),
          "js-preserved-target",
          m.message,
          m.suggestion,
        );
      }
    }
  }
};

/**
 * The companion script a component's `<script src>` names, if any. Only a
 * relative reference can: a URL (`https:`, `//host/`) or a root-absolute
 * path (`/vendor/x.js`) is another file the browser loads, even when its
 * last segment is a companion's file name, and stays as written. A relative
 * reference is resolved against the component's folder; a bare file name
 * (`nav-bar.js`, `./nav-bar.js`) matches a companion anywhere in the
 * component's folder, as the companion lookup lists them.
 */
const companionScriptFor = <Info>(
  scriptMap: Map<string, Info>,
  src: string,
  componentFileName: string,
): Info | undefined => {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(src) || /^[/\\]/.test(src))
    return undefined;
  const direct = scriptMap.get(src);
  if (direct) return direct;
  const componentDir = relative(
    process.cwd(),
    dirname(resolve(process.cwd(), componentFileName)),
  ).replace(/\\/g, "/");
  return scriptMap.get(posix.join(componentDir, src.replace(/\\/g, "/")));
};

/**
 * Derives the component tag name from a file path.
 * Lowercases the base name without the file extension.
 */
/**
 * A hyphenated name to suggest for a component file without one: camelCase and underscores split into
 * words (`MyCard` -> `my-card`), a single word gets an `app-` prefix (`card` -> `app-card`).
 */
export const suggestHyphenatedName = (fileName: string): string => {
  const base = fileName.replace(/^.*[\\/]/, "").split(".")[0];
  const words = base
    .split(/_+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.length > 1 ? words.join("-") : `app-${words[0] ?? base}`;
};

let componentWarningsSilenced = false;

/**
 * Silences the console warnings `listComponents` prints while it reads components: the scoping
 * compatibility rules and the component-name advice. `bascik --check` turns them off because it reports
 * the same findings, once, from the language server.
 */
export const setComponentWarningsSilenced = (silenced: boolean): void => {
  componentWarningsSilenced = silenced;
};

export const deriveComponentName = (fileName: string): string => {
  return fileName
    .replace(/^.*[\\/]/, "")
    .split(".")[0]
    .toLowerCase();
};

// Markup, stylesheets, and every COMPANION_SCRIPT_RE extension. `bascik add`
// copies the same set, so a published component arrives with every file the
// build reads.
export const COMPONENT_FILE_RE = /\.(html|css|js|mjs|ts|mts)$/;

/** A file `listComponents` reads: markup, a stylesheet, or a companion script. */
export const isComponentSourceFile = (path: string): boolean =>
  COMPONENT_FILE_RE.test(path);
const DEFAULT_COMPONENT_ROOT = "src/components";

/**
 * Scan one components root. A missing `src/components` (the default) holds no
 * components: a pages-only site is valid, and an unmatched tag is still
 * reported. Any other missing root was named on purpose, so it is an error
 * that names the path, most often a typo. Unreadable roots still fail with the
 * original error.
 */
export const readComponentRoot = async (
  root: string,
  cwd = process.cwd(),
): Promise<string[]> => {
  try {
    return (await deepReadDirFlat(root, COMPONENT_FILE_RE)) ?? [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const display = relative(cwd, root).replace(/\\/g, "/") || ".";
    if (code === "ENOENT" && display === DEFAULT_COMPONENT_ROOT) return [];
    const problem = code === "ENOENT" ? "does not exist" : "is not a directory";
    throw new Error(
      `components directory "${display}" ${problem}.\n` +
        `  It is listed in directory.components in your Bascik config. Create the directory, or fix or remove the entry.`,
      { cause: error },
    );
  }
};

export const listComponents = async (
  componentRoots: readonly string[] = BascikConfig.directory.components,
): Promise<ComponentList> => {
  const isDefaultRoots = componentRoots === BascikConfig.directory.components;
  if (isDefaultRoots && componentListCache) return componentListCache;
  // Every configured root is scanned; the union feeds one collision map so a
  // duplicate filename across roots is the same error as across subfolders.
  const componentFileNames = (
    await Promise.all(componentRoots.map((root) => readComponentRoot(root)))
  ).flat();
  const componentHtmlFileNames = (componentFileNames as string[]).filter(
    (fileName) =>
      fileName.match(/\.html$/) && !fileName.match(/\.(test|spec)\.html$/),
  );
  const componentCssFileNames = (componentFileNames as string[]).filter(
    (fileName) =>
      fileName.match(/\.css$/) && !fileName.match(/\.(test|spec)\.css$/),
  );
  const componentScriptFileNames = (componentFileNames as string[]).filter(
    (fileName) =>
      COMPANION_SCRIPT_RE.test(fileName) &&
      !TEST_COMPANION_SCRIPT_RE.test(fileName),
  );
  // Check for duplicate component names across files
  const nameToFilePaths = new Map<string, string[]>();
  for (const fileName of componentHtmlFileNames) {
    const componentName = deriveComponentName(fileName);
    const existing = nameToFilePaths.get(componentName) ?? [];
    existing.push(fileName);
    nameToFilePaths.set(componentName, existing);
  }

  const collisions: string[] = [];
  for (const [tag, paths] of nameToFilePaths.entries()) {
    if (paths.length > 1) {
      const formattedPaths = paths
        .map((p) => `  ${p.replace(/\\/g, "/")}`)
        .join("\n");
      collisions.push(
        `error: two component files both define the tag <${tag}>\n` +
          `${formattedPaths}\n` +
          `  Component names come from the filename, so neither subfolders nor the roots\n` +
          `  listed in directory.components create separate namespaces.\n` +
          `  Rename one file, for example marketing-${tag}.html.`,
      );
    }
  }

  if (collisions.length > 0) {
    throw new Error(collisions.join("\n\n"));
  }

  const nextStylesheetImporters = new Map<string, Set<string>>();
  const components = await Promise.all(
    componentHtmlFileNames.map(async (fileName) => {
      // Name the file name without the extension.
      // Name is used in all the mappings components
      const componentName = deriveComponentName(fileName);
      const invalidName = invalidComponentNameMessage(componentName, fileName);
      if (componentWarningsSilenced) {
        // --check reports these itself.
      } else if (invalidName) {
        console.warn(invalidName);
      } else if (NATIVE_HTML_ELEMENTS.has(componentName)) {
        console.warn(
          `warning: Component "${componentName}" has the same name as a native HTML element. ` +
            `This may cause unexpected behavior — consider a hyphenated name like "${suggestHyphenatedName(fileName)}".`,
        );
      } else if (!componentName.includes("-")) {
        console.warn(
          `warning: Component "${componentName}" is not hyphenated. ` +
            `Under WHATWG HTML §4.13, custom elements should include a hyphen (e.g. "${suggestHyphenatedName(fileName)}") to avoid collisions with future HTML standards.`,
        );
      }
      let fileContentBuffer: Buffer;
      let cssFileContent: string | undefined;
      let companionScripts:
        Awaited<ReturnType<typeof getComponentScripts>> | undefined;
      const importedStylesheets = new Set<string>();
      const recordImportedStylesheets = () => {
        for (const path of importedStylesheets) {
          const importers =
            nextStylesheetImporters.get(path) ?? new Set<string>();
          importers.add(componentName);
          nextStylesheetImporters.set(path, importers);
        }
      };
      try {
        const fileContentRead = readFile(fileName);
        [fileContentBuffer, cssFileContent, companionScripts] =
          await Promise.all([
            fileContentRead,
            getComponentCss(
              fileName,
              componentCssFileNames,
              importedStylesheets,
            ),
            // The HTML tells which scripts are browser companions and which are
            // directive `src=` modules; the other components' names keep the
            // flat-layout prefix rule out of a sibling's scripts.
            fileContentRead.then((buffer) =>
              getComponentScripts(fileName, componentScriptFileNames, {
                html: decodeSource(buffer),
                componentFileNames: componentHtmlFileNames,
              }),
            ),
          ]);
      } catch (e) {
        // A companion `.ts` that cannot be transformed is an authoring error in
        // the user's source, not an I/O hiccup; surface it instead of shipping
        // the component without its script.
        if (e instanceof TypeScriptTransformError) throw e;
        console.warn("warning: Failed to process %s", fileName, e);
        recordImportedStylesheets();
        return {};
      }

      const rawContent = decodeSource(fileContentBuffer);
      if (!rawContent.trim()) {
        // Often a file just created in the editor: say why its usages vanish.
        const absolute = resolve(fileName);
        const displayPath = (
          absolute.startsWith(process.cwd())
            ? relative(process.cwd(), absolute)
            : fileName
        ).replace(/\\/g, "/");
        console.warn(
          `warning: Component "${componentName}" (${displayPath}) is empty, ` +
            `so every <${componentName}> renders nothing until the file has markup.`,
        );
      }
      await warnComponentCompatibility(
        rawContent,
        fileName,
        componentCssFileNames,
        companionScripts,
      );
      // Record every script's source position now: style extraction, build
      // scripts, and minification below all move scripts around. Directive
      // scripts first, because the browser-script stamp adds characters that
      // would shift columns on a shared line. Neither stamp adds newlines.
      const stampedContent = stampScriptLines(
        stampDirectiveSources(rawContent, fileName),
      );
      // Once scripts render component-wide markup before expansion. The result
      // then follows the same scoping and expansion path as authored markup.
      const onceResolvedContent = BUILD_ONCE_DIRECTIVE_RE.test(stampedContent)
        ? await executeBuildScripts(stampedContent, fileName, null, {
            once: true,
          })
        : stampedContent;
      let resolvedContent = onceResolvedContent;

      if (companionScripts && companionScripts.scriptMap.size > 0) {
        resolvedContent = replaceCompanionScriptTags(
          resolvedContent,
          (
            match: string,
            preSrc: string,
            srcVal: string,
            postSrc: string,
            ignoredBody: string,
          ) => {
            // A directive script's `src=` is a Node.js module that its own
            // runtime resolves and executes, never browser code to inline.
            if (isDirectiveScriptOpenTag(`<script${preSrc} ${postSrc}>`)) {
              return match;
            }
            const scriptInfo = companionScriptFor(
              companionScripts!.scriptMap,
              srcVal,
              fileName,
            );
            if (scriptInfo) {
              if (ignoredBody.trim()) {
                console.warn(
                  `warning: <script src="${srcVal}"> in "${fileName}" has inline content, which browsers ignore when src is set. ` +
                    `Bascik inlines "${scriptInfo.relPath}" and drops that content. Move it into the companion file or a separate <script>.`,
                );
              }
              const otherAttrs = `${preSrc}${postSrc}`
                .replace(/\s+/g, " ")
                .trim();
              const attrStr = otherAttrs ? ` ${otherAttrs}` : "";
              // A companion script inlined here becomes a classic <script>
              // and is later wrapped in an IIFE unless the referencing tag is
              // type="module" (native ES modules are never wrapped). Static
              // import/export surviving the TypeScript strip would otherwise
              // throw a SyntaxError in the browser; fail the build instead.
              if (
                getScriptType(`<script${attrStr}>`) !== "module" &&
                hasStaticModuleSyntax(scriptInfo.code)
              ) {
                throw new TypeScriptTransformError(
                  `[bascik] TypeScript transformation failed in "${scriptInfo.relPath}": ` +
                    `the script contains a static import/export declaration, which is only valid in an ES module. ` +
                    `Bascik would otherwise wrap this in a classic script IIFE and it would throw a SyntaxError in the browser. ` +
                    `Mark the referencing <script src="${srcVal}"> tag type="module" (native ES modules are never wrapped), ` +
                    `or bundle this file with esbuild, swc, or another tool first so it has no import/export left.`,
                );
              }
              // A TypeScript module companion is inlined, not bundled: an
              // import of a sibling file would resolve against the page URL.
              if (
                isTypeScriptFile(scriptInfo.relPath) &&
                getScriptType(`<script${attrStr}>`) === "module"
              ) {
                const unbundled = unbundledModuleImports(scriptInfo.code);
                if (unbundled.length)
                  throw unbundledImportError(
                    scriptInfo.relPath,
                    relative(
                      process.cwd(),
                      resolve(process.cwd(), fileName),
                    ).replace(/\\/g, "/"),
                    srcVal,
                    unbundled,
                  );
              }
              // The companion's first line is line 1 of its own sourceURL file.
              const openTag = withScriptLine(
                `<script${attrStr} data-bascik-source="${scriptInfo.relPath}">`,
                1,
              );
              return `${openTag}${scriptInfo.code}\n</script>`;
            }
            return match;
          },
        );
      }
      // Inline `<script type="text/typescript">` blocks become ordinary
      // JavaScript here, before HTML minification hoists scripts and before
      // page-time scoping and optional `minify.js`. Ordinary `<script>` blocks
      // are left alone; TypeScript syntax in one is diagnosed, never rewritten.
      resolvedContent = await transformTypeScriptScriptTags(
        resolvedContent,
        fileName,
      );
      const { html: cleanedContent, css: inlineCss } =
        extractInlineStyles(resolvedContent);
      const resolvedInlineCss = inlineCss
        ? await resolveCssImports(
            inlineCss,
            fileName,
            undefined,
            importedStylesheets,
          )
        : "";
      recordImportedStylesheets();
      const combinedCss = [cssFileContent, resolvedInlineCss]
        .filter(Boolean)
        .join("\n");
      let minifiedContent: string;
      try {
        minifiedContent = BascikConfig.minify?.html
          ? minifyHtml(cleanedContent)
          : cleanedContent;
      } catch (minErr) {
        const behavior = BascikConfig.onMinifyError ?? "error";
        if (behavior === "error") {
          console.error(
            `[bascik] HTML minification failed for component "${fileName}":`,
            minErr,
          );
          throw minErr;
        }
        console.warn(
          `[bascik] HTML minification failed for component "${fileName}", proceeding unminified:`,
          minErr,
        );
        minifiedContent = cleanedContent;
      }
      const component: BascikComponent = {
        name: componentName,
        fileName,
        fileContent: minifiedContent,
        scriptDependenciesContent: rawContent,
      };
      if (combinedCss) {
        component.cssFileContent = combinedCss;
      }
      return component;
    }),
  );
  stylesheetImporters = nextStylesheetImporters;
  anyComponentBuildScript = (components as BascikComponent[]).some(
    (component) =>
      hasComponentBuildScript(
        component.scriptDependenciesContent ?? component.fileContent ?? "",
      ),
  );
  const builtList = (components as BascikComponent[]).reduce(
    (acc: ComponentList, { name, ...rest }) => {
      if (!name) return acc;
      acc[name] = rest as Omit<BascikComponent, "name">;
      return acc;
    },
    {} as ComponentList,
  );
  // Two components whose `#id` rules generate one class would style each
  // other's elements. Checked once per list, before it is cached, so every
  // consumer stops on it; the main thread loads the list before any page
  // worker gets a job, so a worker never needs to repeat the check.
  if (isMainThread) await assertNoGeneratedIdClassCollisions(builtList);
  if (isDefaultRoots) {
    componentListCache = builtList;
  }
  return builtList;
};

/** The companion script inlining scan, for the linear-time tests. */
export const __companionScriptTagsForTests = replaceCompanionScriptTags;
