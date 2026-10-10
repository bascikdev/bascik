import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { minifyAttributeName } from "./names.ts";
import { maskCssSyntax } from "./css-tokenizer.ts";
import { shieldElementContents } from "./shielding.ts";
import { readStartTagAttributes } from "./html-scanner.ts";
import type { BascikComponent } from "./types.ts";

// CSS unit keywords that are not valid HTML element names.  A CSS syntax
// error (e.g. breaking `0.7rem 1em` across two lines) can place a unit
// keyword at column 0 where the element-selector regex would otherwise
// match it and produce a garbled scoped class name.
// Also includes CSS @keyframes pseudo-selectors (`from`, `to`) which are
// never HTML element names and must not be converted to scoped classes.
const CSS_UNIT_KEYWORDS = new Set([
  // Relative length
  "rem", "ex", "rex", "cap", "rcap", "ch", "rch", "ic", "ric", "lh", "rlh",
  // Viewport
  "vw", "vh", "vmin", "vmax",
  "svw", "svh", "svmin", "svmax",
  "dvw", "dvh", "dvmin", "dvmax",
  "lvw", "lvh", "lvmin", "lvmax",
  // Container query
  "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax",
  // Absolute length
  "px", "cm", "mm", "in", "pt", "pc",
  // Angle
  "deg", "rad", "grad", "turn",
  // Time  (note: "s" IS an HTML element, so it is intentionally omitted)
  "ms",
  // Frequency
  "hz", "khz",
  // Resolution
  "dpi", "dpcm", "dppx",
  // CSS @keyframes pseudo-selectors — not HTML elements
  "from", "to",
  // Root/structural elements — never inside a component; must not be hashed
  // so that cross-boundary selectors like `html[data-theme="light"] .class`
  // compile correctly in component CSS.
  "html", "body", "head",
]);

export const convertCssElementSelectorsToClasses = (
  css: string,
  componentName: string,
): { css: string; elementsConvertedClasses: string[] } => {
  // Deduplicate: use a Set so the same element name is only pushed once even
  // if it appears in multiple selector passes.  addElementClassesInHtml loops
  // over this list, so duplicates would inject the class twice.
  const seen = new Set<string>();
  const elementsConvertedClasses: string[] = [];

  const toClass = (elementName: string): string => {
    // CSS unit keywords (rem, vw, px, …) are not HTML elements.  A syntax
    // error in the user's CSS can place them at column 0 where the regex
    // would otherwise match.  Return unchanged so the unit is preserved as-is.
    if (CSS_UNIT_KEYWORDS.has(elementName.toLowerCase())) return elementName;
    if (!seen.has(elementName)) {
      seen.add(elementName);
      elementsConvertedClasses.push(elementName);
    }
    return `.${minifyAttributeName(`bascik__${componentName}__el__${elementName}`)}`;
  };

  // Pass 1: standalone element selectors after a selector boundary.
  // Handles top-level rules and indented selectors inside at-rules:
  //   p { }
  //   @media (...) { p { } }
  //   p:hover { }
  //   tr:nth-child(2n+1) { }
  //   p:not(.lead) { }
  // The context-aware lookahead confirms we are still in selector position.
  // Element names start with a letter (`[a-z][a-z1-6]*`), so @keyframes stops
  // such as `40%` or `0%, 100%` are never mistaken for element selectors.
  let result = css.replace(
    /(^\s*|[;{}]\s*)([a-z][a-z1-6]*)(?![\w-])(?=[^{};]*\{)/gim,
    (_match, prefix: string, elementName: string) => `${prefix}${toClass(elementName)}`,
  );

  // Pass 2: same-line comma-separated selector list, e.g. `h1, h2 { }`.
  // Multi-line lists (`h1,\nh2`) are already handled by Pass 1.
  // The context-aware lookahead [^{};)]*\{ confirms selector position:
  //   - In selector context, `{` follows before any `;` or `}`.
  //   - In value context (property values, gradient functions, etc.) a
  //     `;`, `}`, or `)` always appears before the next `{`.
  // Adding `)` to the stop set is essential — it prevents false positives
  // inside :is(), :where(), :has() pseudo-functions (e.g. h2 in :is(p, h2)).
  result = result.replace(/(?<=,[ \t]*)[a-z][a-z1-6]*(?![\w-])(?=[^{};)]*\{)/g, toClass);

  // Pass 3: element selectors in CSS nesting context (W3C CSS Nesting Module).
  // Handles:
  //   - Explicit nesting: `& p { }`, `& > h2 { }`, `&>h2 { }`, `& + li { }`, `& ~ span { }`.
  //   - 2023 Relaxed direct combinator nesting without explicit `&`:
  //     `> h2 { }`, `+ li { }`, `~ span { }`.
  result = result.replace(
    /(?<=&\s*(?:[>+~]\s*)?)[a-z][a-z1-6]*(?![\w-])(?=[^{};]*\{)/g,
    toClass,
  );
  result = result.replace(
    /(?<=(?:^|[;{}])\s*[>+~]\s*)[a-z][a-z1-6]*(?![\w-])(?=[^{};]*\{)/g,
    toClass,
  );

  // Pass 4: element selectors that are descendants of an already-scoped class.
  // Handles `.foo p {}`, `.foo > h2 {}`, `.foo>h2 {}`, `.foo + li {}`, `.foo ~ span {}`,
  // and elements following pseudo-classes/attributes (`.foo:checked + label {}`).
  //
  // After Pass 1 (class scoping), class names become `bascik__…__foo` or a
  // 12-character hash when identifier minification is enabled. Matching the
  // class selector itself keeps the anchor in selector position. The negative
  // lookahead `(?![\w-])` prevents
  // matching the start of another scoped class name (e.g. `bascik__comp__bar`)
  // or a prefix of a hyphenated custom element such as `code-block`.
  //
  // Note: this pass only applies after Pass 1 has scoped the class selector.
  let previousResult: string;
  do {
    previousResult = result;
    result = result.replace(
      /(?<=\.(?:bascik__[\w-]+|b[0-9a-zA-Z]{11})(?::[a-z-]+(?:\([^)]*\))?|\[[^\]]*\])*(?:\s*[>+~]\s*|\s+))[a-z][a-z1-6]*(?![\w-])(?=[^{};]*\{)/g,
      toClass,
    );
  } while (result !== previousResult);

  return { css: result, elementsConvertedClasses };
};

/**
 * Helper to inject or append a scoped class onto an open HTML tag without
 * corrupting class-like text nested inside other attribute values.
 */
export const injectClassIntoTag = (openTag: string, className: string): string => {
  const stringRanges: Array<{ start: number; end: number }> = [];
  let j = 0;
  let strChar = null;
  let strStart = -1;
  while (j < openTag.length) {
    if (strChar) {
      if (openTag[j] === "\\") j++;
      else if (openTag[j] === strChar) {
        stringRanges.push({ start: strStart, end: j });
        strChar = null;
      }
    } else if (openTag[j] === '"' || openTag[j] === "'") {
      strChar = openTag[j];
      strStart = j;
    }
    j++;
  }

  let replaced = false;
  let finalStr = "";
  const attrRegexG = /(?:\s)class=(?:"([^"]*)"|'([^']*)')/gi;
  let match;

  while (!replaced && (match = attrRegexG.exec(openTag)) !== null) {
    const matchStart = match.index;
    const isInside = stringRanges.some(
      (r) => matchStart > r.start && matchStart < r.end,
    );
    if (!isInside) {
      const classQuote = match[1] !== undefined ? '"' : "'";
      const classVal = match[1] !== undefined ? match[1] : match[2];
      finalStr =
        openTag.substring(0, matchStart) +
        ` class=${classQuote}${classVal ? classVal + " " : ""}${className}${classQuote}` +
        openTag.substring(matchStart + match[0].length);
      replaced = true;
    }
  }

  if (!replaced) {
    finalStr = openTag.replace(
      /^<[a-zA-Z0-9-]+/i,
      (tagHead) => `${tagHead} class="${className}"`,
    );
  }
  return finalStr;
};

/**
 * If a component's css styles any element, add bascik classes to those elements
 */
export const addElementClassesInHtml = (
  componentHtml: string,
  componentName: string,
  elementsConvertedClasses: string[] = [],
): string => {
  // Loop through each element that has styling
  elementsConvertedClasses.forEach((element) => {
    const bascikClassName = minifyAttributeName(
      `bascik__${componentName}__el__${element}`,
    );
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const elPattern = new RegExp(`<${element}(?![\\w.:-])(?:[^>"']|"[^"]*"|'[^']*')*>`, "gis");
    componentHtml = componentHtml.replace(
      elPattern,
      (openTag) => injectClassIntoTag(openTag, bascikClassName),
    );
  });
  return componentHtml;
};

export const getKeyframeNames = (css: string): string[] | null => {
  // Anchor on the @keyframes at-rule itself so only the declared animation
  // name is captured — never `from`/`to`/percentage selectors or idents that
  // merely appear later in the stylesheet. Full CSS ident: [\w-]+ covers
  // dashed (fade-in), digit (spin2), and uppercase (pulseFast) names.
  const matches = css.matchAll(/@keyframes\s+([\w-]+)\s*\{/gi);
  const names = [...new Set([...matches].map((m) => m[1]))];
  return names.length ? names : null;
};

export const prefixKeyframes = (css: string, componentName: string): string => {
  const keyframeNames = getKeyframeNames(css);
  if (!Array.isArray(keyframeNames)) return css;
  let result = css;
  for (const name of keyframeNames) {
    // Skip names that are already scoped — prevents double-scoping when the
    // pipeline runs more than once on the same CSS.
    if (name.startsWith("bascik__")) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scoped = minifyAttributeName(
      `bascik__${componentName}__keyframe__${name}`,
    );
    // Rewrite every standalone occurrence of the name — both the @keyframes
    // declaration and animation references. The word-boundary guards
    // ((?<![\w-]) / (?![\w-])) ensure `spin` never rewrites `spin-slow`,
    // `spinFast`, `transform`, or the `@keyframes` keyword itself.
    result = result.replace(
      new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g"),
      () => scoped,
    );
  }
  return result;
};

export const removeIdSelectors = (css: string): string => {
  // Strips the [id] / [id="…"] attribute-selector form which cannot be
  // reliably scoped without DOM wrapping.  The hash form (#foo) is now
  // handled by convertCssIdSelectorsToClasses.
  // Shield string literals first so a `}` inside a quoted value (e.g.
  // content: "x}y") can't terminate the rule match early.
  const { css: shielded, restore } = shieldCssStrings(css);
  return restore(shielded.replace(/\[id\b[^\]]*\].*?{[\s\S]*?}/gim, ""));
};

// ─── CSS #id Selector → Class Conversion ─────────────────────────────────────

/**
 * Convert CSS hash ID selectors (`#idName { … }`) to component-scoped class
 * selectors, then inject the generated class onto the matching HTML element.
 *
 * Context-aware approach
 * ───────────────────────
 * The regex uses a lookahead to identify SELECTOR position vs VALUE position:
 *
 *   /#([a-zA-Z][a-zA-Z0-9-_]*)(?=[^{};]*\{)/g
 *
 * In selector position the next `{` appears before any `;` or `}`.
 * In value position (color declarations, gradient functions, etc.) a `;` or
 * `}` always appears before the next `{`.
 *
 * This correctly handles all common cases:
 *   #btn { }                  → MATCHES  (selector)
 *   #btn:hover { }            → MATCHES  (pseudo-class on selector)
 *   .parent #btn { }          → MATCHES  (compound selector)
 *   color: #abc;              → skipped  (value, `;` before `{`)
 *   background: linear-gradient(#abc, #def)  → skipped  (inside rule, `}` before next `{`)
 *   color: #abc\n}            → skipped  (`}` terminates before `{`)
 *
 * Known remaining edge case: a bare property declaration at the top level of
 * CSS (which is itself invalid) could theoretically produce a false positive.
 * In valid component CSS this does not occur.
 *
 * @example
 *   #btn { color: red }  →  .bascik__my-comp__id__btn { color: red }
 */
export const convertCssIdSelectorsToClasses = (
  css: string,
  componentName: string,
): { css: string; idsConverted: { idName: string; className: string }[] } => {
  const seen = new Map<string, string>();
  const idsConverted: { idName: string; className: string }[] = [];
  // Mask literals first so a hash inside a string literal, a comment, or an
  // attribute-selector value is never mistaken for an ID selector. url()
  // arguments are ALSO masked here (unlike the URL-fragment pass): a quoted
  // url("#id") argument is a URL reference, not an ID selector, so only the
  // selector pass rewrites it, never this one. This keeps genuine #id
  // selectors scoping while leaving `content: "url(#local)"` byte-identical.
  const { masked, restore } = maskCssSyntax(css, { keepUrlArguments: false });
  const cssStr = masked.replace(
    /#([a-zA-Z][a-zA-Z0-9-_]*)(?=[^{};]*\{)/g,
    (_: string, idName: string) => {
      if (!seen.has(idName)) {
        const className = minifyAttributeName(
          `bascik__${componentName}__id__${idName}`,
        );
        seen.set(idName, className);
        idsConverted.push({ idName, className });
      }
      return `.${seen.get(idName)!}`;
    },
  );
  return { css: restore(cssStr), idsConverted };
};

/**
 * Inject the generated id-class onto every HTML element whose `id` attribute
 * matches. Works for unscoped (`id="idName"`), already-scoped
 * (`id="bascik__comp__instanceId__idName"`), and minified (`id="b..."`) forms.
 */
export const addIdClassesInHtml = (
  html: string,
  idsConverted: { idName: string; className: string }[],
  scopedIdNames?: Record<string, string>,
): string => {
  if (idsConverted.length === 0) return html;
  idsConverted.forEach(({ idName, className }) => {
    const scopedId = scopedIdNames?.[idName];
    if (!html.includes(idName) && (!scopedId || !html.includes(scopedId))) return;
    const escaped = idName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedScoped = scopedId
      ? scopedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : "";
    const idGroup = escapedScoped
      ? `(?:(?:[^"]*__)?${escaped}|${escapedScoped})`
      : `(?:[^"]*__)?${escaped}`;
    const idGroupSingle = escapedScoped
      ? `(?:(?:[^']*__)?${escaped}|${escapedScoped})`
      : `(?:[^']*__)?${escaped}`;
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const idPattern = new RegExp(
      `<[a-zA-Z0-9-]+(?:[^>"']|"[^"]*"|'[^']*')*\\sid=(?:"${idGroup}"|'${idGroupSingle}')(?:[^>"']|"[^"]*"|'[^']*')*>`,
      "gi",
    );
    html = html.replace(idPattern, (openTag) =>
      injectClassIntoTag(openTag, className),
    );
  });
  return html;
};

/**
 * Shield quoted string literals (and `url(...)` contents) in a CSS string,
 * replacing each with a placeholder sentinel so downstream regex transforms
 * never touch their contents.  Returns the shielded css plus a `restore`
 * function.  Mirrors the sentinel pattern used by `preserveElementContents`
 * in javascript.ts.
 */
export const shieldCssStrings = (
  css: string,
): { css: string; restore: (s: string) => string } => {
  const preserved: string[] = [];
  // Quoted strings (with escape handling) and url(...) contents.
  const shielded = css.replace(
    /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\)/gi,
    (match) => {
      preserved.push(match);
      return `\x00CSSSTR${preserved.length - 1}\x00`;
    },
  );
  return {
    css: shielded,
    restore: (s: string) =>
      s.replace(/\x00CSSSTR(\d+)\x00/g, (_m, i) => preserved[parseInt(i, 10)]),
  };
};

export const removeCommentsFromCss = (css: string): string => {
  // Single-pass: strings/url() win over comment detection so apostrophes
  // inside comments (e.g. `/* the logo's angle */`) are never mistaken for
  // the start of a CSS string literal.
  return css.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\))|\/\*[\s\S]*?\*\//g,
    (_match, stringOrUrl?: string) => stringOrUrl ?? "",
  );
};

// ─── CSS @import Resolution & Scoping ────────────────────────────────────────

/**
 * Check if a CSS @import target URL is an external / remote URL
 * (e.g. http://, https://, //, data:).
 */
export const isRemoteCssUrl = (url: string): boolean => {
  return /^(?:https?:|\/\/|data:)/i.test(url.trim());
};

export interface ParsedCssImport {
  fullMatch: string;
  url: string;
  isRemote: boolean;
  layer?: string | boolean;
  supports?: string;
  media?: string;
}

/**
 * Parses a single CSS `@import` statement into its constituent components:
 * target URL/path, and optional layer, supports, and media query conditions.
 */
export const parseCssImport = (statement: string): ParsedCssImport | null => {
  const match = statement.match(
    /^@import\s+(?:url\(\s*(?:([`'"])([\s\S]*?)\1|([^)]*?))\s*\)|([`'"])([\s\S]*?)\4)([^;]*);?$/i,
  );
  if (!match) return null;

  const rawUrl = (match[2] ?? match[3] ?? match[5] ?? "").trim();
  const rawConditions = (match[6] ?? "").trim();

  let layer: string | boolean | undefined;
  let supports: string | undefined;
  let media: string | undefined;

  let remainingConditions = rawConditions;

  // 1. Check for layer / layer(name)
  const layerMatch = remainingConditions.match(/\blayer(?:\(([^)]*)\))?/i);
  if (layerMatch) {
    if (layerMatch[1] !== undefined) {
      layer = layerMatch[1].trim();
    } else {
      layer = true;
    }
    remainingConditions = remainingConditions.replace(layerMatch[0], "").trim();
  }

  // 2. Check for supports(...) with balanced parentheses
  const supportsIdx = remainingConditions.search(/\bsupports\(/i);
  if (supportsIdx !== -1) {
    const startInner = remainingConditions.indexOf("(", supportsIdx) + 1;
    let depth = 1;
    let endInner = startInner;
    while (endInner < remainingConditions.length && depth > 0) {
      if (remainingConditions[endInner] === "(") depth++;
      else if (remainingConditions[endInner] === ")") depth--;
      if (depth > 0) endInner++;
    }
    if (depth === 0) {
      supports = remainingConditions.slice(startInner, endInner).trim();
      remainingConditions = (
        remainingConditions.slice(0, supportsIdx) +
        remainingConditions.slice(endInner + 1)
      ).trim();
    }
  }

  // 3. Any remainder is media query list
  if (remainingConditions.length > 0) {
    media = remainingConditions;
  }

  return {
    fullMatch: statement,
    url: rawUrl,
    isRemote: isRemoteCssUrl(rawUrl),
    layer,
    supports,
    media,
  };
};

/**
 * Wrap inlined CSS with any layer, supports, or media queries specified on the @import rule.
 */
export const wrapInlinedCss = (
  css: string,
  layer?: string | boolean,
  supports?: string,
  media?: string,
): string => {
  let result = css.trim();
  if (!result) return "";

  if (supports) {
    result = `@supports (${supports}) {\n${result}\n}`;
  }
  if (layer) {
    if (typeof layer === "string" && layer.length > 0) {
      result = `@layer ${layer} {\n${result}\n}`;
    } else {
      result = `@layer {\n${result}\n}`;
    }
  }
  if (media) {
    result = `@media ${media} {\n${result}\n}`;
  }
  return result;
};

type CssImportPlan = {
  fullStatement: string;
  parsed: NonNullable<ReturnType<typeof parseCssImport>>;
  targetPath: string;
  /** Every file whose creation, edit, or removal changes this import's result. */
  dependencyPaths: string[];
  nextVisited: Set<string>;
  replacement?: string;
};

const isCssNameChar = (char: string | undefined): boolean =>
  char !== undefined && /[\w-]/.test(char);

/**
 * Sorted `[start, end)` ranges of comments, quoted strings, and unquoted
 * `url(...)` tokens. `@import` text inside these is not an at-rule (CSS Syntax
 * Level 3, section 4). A resolved missing import leaves a comment marker that
 * names the import, so this is also what makes resolution idempotent.
 */
const cssOpaqueRanges = (css: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? css.length : close + 2;
      ranges.push([i, end]);
      i = end;
    } else if (char === '"' || char === "'") {
      // A string ends at its unescaped quote, or at an unescaped newline (bad-string).
      let j = i + 1;
      while (j < css.length && css[j] !== char && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, css.length);
      ranges.push([i, end]);
      i = end;
    } else if (char === "\\") {
      i += 2;
    } else if (
      (char === "u" || char === "U") &&
      css.slice(i, i + 4).toLowerCase() === "url(" &&
      !isCssNameChar(css[i - 1])
    ) {
      let argument = i + 4;
      while (argument < css.length && /\s/.test(css[argument])) argument++;
      if (css[argument] === '"' || css[argument] === "'") {
        // A quoted url() argument is an ordinary string; the next pass records it.
        i = argument;
        continue;
      }
      // An unquoted url() token runs to its closing parenthesis; `/*` inside is not a comment.
      const close = css.indexOf(")", argument);
      const end = close === -1 ? css.length : close + 1;
      ranges.push([i, end]);
      i = end;
    } else {
      i++;
    }
  }
  return ranges;
};

// Observer for CSS import planning, set only while scoping-template.ts records
// one synchronous scoping run. Planning past this point reads the file system.
let cssImportPlanningObserver: (() => void) | null = null;

/**
 * Run `run` synchronously while reporting whether any CSS `@import` planning
 * (and so any file system access) happened. The previous observer is restored.
 */
export const observeCssImportPlanning = <T>(observer: () => void, run: () => T): T => {
  const previous = cssImportPlanningObserver;
  cssImportPlanningObserver = observer;
  try {
    return run();
  } finally {
    cssImportPlanningObserver = previous;
  }
};

const planCssImports = (
  css: string,
  baseFilePath: string | undefined,
  visited: Set<string>,
): CssImportPlan[] => {
  if (!css || !css.includes("@import")) return [];
  cssImportPlanningObserver?.();
  const importRegex = /@import\s+(?:url\(\s*(?:([`'"])([\s\S]*?)\1|([^)]*?))\s*\)|([`'"])([\s\S]*?)\4)([^;]*);?/gi;
  const opaque = cssOpaqueRanges(css);
  let opaqueIndex = 0;
  const plans: CssImportPlan[] = [];
  for (const match of css.matchAll(importRegex)) {
    const start = match.index;
    while (opaqueIndex < opaque.length && opaque[opaqueIndex][1] <= start) opaqueIndex++;
    if (opaqueIndex < opaque.length && opaque[opaqueIndex][0] <= start) continue;
    const fullStatement = match[0];
    const parsed = parseCssImport(fullStatement);
    if (!parsed || parsed.isRemote) continue;
    const baseDir = baseFilePath
      ? existsSync(baseFilePath) && statSync(baseFilePath).isDirectory()
        ? baseFilePath
        : dirname(baseFilePath)
      : process.cwd();
    const requestedPath = resolve(baseDir, parsed.url);
    const dependencyPaths = requestedPath.endsWith(".css")
      ? [requestedPath]
      : [requestedPath, `${requestedPath}.css`];
    let targetPath = requestedPath;
    if (
      !existsSync(targetPath) &&
      !targetPath.endsWith(".css") &&
      existsSync(`${targetPath}.css`)
    ) {
      targetPath = `${targetPath}.css`;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(targetPath);
    if (!existsSync(targetPath)) {
      console.warn(
        `[bascik] warning: Could not resolve CSS @import "${parsed.url}" in "${baseFilePath ?? "component CSS"}"`,
      );
      plans.push({
        fullStatement,
        parsed,
        targetPath,
        dependencyPaths,
        nextVisited,
        replacement: `/* @import "${parsed.url}" not found */`,
      });
    } else if (visited.has(targetPath)) {
      plans.push({ fullStatement, parsed, targetPath, dependencyPaths, nextVisited, replacement: "" });
    } else {
      plans.push({ fullStatement, parsed, targetPath, dependencyPaths, nextVisited });
    }
  }
  return plans;
};

const cleanImportedCss = (css: string): string =>
  removeCommentsFromCss(css).replace(/@charset\s+["'][^"']+["'];?/gi, "");

const replaceCssImport = (
  css: string,
  fullStatement: string,
  replacement: string,
): string => css.replace(fullStatement, () => replacement);

const wrapPlannedCss = (css: string, plan: CssImportPlan): string =>
  wrapInlinedCss(
    css,
    plan.parsed.layer,
    plan.parsed.supports,
    plan.parsed.media,
  );

/**
 * Resolves and inlines local `@import` statements in a CSS string asynchronously.
 * Remote `@import` statements (e.g. Google Fonts) are preserved.
 *
 * @param css The raw CSS content
 * @param baseFilePath The file path of the current CSS/HTML file (used to resolve relative import paths)
 * @param visited Set of canonical file paths already visited (for circular import prevention)
 * @param dependencies Receives every local file path an import names, found or not
 */
export const resolveCssImports = async (
  css: string,
  baseFilePath?: string,
  visited: Set<string> = new Set(),
  dependencies?: Set<string>,
): Promise<string> => {
  let result = css;
  for (const plan of planCssImports(css, baseFilePath, visited)) {
    for (const path of plan.dependencyPaths) dependencies?.add(path);
    if (plan.replacement !== undefined) {
      result = replaceCssImport(result, plan.fullStatement, plan.replacement);
      continue;
    }

    try {
      const importedRaw = cleanImportedCss((await readFile(plan.targetPath)).toString());
      const nestedResolved = await resolveCssImports(importedRaw, plan.targetPath, plan.nextVisited, dependencies);
      result = replaceCssImport(result, plan.fullStatement, wrapPlannedCss(nestedResolved, plan));
    } catch (err) {
      console.warn("[bascik] warning: Failed to read imported CSS file %s:", plan.targetPath, err);
      result = replaceCssImport(result, plan.fullStatement, "");
    }
  }

  return result;
};

/**
 * Resolves and inlines local `@import` statements in a CSS string synchronously.
 * Remote `@import` statements (e.g. Google Fonts) are preserved.
 */
export const resolveCssImportsSync = (
  css: string,
  baseFilePath?: string,
  visited: Set<string> = new Set(),
  dependencies?: Set<string>,
): string => {
  let result = css;
  for (const plan of planCssImports(css, baseFilePath, visited)) {
    for (const path of plan.dependencyPaths) dependencies?.add(path);
    if (plan.replacement !== undefined) {
      result = replaceCssImport(result, plan.fullStatement, plan.replacement);
      continue;
    }

    try {
      const importedRaw = cleanImportedCss(readFileSync(plan.targetPath, "utf-8"));
      const nestedResolved = resolveCssImportsSync(importedRaw, plan.targetPath, plan.nextVisited, dependencies);
      result = replaceCssImport(result, plan.fullStatement, wrapPlannedCss(nestedResolved, plan));
    } catch (err) {
      console.warn("[bascik] warning: Failed to read imported CSS file %s:", plan.targetPath, err);
      result = replaceCssImport(result, plan.fullStatement, "");
    }
  }

  return result;
};

/**
 * Hoist all preserved `@import` statements (e.g. remote font / stylesheet URLs)
 * to the top of the CSS block, deduplicating identical imports.
 *
 * This ensures strict compliance with W3C CSS Cascading and Inheritance Level 4,
 * which requires @import rules to precede all other style rules.
 */
export const hoistCssImports = (css: string): string => {
  if (!css || !css.includes("@import")) return css;

  const importRegex = /@import\s+(?:url\(\s*(?:([`'"])([\s\S]*?)\1|([^)]*?))\s*\)|([`'"])([\s\S]*?)\4)[^;]*;/gi;
  const imports: string[] = [];
  const seen = new Set<string>();

  const cleanedCss = css.replace(importRegex, (statement) => {
    const trimmed = statement.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      imports.push(trimmed);
    }
    return "";
  });

  if (imports.length === 0) return css;

  const body = cleanedCss.trim();
  return body ? `${imports.join("\n")}\n${body}` : imports.join("\n");
};

export const getComponentCss = async (
  htmlFileName: string,
  cssFileNames: string[],
  importDependencies?: Set<string>,
): Promise<string | undefined> => {
  if (!htmlFileName || !Array.isArray(cssFileNames)) return;
  const cssFileName = cssFileNames.find(
    (cssFileName) => cssFileName.replace(/\.css$/, ".html") === htmlFileName,
  );
  if (!cssFileName) return;
  try {
    const raw = removeCommentsFromCss((await readFile(cssFileName)).toString());
    return await resolveCssImports(raw, cssFileName, undefined, importDependencies);
  } catch (error) {
    console.warn("warning: Failed to read css for %s", htmlFileName, error);
  }
};

// ─── CSS Custom Properties Scoping ───────────────────────────────────────────

/**
 * Scope CSS custom property (--var) declarations and all var() references
 * within a component's stylesheet.
 *
 * Only properties *declared* in this CSS are scoped — external custom
 * properties consumed via var() that are not declared here are left untouched.
 *
 * @example
 *   --brand: #d3ff8d   →  --bascik__my-comp__x1__brand: #d3ff8d
 *   var(--brand)        →  var(--bascik__my-comp__x1__brand)
 */
export const scopeCssCustomProperties = (
  css: string,
  componentName: string,
): string => {
  if (!css.includes("--")) return css;
  const propMap = new Map();
  // Collect --var-name from element-level declarations:  --name:
  const declRegex = /(?<!-)--(\w[\w-]*)(?=\s*:)/gm;
  let m;
  while ((m = declRegex.exec(css)) !== null) {
    const originalName = m[1];
    if (!propMap.has(originalName)) {
      propMap.set(
        originalName,
        minifyAttributeName(`bascik__${componentName}__${originalName}`),
      );
    }
  }
  // Collect --name from @property at-rule declarations:  @property --name {
  const atPropertyRegex = /@property\s+--(\w[\w-]*)\s*\{/gm;
  while ((m = atPropertyRegex.exec(css)) !== null) {
    const originalName = m[1];
    if (!propMap.has(originalName)) {
      propMap.set(
        originalName,
        minifyAttributeName(`bascik__${componentName}__${originalName}`),
      );
    }
  }
  if (propMap.size === 0) return css;
  let result = css;
  propMap.forEach((scopedName, originalName) => {
    // Replace @property --original { declarations
    result = result.replace(
      new RegExp(`(@property\\s+)--${originalName}(?=\\s*\\{)`, "gm"),
      (_, p1) => `${p1}--${scopedName}`,
    );
    // Replace declarations:  --original:
    result = result.replace(
      new RegExp(`(?<!-)--${originalName}(?=\\s*:)`, "gm"),
      () => `--${scopedName}`,
    );
    // Replace var() references:  var(--original)  and  var(--original, fallback)
    result = result.replace(
      new RegExp(`var\\(\\s*--${originalName}(\\s*[,)])`, "gm"),
      (_, p1) => `var(--${scopedName}${p1}`,
    );
  });
  return result;
};

// ─── @layer Name Scoping ─────────────────────────────────────────────────────

/**
 * Scope `@layer` names declared in a component's CSS so that layer identifiers
 * from different components never collide.
 *
 * All forms are handled:
 *   @layer base { ... }             →  @layer bascik__comp__layer__base { ... }
 *   @layer reset, base, utilities;  →  each name scoped individually
 *
 * Only names that appear in this CSS are scoped — external layer names
 * referenced elsewhere are left untouched.
 */
export const scopeLayerNames = (css: string, componentName: string): string => {
  if (!css.includes("@layer")) return css;
  const layerNames = new Set<string>();
  css.replace(
    /@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)/g,
    (_: string, nameList: string) => {
      nameList.split(",").forEach((n) => layerNames.add(n.trim()));
      return "";
    },
  );
  if (layerNames.size === 0) return css;
  let result = css;
  layerNames.forEach((name) => {
    const scoped = minifyAttributeName(
      `bascik__${componentName}__layer__${name}`,
    );
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(
        `(?<=@layer[^{;]*)(?<![\\w-])${escapedName}(?![\\w-])`,
        "gm",
      ),
      () => scoped,
    );
  });
  return result;
};

// ─── @container Name Scoping ──────────────────────────────────────────────────

/**
 * Scope named `container-name` declarations and `@container name` queries so
 * that container identifiers from different components never collide.
 *
 * Only container names *declared* in this CSS are scoped — unnamed container
 * queries (`@container (min-width: …)`) are left untouched.
 *
 * @example
 *   container-name: sidebar            →  container-name: bascik__comp__container__sidebar
 *   @container sidebar (min-width: …)  →  @container bascik__comp__container__sidebar (…)
 */
export const scopeContainerNames = (
  css: string,
  componentName: string,
): string => {
  if (!css.includes("container")) return css;
  const containerNames = new Set<string>();
  css.replace(
    /container(?:-name)?\s*:\s*([\w-]+)/g,
    (_: string, name: string) => {
      if (name !== "none") containerNames.add(name);
      return "";
    },
  );
  if (containerNames.size === 0) return css;
  // One pass per pattern over whole names: rewriting one name at a time let a
  // later name match inside an earlier generated name or a longer name.
  const scopedNames = new Map<string, string>();
  containerNames.forEach((name) => {
    scopedNames.set(name, minifyAttributeName(`bascik__${componentName}__container__${name}`));
  });
  return css
    .replace(/(?<=@container\s+)([\w-]+)(?=\s*[({])/gm, (name: string) => scopedNames.get(name) ?? name)
    .replace(/(container(?:-name)?\s*:\s*)([\w-]+)/gm, (match: string, prefix: string, name: string) => {
      const scoped = scopedNames.get(name);
      return scoped === undefined ? match : `${prefix}${scoped}`;
    });
};

// ─── view-transition-name Scoping ────────────────────────────────────────────

/**
 * Scope `view-transition-name` property values so transition names from
 * different components never collide on the same page.
 *
 * Only names *declared* via `view-transition-name:` in this CSS are scoped —
 * any `::view-transition-*` pseudo-elements referencing names not declared here
 * are left untouched. The keywords `none` and `auto` are not scoped.
 */
export const scopeViewTransitionNames = (
  css: string,
  componentName: string,
): string => {
  const names = new Set<string>();
  css.replace(
    /view-transition-name\s*:\s*([\w-]+)/g,
    (_: string, name: string) => {
      if (name !== "none" && name !== "auto") names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  let result = css;
  names.forEach((name) => {
    const scoped = minifyAttributeName(
      `bascik__${componentName}__vtn__${name}`,
    );
    result = result.replace(
      new RegExp(`(view-transition-name\\s*:\\s*)${name}\\b`, "gm"),
      (_, p1) => `${p1}${scoped}`,
    );
    for (const pseudo of [
      "view-transition-old",
      "view-transition-new",
      "view-transition-group",
      "view-transition-image-pair",
    ]) {
      result = result.replace(
        new RegExp(`(::${pseudo}\\()${name}(\\))`, "gm"),
        (_, p1, p2) => `${p1}${scoped}${p2}`,
      );
    }
  });
  return result;
};

// ─── @counter-style Name Scoping ─────────────────────────────────────────────

/**
 * Scope `@counter-style` names so that custom counter identifiers from
 * different components never collide.
 *
 * Handles:
 *   @counter-style thumbs { … }              →  @counter-style bascik__comp__counter__thumbs { … }
 *   list-style: thumbs                        →  list-style: bascik__comp__counter__thumbs
 *   list-style-type: thumbs                   →  list-style-type: bascik__comp__counter__thumbs
 *   counter(section, thumbs)                  →  counter(section, bascik__comp__counter__thumbs)
 *   counters(section, ".", thumbs)            →  counters(section, ".", bascik__comp__counter__thumbs)
 *
 * Only names *declared* in this CSS are scoped — built-in counter styles
 * (e.g. `decimal`, `disc`, `none`) and names from other components are
 * left untouched.
 */
export const scopeCounterStyleNames = (
  css: string,
  componentName: string,
): string => {
  const names = new Set<string>();
  // Collect all @counter-style declarations
  css.replace(
    /@counter-style\s+([\w-]+)\s*\{/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  const scopedNames = new Map<string, string>();
  names.forEach((name) => {
    scopedNames.set(name, minifyAttributeName(`bascik__${componentName}__counter__${name}`));
  });
  // One pass per pattern over whole names: rewriting one name at a time let a
  // later name match inside an earlier generated name or a longer name.
  const scopeName = (match: string, prefix: string, name: string): string => {
    const scoped = scopedNames.get(name);
    return scoped === undefined ? match : `${prefix}${scoped}`;
  };
  return css
    // The @counter-style declaration
    .replace(/(@counter-style\s+)([\w-]+)(?=\s*\{)/gm, scopeName)
    // list-style and list-style-type property references
    .replace(/(list-style(?:-type)?\s*:\s*)([\w-]+)/gm, scopeName)
    // counter() second argument: counter(name, style)
    .replace(/(counter\([^,)]+,\s*)([\w-]+)(?=[^)]*\))/gm, scopeName)
    // counters() third argument: counters(name, sep, style)
    .replace(/(counters\([^,)]+,\s*[^,)]+,\s*)([\w-]+)(?=[^)]*\))/gm, scopeName);
};

// ─── anchor-name / @position-try Scoping ─────────────────────────────────────

/**
 * Scope CSS anchor names (dashed-idents declared with `anchor-name`) so that
 * anchor identifiers from different components never collide on the same page.
 *
 * Handles:
 *   anchor-name: --my-anchor              →  anchor-name: --bascik__comp__anchor__my-anchor
 *   position-anchor: --my-anchor          →  position-anchor: --bascik__comp__anchor__my-anchor
 *   @position-try --my-anchor { … }       →  @position-try --bascik__comp__anchor__my-anchor { … }
 *
 * Only anchor names *declared* via `anchor-name:` in this CSS are scoped.
 * References in `position-anchor` or `@position-try` that reference names not
 * declared here are left untouched.
 *
 * Note: anchor names are dashed-idents (`--name`) like CSS custom properties
 * but are a separate namespace — this function is independent of
 * `scopeCssCustomProperties`.
 */
export const scopeAnchorNames = (
  css: string,
  componentName: string,
): string => {
  const names = new Set<string>();
  // Collect all anchor-name: --name declarations and @position-try --name declarations
  css.replace(
    /anchor-name\s*:\s*--(\w[\w-]*)/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  css.replace(
    /@position-try\s+--(\w[\w-]*)/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  let result = css;
  names.forEach((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scoped = minifyAttributeName(
      `bascik__${componentName}__anchor__${name}`,
    );
    // Scope anchor-name: --name declarations
    result = result.replace(
      new RegExp(`(anchor-name\\s*:\\s*)--${escaped}\\b`, "gm"),
      (_, p1) => `${p1}--${scoped}`,
    );
    // Scope position-anchor: --name references
    result = result.replace(
      new RegExp(`(position-anchor\\s*:\\s*)--${escaped}\\b`, "gm"),
      (_, p1) => `${p1}--${scoped}`,
    );
    // Scope @position-try --name { ... } at-rules
    result = result.replace(
      new RegExp(`(@position-try\\s+)--${escaped}(?=\\s*\\{)`, "gm"),
      (_, p1) => `${p1}--${scoped}`,
    );
  });
  return result;
};

// ─── Inline <style> Tag Extraction ───────────────────────────────────────────

/**
 * Extract the content of all `<style>` blocks from component HTML, returning
 * the HTML without `<style>` tags and the extracted CSS string.
 *
 * Inner contents of raw-text/code elements (`<code>`, `<pre>`, `<script>`,
 * `<textarea>`) are shielded so literal `<style>` tags in code examples are
 * never extracted.
 */
export const extractInlineStyles = (
  html: string,
): { html: string; css: string } => {
  if (!html || !html.includes("<style")) {
    return { html, css: "" };
  }

  // Mask HTML comments before shielding element contents so that a literal
  // `<style>` reference inside a comment (e.g. "keep CSS in this file's
  // <style> block") is never mistaken for a real style tag opener.
  // Replace each comment with a same-length run of spaces so all subsequent
  // string indices remain valid for the restore step.
  const commentPlaceholders: Array<{ token: string; original: string }> = [];
  const htmlWithMaskedComments = html.includes("<!--")
    ? html.replace(/<!--[\s\S]*?-->/g, (match) => {
      const token = `\x00BASCIK_COMMENT_${commentPlaceholders.length}\x00`;
      commentPlaceholders.push({ token, original: match });
      return token;
    })
    : html;

  const shielded = shieldElementContents(htmlWithMaskedComments, ["code", "pre", "script", "textarea"]);

  const cssBlocks: string[] = [];
  const collectStyleBlock = (_match: string, openTag: string, styleContent: string): string => {
    let css = removeCommentsFromCss(styleContent).trim();
    if (!css) return "";
    // Read `media` the way the browser does, so a range query such as
    // `(width > 600px)` is read whole. The first `media` attribute counts.
    const media = readStartTagAttributes(openTag, 0)
      .find((attribute) => attribute.name === "media")?.value.trim() ?? "";
    if (media && media.toLowerCase() !== "all" && media.toLowerCase() !== "screen") {
      css = `@media ${media} {\n${css}\n}`;
    }
    cssBlocks.push(css);
    return "";
  };

  // Removing a block can join the text around it into a new `<style>` block
  // (for example `<sty<style>a{}</style>le>b{}</style>`), so repeat until the
  // HTML stops changing. Every pass that changes the HTML shortens it, so the
  // loop always ends. The `replace` call stays inline, with its result fed
  // back into its own receiver, so static analysis can see the fixpoint loop.
  let cleanedHtml = shielded.html;
  let previousHtml: string;
  do {
    previousHtml = cleanedHtml;
    cleanedHtml = cleanedHtml.replace(
      /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)/gi,
      collectStyleBlock,
    );
  } while (cleanedHtml !== previousHtml);

  // Restore shielded element content first, then restore masked HTML comments.
  let restoredHtml = shielded.restore(cleanedHtml);
  for (const { token, original } of commentPlaceholders) {
    restoredHtml = restoredHtml.replace(token, () => original);
  }

  return {
    html: restoredHtml,
    css: cssBlocks.join("\n"),
  };
};

// ─── Inline <style> Tag Scoping ───────────────────────────────────────────────

/**
 * Process every `<style>` block inside a component's HTML, applying the full
 * CSS scoping pipeline (class names, element selectors, @keyframes, @layer,
 * @container names, and custom properties).
 *
 * Returns the modified HTML and the list of element names converted to classes
 * so the caller can inject those classes into the HTML in one pass, alongside
 * any classes from a paired `.css` file.
 */
export const scopeInlineStyleTags = (
  html: string,
  componentName: string,
  baseFilePath?: string,
): {
  html: string;
  elementsConvertedClasses: string[];
  idsConverted: { idName: string; className: string }[];
} => {
  const allElementClasses: string[] = [];
  const allIdsConverted: { idName: string; className: string }[] = [];
  const processedHtml = html.replace(
    /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)/gi,
    (_match, open: string, styleContent: string, close: string) => {
      let css = resolveCssImportsSync(removeCommentsFromCss(styleContent), baseFilePath);
      // Shield strings/url() so dots inside them aren't treated as class selectors
      const { css: shieldedCss, restore } = shieldCssStrings(css);
      css = restore(
        shieldedCss.replace(/(?<=\.)[a-z_][a-z0-9-_]*/gim, (className) =>
          minifyAttributeName(`bascik__${componentName}__${className}`),
        ),
      );
      const { css: elCss, elementsConvertedClasses } =
        convertCssElementSelectorsToClasses(css, componentName);
      css = elCss;
      allElementClasses.push(...elementsConvertedClasses);
      const { css: idCss, idsConverted } = convertCssIdSelectorsToClasses(
        css,
        componentName,
      );
      css = idCss;
      allIdsConverted.push(...idsConverted);
      css = prefixKeyframes(css, componentName);
      css = removeIdSelectors(css);
      css = scopeCssCustomProperties(css, componentName);
      css = scopeLayerNames(css, componentName);
      css = scopeContainerNames(css, componentName);
      css = scopeViewTransitionNames(css, componentName);
      css = scopeCounterStyleNames(css, componentName);
      css = scopeAnchorNames(css, componentName);
      return `${open}${css}${close}`;
    },
  );
  return {
    html: processedHtml,
    elementsConvertedClasses: allElementClasses,
    idsConverted: allIdsConverted,
  };
};

// ─── CSS Deduplication ────────────────────────────────────────────────────────

/**
 * Return the CSS string for each unique component name exactly once,
 * preserving first-seen order. Prevents duplicate `<style>` blocks when a
 * component is used multiple times on the same page.
 */
export const deduplicateCss = (
  usedComponents: Pick<
    BascikComponent,
    "name" | "cssFileContent" | "requiresPerInstanceCss"
  >[],
  dedup: boolean = true,
): string => {
  let combined: string;
  if (!dedup) {
    // Per-instance class scoping: every instance emits its own CSS block.
    combined = usedComponents
      .map(({ cssFileContent }) => cssFileContent)
      .filter((css): css is string => Boolean(css))
      .join(" ");
  } else {
    const seen = new Set<string>();
    combined = usedComponents
      .filter(({ name, requiresPerInstanceCss }) => {
        if (requiresPerInstanceCss) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .map(({ cssFileContent }) => cssFileContent)
      .filter((css): css is string => Boolean(css))
      .join(" ");
  }
  return hoistCssImports(combined);
};
