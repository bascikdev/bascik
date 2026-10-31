import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { minifyAttributeName } from "./names.ts";
import { maskCssSyntax } from "./css-tokenizer.ts";
import { createContentShield, shieldElementContents } from "./shielding.ts";
import { readStartTagAttributes } from "./html-scanner.ts";
import {
  createMarkerWalk,
  createOpenTagScanner,
  findWhitespaceMarkerAnchors,
  openTagsOf,
  replaceScannedElements,
  replaceSpans,
  type OpenTagMatch,
  type OpenTagScanner,
} from "./element-content-scan.ts";

/** `[\w.:-]` */
const isElementSelectorNameCode = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x3a) || // digits and `:`
  code === 0x5f ||
  code === 0x2d ||
  code === 0x2e;

/**
 * `<(names)(?![\w.:-])(?:[^>"']|"[^"]*"|'[^']*')*>` (flags `gis`) for
 * lowercase names made of `[\w:-]`, in linear time: such a name matches
 * only where it is the whole `[\w.:-]` run after the `<`.
 */
const elementOpenTags = (
  html: string,
  names: ReadonlySet<string>,
): OpenTagScanner =>
  createOpenTagScanner(html, (start) => {
    let index = start + 1;
    while (isElementSelectorNameCode(html.charCodeAt(index))) index++;
    return index > start + 1 &&
      names.has(html.slice(start + 1, index).toLowerCase())
      ? index
      : -1;
  });
import type { BascikComponent } from "./types.ts";

// CSS unit keywords that are not valid HTML element names.  A CSS syntax
// error (e.g. breaking `0.7rem 1em` across two lines) can place a unit
// keyword at column 0 where the element-selector regex would otherwise
// match it and produce a garbled scoped class name.
// Also includes CSS @keyframes pseudo-selectors (`from`, `to`) which are
// never HTML element names and must not be converted to scoped classes.
const CSS_UNIT_KEYWORDS = new Set([
  // Relative length
  "rem",
  "ex",
  "rex",
  "cap",
  "rcap",
  "ch",
  "rch",
  "ic",
  "ric",
  "lh",
  "rlh",
  // Viewport
  "vw",
  "vh",
  "vmin",
  "vmax",
  "svw",
  "svh",
  "svmin",
  "svmax",
  "dvw",
  "dvh",
  "dvmin",
  "dvmax",
  "lvw",
  "lvh",
  "lvmin",
  "lvmax",
  // Container query
  "cqw",
  "cqh",
  "cqi",
  "cqb",
  "cqmin",
  "cqmax",
  // Absolute length
  "px",
  "cm",
  "mm",
  "in",
  "pt",
  "pc",
  // Angle
  "deg",
  "rad",
  "grad",
  "turn",
  // Time  (note: "s" IS an HTML element, so it is intentionally omitted)
  "ms",
  // Frequency
  "hz",
  "khz",
  // Resolution
  "dpi",
  "dpcm",
  "dppx",
  // CSS @keyframes pseudo-selectors — not HTML elements
  "from",
  "to",
  // Root/structural elements — never inside a component; must not be hashed
  // so that cross-boundary selectors like `html[data-theme="light"] .class`
  // compile correctly in component CSS.
  "html",
  "body",
  "head",
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

  // Shield strings and url() contents so braces or commas inside string
  // literals (e.g. `content: "p {"` or `[data-x="a { b"]`) never trigger
  // element-selector lookaheads.
  const { css: stringShielded, restore: restoreStrings } =
    shieldCssStrings(css);
  // Shield at-rule preludes too (`@media screen, print`, a wrapped
  // `@supports (a)\n  and (b)`, `@keyframes\nfade`): their keywords sit in
  // selector position for the passes below and would become element classes.
  // `@scope` is left visible because its prelude holds real selectors.
  const { css: shielded, restore: restorePreludes } =
    shieldAtRulePreludes(stringShielded);
  const restore = (value: string): string =>
    restoreStrings(restorePreludes(value));

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
  let result = shielded.replace(
    /(^\s*|[;{}]\s*)([a-z][a-z1-6]*)(?![\w-])(?=[^{};]*\{)/gim,
    (_match, prefix: string, elementName: string) =>
      `${prefix}${toClass(elementName)}`,
  );

  // Pass 2: same-line comma-separated selector list, e.g. `h1, h2 { }`.
  // Multi-line lists (`h1,\nh2`) are already handled by Pass 1.
  // The context-aware lookahead [^{};)]*\{ confirms selector position:
  //   - In selector context, `{` follows before any `;` or `}`.
  //   - In value context (property values, gradient functions, etc.) a
  //     `;`, `}`, or `)` always appears before the next `{`.
  // Adding `)` to the stop set is essential — it prevents false positives
  // inside :is(), :where(), :has() pseudo-functions (e.g. h2 in :is(p, h2)).
  result = result.replace(
    /(,[ \t]*)([a-z][a-z1-6]*)(?![\w-])(?=[^{};)]*\{)/g,
    (_match, prefix: string, elementName: string) =>
      `${prefix}${toClass(elementName)}`,
  );

  // Pass 3: element selectors in CSS nesting context (W3C CSS Nesting Module).
  // Handles:
  //   - Explicit nesting: `& p { }`, `& > h2 { }`, `&>h2 { }`, `& + li { }`, `& ~ span { }`.
  //   - `&` followed by pseudo-classes, pseudo-elements or attribute
  //     selectors, then a combinator: `&:hover p { }`, `&[open] > summary { }`
  //     (the same chain Pass 4 accepts after a scoped class).
  //   - 2023 Relaxed direct combinator nesting without explicit `&`:
  //     `> h2 { }`, `+ li { }`, `~ span { }`.
  result = result.replace(
    /(&(?:(?:::?[a-z-]+(?:\([^){};]*\))?|\[[^\]{};]*\])+(?:\s*[>+~]\s*|\s+)|\s*(?:[>+~]\s*)?))([a-z][a-z1-6]*)(?![\w-])(?=[^{};]*\{)/g,
    (_match, prefix: string, elementName: string) =>
      `${prefix}${toClass(elementName)}`,
  );
  result = result.replace(
    /((?:^|[;{}])\s*[>+~]\s*)([a-z][a-z1-6]*)(?![\w-])(?=[^{};]*\{)/g,
    (_match, prefix: string, elementName: string) =>
      `${prefix}${toClass(elementName)}`,
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
      /((?:\.(?:bascik__(?:[\w-]|\\[^\n])+|b[0-9a-zA-Z]{11})|:(?:is|where|has|not)\([^)]*\.(?:bascik__[\w-]+|b[0-9a-zA-Z]{11})[^)]*\))(?:::[a-z-]+|:[a-z-]+(?:\([^)]*\))?|\[[^\]]*\])*(?:\s*[>+~]\s*|\s+)(?:\*(?:\s*[>+~]\s*|\s+))*)([a-z][a-z1-6]*)(?![\w-])(?=[^{};]*\{)/g,
      (_match, prefix: string, elementName: string) =>
        `${prefix}${toClass(elementName)}`,
    );
  } while (result !== previousResult);

  return { css: restore(result), elementsConvertedClasses };
};

const HTML_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/**
 * The quoted attribute values of one open tag, as `[start, end]` index pairs
 * of their opening and closing quotes. Follows the HTML tokenizer: a quote
 * opens a value only right after `=` (and optional whitespace), the value
 * ends at the next matching quote, and backslashes are plain characters.
 * A quote anywhere else (inside an attribute name or an unquoted value) is
 * an ordinary character.
 */
export const quotedAttributeValueRanges = (
  openTag: string,
): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  let afterEquals = false;
  for (let j = 0; j < openTag.length; j++) {
    const char = openTag[j];
    if (afterEquals && (char === '"' || char === "'")) {
      const end = openTag.indexOf(char, j + 1);
      if (end === -1) {
        ranges.push({ start: j, end: openTag.length });
        break;
      }
      ranges.push({ start: j, end });
      j = end;
      afterEquals = false;
    } else if (char === "=") {
      afterEquals = true;
    } else if (!HTML_WHITESPACE.has(char)) {
      afterEquals = false;
    }
  }
  return ranges;
};

/**
 * Helper to inject or append a scoped class onto an open HTML tag without
 * corrupting class-like text nested inside other attribute values.
 */
export const injectClassIntoTag = (
  openTag: string,
  className: string,
): string => {
  if (!/\sclass\s*=/i.test(openTag)) {
    return openTag.replace(
      /^<[a-zA-Z0-9-]+/i,
      (tagHead) => `${tagHead} class="${className}"`,
    );
  }
  const stringRanges = quotedAttributeValueRanges(openTag);

  let replaced = false;
  let finalStr = "";
  const attrRegexG =
    /(?:\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+?))(?=\s|\/>|>|$)/gi;
  let match;

  while (!replaced && (match = attrRegexG.exec(openTag)) !== null) {
    const matchStart = match.index;
    const isInside = stringRanges.some(
      (r) => matchStart > r.start && matchStart < r.end,
    );
    if (!isInside) {
      const classQuote = match[2] !== undefined ? "'" : '"';
      const rawUnquoted = match[3];
      const trailingSlash =
        rawUnquoted !== undefined && rawUnquoted.endsWith("/") ? "/" : "";
      const unquotedClean =
        rawUnquoted !== undefined && rawUnquoted.endsWith("/")
          ? rawUnquoted.slice(0, -1)
          : rawUnquoted;
      const classVal = match[1] ?? match[2] ?? unquotedClean ?? "";
      finalStr =
        openTag.substring(0, matchStart) +
        ` class=${classQuote}${classVal ? classVal + " " : ""}${className}${classQuote}${trailingSlash}` +
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

const shieldNonMarkupHtml = (
  html: string,
): { html: string; restore: (value: string) => string } => {
  const commentShield = createContentShield(html);
  const withoutComments = html.includes("<!--")
    ? html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
        commentShield.hide(comment),
      )
    : html;
  const rawText = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);
  return {
    html: rawText.html,
    restore: (value: string) => commentShield.restore(rawText.restore(value)),
  };
};

/**
 * If a component's css styles any element, add bascik classes to those elements
 */
export const addElementClassesInHtml = (
  componentHtml: string,
  componentName: string,
  elementsConvertedClasses: string[] = [],
): string => {
  if (elementsConvertedClasses.length === 0) return componentHtml;
  const shielded = shieldNonMarkupHtml(componentHtml);
  const elementClassMap = new Map<string, string>();
  const escapedElements: string[] = [];
  for (const element of elementsConvertedClasses) {
    const lower = element.toLowerCase();
    if (!elementClassMap.has(lower)) {
      elementClassMap.set(
        lower,
        minifyAttributeName(`bascik__${componentName}__el__${element}`),
      );
      escapedElements.push(element.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  const replaceTag = (openTag: string, tagName: string): string => {
    const bascikClassName = elementClassMap.get(tagName.toLowerCase());
    return bascikClassName
      ? injectClassIntoTag(openTag, bascikClassName)
      : openTag;
  };
  // Element names from CSS selectors are `[a-z][a-z1-6]*`; any other name
  // keeps the regex, which is quadratic on openers that never reach `>`.
  if ([...elementClassMap.keys()].every((name) => /^[\w:-]+$/.test(name))) {
    const html = shielded.html;
    return shielded.restore(
      replaceSpans(
        html,
        openTagsOf(elementOpenTags(html, new Set(elementClassMap.keys()))),
        (openTag, { start, chainStart }) =>
          replaceTag(openTag, html.slice(start + 1, chainStart)),
      ),
    );
  }
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const combinedPattern = new RegExp(
    `<(${escapedElements.join("|")})(?![\\w.:-])(?:[^>"']|"[^"]*"|'[^']*')*>`,
    "gis",
  );
  const result = shielded.html.replace(combinedPattern, replaceTag);
  return shielded.restore(result);
};

export const getKeyframeNames = (css: string): string[] | null => {
  if (!css.includes("@keyframes") && !css.includes("@KEYFRAMES")) return null;
  // Anchor on the @keyframes at-rule itself so only the declared animation
  // name is captured — never `from`/`to`/percentage selectors or idents that
  // merely appear later in the stylesheet. Full CSS ident: [\w-]+ covers
  // dashed (fade-in), digit (spin2), and uppercase (pulseFast) names.
  const { css: shielded } = shieldCssStrings(css);
  const matches = shielded.matchAll(/@keyframes\s+([\w-]+)\s*\{/gi);
  const names = [...new Set([...matches].map((m) => m[1]))];
  return names.length ? names : null;
};

const scopeAnimationShorthandValue = (
  value: string,
  scopedNames: Map<string, string>,
): string => {
  const TIMING_KEYWORDS = new Set([
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "linear",
    "step-start",
    "step-end",
  ]);
  const DIRECTION_KEYWORDS = new Set([
    "normal",
    "reverse",
    "alternate",
    "alternate-reverse",
  ]);
  const FILL_MODE_KEYWORDS = new Set(["none", "forwards", "backwards", "both"]);
  const PLAY_STATE_KEYWORDS = new Set(["running", "paused"]);
  const ITERATION_KEYWORDS = new Set(["infinite"]);

  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));

  return parts
    .map((single) => {
      type Token =
        | { type: "func"; raw: string; start: number; end: number }
        | { type: "ident"; value: string; start: number; end: number }
        | { type: "number"; raw: string; start: number; end: number }
        | { type: "other"; raw: string; start: number; end: number };

      const tokens: Token[] = [];
      let i = 0;
      while (i < single.length) {
        const ch = single[i];
        if (/\s/.test(ch)) {
          i++;
          continue;
        }
        const numericMatch =
          /^([+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)(%|[A-Za-z_][\w-]*)?/.exec(
            single.slice(i),
          );
        if (numericMatch) {
          const raw = numericMatch[0];
          const tokenStart = i;
          const end = i + raw.length;
          tokens.push({
            type: numericMatch[2] ? "other" : "number",
            raw,
            start: tokenStart,
            end,
          });
          i = end;
          continue;
        }
        const identMatch =
          /^(?:--[A-Za-z0-9_-]+|-[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)/.exec(
            single.slice(i),
          );
        if (identMatch) {
          const name = identMatch[0];
          const tokenStart = i;
          const afterIdent = i + name.length;
          if (single[afterIdent] === "(") {
            let funcDepth = 1;
            let j = afterIdent + 1;
            while (j < single.length && funcDepth > 0) {
              if (single[j] === "(") funcDepth++;
              else if (single[j] === ")") funcDepth--;
              j++;
            }
            tokens.push({
              type: "func",
              raw: single.slice(tokenStart, j),
              start: tokenStart,
              end: j,
            });
            i = j;
            continue;
          } else {
            tokens.push({
              type: "ident",
              value: name,
              start: tokenStart,
              end: afterIdent,
            });
            i = afterIdent;
            continue;
          }
        }
        const tokenStart = i;
        while (
          i < single.length &&
          !/\s/.test(single[i]) &&
          !/^[+-]?(?:\d*\.\d+|\d+)/.test(single.slice(i)) &&
          !/^(?:--[A-Za-z0-9_-]|-[A-Za-z_]|[A-Za-z_])/.test(single.slice(i))
        ) {
          i++;
        }
        tokens.push({
          type: "other",
          raw: single.slice(tokenStart, i),
          start: tokenStart,
          end: i,
        });
      }

      let timingConsumed = false;
      let directionConsumed = false;
      let fillModeConsumed = false;
      let playStateConsumed = false;
      let iterationConsumed = false;
      const nonNameOffsets = new Set<number>();

      for (const token of tokens) {
        if (token.type === "func") {
          if (
            !timingConsumed &&
            /^(?:linear|cubic-bezier|steps)\(/i.test(token.raw)
          ) {
            timingConsumed = true;
          }
          continue;
        }
        if (token.type === "number") {
          iterationConsumed = true;
          continue;
        }
        if (token.type === "ident") {
          const lower = token.value.toLowerCase();
          if (!timingConsumed && TIMING_KEYWORDS.has(lower)) {
            nonNameOffsets.add(token.start);
            timingConsumed = true;
          } else if (!directionConsumed && DIRECTION_KEYWORDS.has(lower)) {
            nonNameOffsets.add(token.start);
            directionConsumed = true;
          } else if (!fillModeConsumed && FILL_MODE_KEYWORDS.has(lower)) {
            nonNameOffsets.add(token.start);
            fillModeConsumed = true;
          } else if (!playStateConsumed && PLAY_STATE_KEYWORDS.has(lower)) {
            nonNameOffsets.add(token.start);
            playStateConsumed = true;
          } else if (!iterationConsumed && ITERATION_KEYWORDS.has(lower)) {
            nonNameOffsets.add(token.start);
            iterationConsumed = true;
          }
        }
      }

      let out = "";
      let last = 0;
      for (const token of tokens) {
        out += single.slice(last, token.start);
        if (token.type === "ident") {
          if (
            !nonNameOffsets.has(token.start) &&
            scopedNames.has(token.value)
          ) {
            out += scopedNames.get(token.value);
          } else {
            out += token.value;
          }
        } else {
          out += token.raw;
        }
        last = token.end;
      }
      out += single.slice(last);
      return out;
    })
    .join(",");
};

export const prefixKeyframes = (css: string, componentName: string): string => {
  const keyframeNames = getKeyframeNames(css);
  if (!Array.isArray(keyframeNames)) return css;
  const scopedNames = new Map<string, string>();
  for (const name of keyframeNames) {
    // Skip names that are already scoped — prevents double-scoping when the
    // pipeline runs more than once on the same CSS.
    if (name.startsWith("bascik__")) continue;
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__keyframe__${name}`),
    );
  }
  if (scopedNames.size === 0) return css;
  // Scope @keyframes declarations and animation / animation-name property values
  // so a keyframe named `color`, `flex`, `grid`, or `in` never clobbers CSS
  // property names, unrelated declarations, or selectors.
  const { css: shielded, restore } = shieldCssStrings(css);
  const replaced = shielded
    .replace(
      /(@keyframes\s+)([\w-]+)(?=\s*\{)/gi,
      (_match, prefix: string, name: string) =>
        `${prefix}${scopedNames.get(name) ?? name}`,
    )
    .replace(
      /((?:^|[;{]\s*)(?:-[a-z]+-)?animation-name\s*:\s*)([^;{}]+)/gim,
      (_match, prefix: string, value: string) =>
        `${prefix}${value.replace(
          /(?<![@.\w#-])([\w-]+)(?![\w(-])/g,
          (name: string) => scopedNames.get(name) ?? name,
        )}`,
    )
    .replace(
      /((?:^|[;{]\s*)(?:-[a-z]+-)?animation\s*:\s*)([^;{}]+)/gim,
      (_match, prefix: string, value: string) =>
        `${prefix}${scopeAnimationShorthandValue(value, scopedNames)}`,
    );
  return restore(replaced);
};

// An `[id]` attribute selector (`[id]`, `[ ID ]`, `[id="x"]`, `[id~=x]`), but
// not a longer attribute name such as `[id-ref]` or `[idx]`.
const ID_ATTRIBUTE_SELECTOR = /\[\s*id\s*(?:[~|^$*]?=|\])/i;

/** Split a selector list at its top-level commas (not inside `()` or `[]`). */
const splitSelectorList = (selectorList: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let partStart = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const char = selectorList[i];
    if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && depth > 0) depth--;
    else if (char === "," && depth === 0) {
      parts.push(selectorList.slice(partStart, i));
      partStart = i + 1;
    }
  }
  parts.push(selectorList.slice(partStart));
  return parts;
};

/** The index just past the `}` that closes the block opened at `open`. */
const blockEnd = (css: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i + 1;
  }
  return css.length;
};

export const removeIdSelectors = (css: string): string => {
  if (!ID_ATTRIBUTE_SELECTOR.test(css)) return css;
  // Strips the [id] / [id="…"] attribute-selector form which cannot be
  // reliably scoped without DOM wrapping.  The hash form (#foo) is now
  // handled by convertCssIdSelectorsToClasses.
  // Shield string literals first so a `}` inside a quoted value (e.g.
  // content: "x}y") can't end a block early.
  const { css: shielded, restore } = shieldCssStrings(css);
  let result = "";
  let copiedTo = 0;
  // A rule prelude is the text from the last `{`, `}` or `;` to the next `{`.
  let preludeStart = 0;
  for (let i = 0; i < shielded.length; i++) {
    const char = shielded[i];
    if (char === ";" || char === "}") {
      preludeStart = i + 1;
      continue;
    }
    if (char !== "{") continue;
    const prelude = shielded.slice(preludeStart, i);
    const selectorStart =
      preludeStart + (prelude.length - prelude.trimStart().length);
    preludeStart = i + 1;
    // At-rule preludes (`@supports selector([id])`) are not selectors.
    if (shielded[selectorStart] === "@" || !ID_ATTRIBUTE_SELECTOR.test(prelude))
      continue;
    const keptSelectors = splitSelectorList(prelude)
      .filter((part) => !ID_ATTRIBUTE_SELECTOR.test(part))
      .map((part) => part.trim())
      .filter(Boolean);
    result += shielded.slice(copiedTo, selectorStart);
    if (keptSelectors.length > 0) {
      result += `${keptSelectors.join(", ")} `;
      copiedTo = i;
    } else {
      // Drop the whole rule, nested blocks included.
      copiedTo = blockEnd(shielded, i);
      i = copiedTo - 1;
      preludeStart = copiedTo;
    }
  }
  return restore(result + shielded.slice(copiedTo));
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
  if (!css.includes("#")) return { css, idsConverted: [] };
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
/**
 * `html.replace(new RegExp(`<[a-zA-Z0-9-]+${CHAIN}${idMarker}${CHAIN}>`, "gi"), replace)`
 * (CHAIN the attribute chain `(?:[^>"']|"[^"]*"|'[^']*')*`) in linear time;
 * the regex took cubic time. The marker holds no `>` and its quoted value
 * ends at the first same quote, so the chain walks it the same way: a tag
 * matches when its chain reaches a `>` and can stop before a marker.
 */
const replaceIdTags = (
  html: string,
  idMarker: string,
  replace: (openTag: string) => string,
): string => {
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const marker = new RegExp(idMarker, "iy");
  const anchors = findWhitespaceMarkerAnchors(html, /id/gi, marker);
  if (anchors.length === 0) return html;
  const markerAt = createMarkerWalk(html, anchors, "first");
  // `[a-zA-Z0-9-]+`: the chain takes any name characters after the first.
  const tags = createOpenTagScanner(html, (start) => {
    const code = html.charCodeAt(start + 1);
    return (code >= 0x30 && code <= 0x39) ||
      ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a) ||
      code === 0x2d
      ? start + 2
      : -1;
  });
  function* matching(): Generator<OpenTagMatch> {
    for (let tag = tags.next(0); tag !== null;) {
      if (markerAt(tag.chainStart) === -1) tag = tags.next(tag.start + 1);
      else {
        yield tag;
        tag = tags.next(tag.end);
      }
    }
  }
  return replaceSpans(html, matching(), replace);
};

export const addIdClassesInHtml = (
  html: string,
  idsConverted: { idName: string; className: string }[],
  scopedIdNames?: Record<string, string>,
): string => {
  if (idsConverted.length === 0) return html;
  const shielded = shieldNonMarkupHtml(html);
  let result = shielded.html;
  idsConverted.forEach(({ idName, className }) => {
    const scopedId = scopedIdNames?.[idName];
    if (!result.includes(idName) && (!scopedId || !result.includes(scopedId)))
      return;
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
    const idGroupUnquoted = escapedScoped
      ? `(?:(?:[^\\s"'=<>` + "`" + `]*__)?${escaped}|${escapedScoped})`
      : `(?:[^\\s"'=<>` + "`" + `]*__)?${escaped}`;
    const idMarker = `\\sid\\s*=\\s*(?:"${idGroup}"|'${idGroupSingle}'|${idGroupUnquoted}(?=\\s|\\/>|>))`;
    if (/["'>\s]/.test(idName + (scopedId ?? ""))) {
      // Not a CSS id (those are `[a-zA-Z][\w-]*`): keep the regex.
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const idPattern = new RegExp(
        `<[a-zA-Z0-9-]+(?:[^>"']|"[^"]*"|'[^']*')*${idMarker}(?:[^>"']|"[^"]*"|'[^']*')*>`,
        "gi",
      );
      result = result.replace(idPattern, (openTag) =>
        injectClassIntoTag(openTag, className),
      );
      return;
    }
    result = replaceIdTags(result, idMarker, (openTag) =>
      injectClassIntoTag(openTag, className),
    );
  });
  return shielded.restore(result);
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
  const shield = createContentShield(css);
  // Quoted strings (with escape handling), url(...) contents, and unquoted
  // attribute-selector values (so a[href$=.pdf] keeps `[...]` visible to
  // selector passes while hiding `.pdf` from class-selector regexes).
  const shielded = css.replace(
    /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\)|(\[\s*[\w-]+\s*[~|^$*]?=\s*)([^\]"'\s]+)(?=\s*\])/gi,
    (match, _str?: string, attrPrefix?: string, unquotedVal?: string) =>
      attrPrefix !== undefined && unquotedVal !== undefined
        ? `${attrPrefix}${shield.hide(unquotedVal)}`
        : shield.hide(match),
  );
  return {
    css: shielded,
    restore: shield.restore,
  };
};

// One CSS escape: a hex code point (1-6 digits, one optional whitespace
// terminator) or any other character except a newline.
const CSS_ESCAPE_SOURCE = String.raw`\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n\r\f0-9a-fA-F])`;

/**
 * The class name after each `.` in CSS whose strings and `url()` contents are
 * shielded: an identifier that starts with a letter, `_`, a non-ASCII
 * character or an escape, and runs over word characters, `-`, non-ASCII
 * characters and escapes (`.md\:flex`, `.w-1\/2`, `.\31 0`).
 */
const cssClassSelectorNames = (): RegExp =>
  new RegExp(
    String.raw`(?<=\.)(?:[a-zA-Z_\u0080-\uffff]|${CSS_ESCAPE_SOURCE})(?:[\w\u0080-\uffff-]|${CSS_ESCAPE_SOURCE})*`,
    "g",
  );

/** The identifier a CSS escape sequence stands for (`md\:flex` -> `md:flex`). */
export const unescapeCssIdentifier = (raw: string): string =>
  raw.includes("\\")
    ? raw.replace(
        /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g,
        (_match, hex: string | undefined, char: string | undefined) => {
          if (hex === undefined) return char ?? "";
          const codePoint = Number.parseInt(hex, 16);
          return codePoint === 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? "\ufffd"
            : String.fromCodePoint(codePoint);
        },
      )
    : raw;

/**
 * Escape a class name for use after `.` in a selector, past its first
 * character: anything other than a word character, `-` or non-ASCII is
 * escaped (control characters as hex), so `md:flex` -> `md\:flex`.
 */
const escapeCssIdentifierTail = (name: string): string =>
  name.replace(/[^\w\u0080-\uffff-]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f
      ? `\\${code.toString(16)} `
      : `\\${char}`;
  });

/** Every class name a (string-shielded) stylesheet declares, unescaped. */
export const declaredCssClassNames = (shieldedCss: string): string[] =>
  [...shieldedCss.matchAll(cssClassSelectorNames())].map(([raw]) =>
    unescapeCssIdentifier(raw),
  );

/**
 * Rename every class selector in a (string-shielded) stylesheet to
 * `bascik__<scopeKey>__<name>`, hashed when identifiers are minified. An
 * escaped name is unescaped first, so the selector and the class attribute
 * token it matches get the same scoped name, then escaped again.
 */
export const scopeCssClassSelectors = (
  shieldedCss: string,
  scopeKey: string,
): string =>
  shieldedCss.replace(cssClassSelectorNames(), (raw) => {
    if (!raw.includes("\\"))
      return minifyAttributeName(`bascik__${scopeKey}__${raw}`);
    const name = unescapeCssIdentifier(raw);
    const full = `bascik__${scopeKey}__${name}`;
    const scoped = minifyAttributeName(full);
    return scoped === full
      ? `bascik__${scopeKey}__${escapeCssIdentifierTail(name)}`
      : escapeCssIdentifierTail(scoped);
  });

/**
 * Hide every at-rule prelude except `@scope`'s (from the `@` up to the next
 * `{`, `;` or `}`) behind shield tokens. Run on CSS whose strings and `url()`
 * contents are already shielded, so an `@` inside them is never matched.
 */
const shieldAtRulePreludes = (
  css: string,
): { css: string; restore: (s: string) => string } => {
  if (!css.includes("@")) return { css, restore: (value) => value };
  const shield = createContentShield(css);
  return {
    css: css.replace(/@(?!scope(?![\w-]))[\w-]+[^{};]*/gi, (prelude) =>
      shield.hide(prelude),
    ),
    restore: shield.restore,
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
      while (j < css.length && css[j] !== char && css[j] !== "\n")
        j += css[j] === "\\" ? 2 : 1;
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
export const observeCssImportPlanning = <T>(
  observer: () => void,
  run: () => T,
): T => {
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
  const importRegex =
    /@import\s+(?:url\(\s*(?:([`'"])([\s\S]*?)\1|([^)]*?))\s*\)|([`'"])([\s\S]*?)\4)([^;]*);?/gi;
  const opaque = cssOpaqueRanges(css);
  let opaqueIndex = 0;
  const plans: CssImportPlan[] = [];
  for (const match of css.matchAll(importRegex)) {
    const start = match.index;
    while (opaqueIndex < opaque.length && opaque[opaqueIndex][1] <= start)
      opaqueIndex++;
    if (opaqueIndex < opaque.length && opaque[opaqueIndex][0] <= start)
      continue;
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
      plans.push({
        fullStatement,
        parsed,
        targetPath,
        dependencyPaths,
        nextVisited,
        replacement: "",
      });
    } else {
      plans.push({
        fullStatement,
        parsed,
        targetPath,
        dependencyPaths,
        nextVisited,
      });
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
      const importedRaw = cleanImportedCss(
        (await readFile(plan.targetPath)).toString(),
      );
      const nestedResolved = await resolveCssImports(
        importedRaw,
        plan.targetPath,
        plan.nextVisited,
        dependencies,
      );
      result = replaceCssImport(
        result,
        plan.fullStatement,
        wrapPlannedCss(nestedResolved, plan),
      );
    } catch (err) {
      console.warn(
        "[bascik] warning: Failed to read imported CSS file %s:",
        plan.targetPath,
        err,
      );
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
      const importedRaw = cleanImportedCss(
        readFileSync(plan.targetPath, "utf-8"),
      );
      const nestedResolved = resolveCssImportsSync(
        importedRaw,
        plan.targetPath,
        plan.nextVisited,
        dependencies,
      );
      result = replaceCssImport(
        result,
        plan.fullStatement,
        wrapPlannedCss(nestedResolved, plan),
      );
    } catch (err) {
      console.warn(
        "[bascik] warning: Failed to read imported CSS file %s:",
        plan.targetPath,
        err,
      );
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

  const importRegex =
    /@import\s+(?:url\(\s*(?:([`'"])([\s\S]*?)\1|([^)]*?))\s*\)|([`'"])([\s\S]*?)\4)[^;]*;/gi;
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
    return await resolveCssImports(
      raw,
      cssFileName,
      undefined,
      importDependencies,
    );
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
/**
 * Custom property names (without `--`) a stylesheet declares, as `--name:`
 * declarations or `@property --name` rules, in first-seen order.
 */
export const declaredCustomPropertyNames = (css: string): Set<string> =>
  css.includes("--")
    ? customPropertyNamesInShielded(shieldCssStrings(css).css)
    : new Set();

const customPropertyNamesInShielded = (shielded: string): Set<string> => {
  const names = new Set<string>();
  for (const m of shielded.matchAll(/(?<!-)--(\w[\w-]*)(?=\s*:)/gm))
    names.add(m[1]);
  for (const m of shielded.matchAll(/@property\s+--(\w[\w-]*)\s*\{/gm))
    names.add(m[1]);
  return names;
};

const customPropertyScoper = (
  names: ReadonlySet<string>,
  componentName: string,
) => {
  const scoped = new Map<string, string>();
  for (const name of names)
    scoped.set(name, minifyAttributeName(`bascik__${componentName}__${name}`));
  // Whole names only, so a later declared property name never matches inside
  // an earlier generated name or a longer name.
  return (match: string, prefix: string, name: string): string => {
    const scopedName = scoped.get(name);
    return scopedName === undefined ? match : `${prefix}--${scopedName}`;
  };
};

export const scopeCssCustomProperties = (
  css: string,
  componentName: string,
): string => {
  if (!css.includes("--")) return css;
  const { css: shielded, restore } = shieldCssStrings(css);
  const names = customPropertyNamesInShielded(shielded);
  if (names.size === 0) return css;
  const scopeName = customPropertyScoper(names, componentName);
  const replaced = shielded
    .replace(/(@property\s+)--(\w[\w-]*)(?=\s*\{)/gm, scopeName)
    .replace(/((?<!-))--(\w[\w-]*)(?=\s*:)/gm, scopeName)
    .replace(/(var\(\s*)--(\w[\w-]*)(?=\s*[,)])/gm, scopeName);
  return restore(replaced);
};

/**
 * Rename the custom properties a component's stylesheets declare inside one
 * `style` attribute value, the way `scopeCssCustomProperties` renames them in
 * the stylesheet: `--name:` declarations and `var(--name)` references. Names
 * the stylesheets do not declare stay global.
 */
export const scopeCustomPropertiesInStyleValue = (
  value: string,
  names: ReadonlySet<string>,
  componentName: string,
): string => {
  if (names.size === 0 || !value.includes("--")) return value;
  const { css: shielded, restore } = shieldCssStrings(value);
  const scopeName = customPropertyScoper(names, componentName);
  return restore(
    shielded
      .replace(/((?<![\w-]))--(\w[\w-]*)(?=\s*:)/gm, scopeName)
      .replace(/(var\(\s*)--(\w[\w-]*)(?=\s*[,)])/gm, scopeName),
  );
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
  const { css: shielded, restore } = shieldCssStrings(css);
  shielded.replace(
    /@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)/g,
    (_: string, nameList: string) => {
      nameList.split(",").forEach((n) => layerNames.add(n.trim()));
      return "";
    },
  );
  if (layerNames.size === 0) return css;
  const scopedNames = new Map<string, string>();
  layerNames.forEach((name) => {
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__layer__${name}`),
    );
  });
  const replaced = shielded.replace(
    /(@layer\s+)([\w-]+(?:\s*,\s*[\w-]+)*)/g,
    (_: string, prefix: string, nameList: string) =>
      `${prefix}${nameList.replace(/[\w-]+/g, (name) => scopedNames.get(name) ?? name)}`,
  );
  return restore(replaced);
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
  const { css: shielded, restore } = shieldCssStrings(css);
  shielded.replace(
    /(?<![\w-])container(?:-name)?\s*:\s*([\w-]+)/g,
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
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__container__${name}`),
    );
  });
  const replaced = shielded
    .replace(
      /(?<=@container\s+)([\w-]+)(?=\s*[({])/gm,
      (name: string) => scopedNames.get(name) ?? name,
    )
    .replace(
      /((?<![\w-])container(?:-name)?\s*:\s*)([\w-]+)/gm,
      (match: string, prefix: string, name: string) => {
        const scoped = scopedNames.get(name);
        return scoped === undefined ? match : `${prefix}${scoped}`;
      },
    );
  return restore(replaced);
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
  if (!css.includes("view-transition-name")) return css;
  const names = new Set<string>();
  const { css: shielded, restore } = shieldCssStrings(css);
  shielded.replace(
    /(?<![\w-])view-transition-name\s*:\s*([\w-]+)/g,
    (_: string, name: string) => {
      if (name !== "none" && name !== "auto") names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  const scopedNames = new Map<string, string>();
  names.forEach((name) => {
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__vtn__${name}`),
    );
  });
  const replaced = shielded
    .replace(
      /((?<![\w-])view-transition-name\s*:\s*)([\w-]+)(?![\w-])/gm,
      (match: string, prefix: string, name: string) => {
        const scoped = scopedNames.get(name);
        return scoped === undefined ? match : `${prefix}${scoped}`;
      },
    )
    .replace(
      /(::view-transition-(?:old|new|group|image-pair)\()([\w-]+)(\))/gm,
      (match: string, prefix: string, name: string, suffix: string) => {
        const scoped = scopedNames.get(name);
        return scoped === undefined ? match : `${prefix}${scoped}${suffix}`;
      },
    );
  return restore(replaced);
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
 *   counter(section, thumbs)                  →  counter(section, thumbs) -> scoped
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
  if (!css.includes("@counter-style")) return css;
  const names = new Set<string>();
  const { css: shielded, restore } = shieldCssStrings(css);
  // Collect all @counter-style declarations
  shielded.replace(
    /@counter-style\s+([\w-]+)\s*\{/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  const scopedNames = new Map<string, string>();
  names.forEach((name) => {
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__counter__${name}`),
    );
  });
  // One pass per pattern over whole names: rewriting one name at a time let a
  // later name match inside an earlier generated name or a longer name.
  const scopeName = (match: string, prefix: string, name: string): string => {
    const scoped = scopedNames.get(name);
    return scoped === undefined ? match : `${prefix}${scoped}`;
  };
  const replaced = shielded
    // The @counter-style declaration
    .replace(/(@counter-style\s+)([\w-]+)(?=\s*\{)/gm, scopeName)
    // list-style and list-style-type property references
    .replace(/((?<![\w-])list-style(?:-type)?\s*:\s*)([\w-]+)/gm, scopeName)
    // counter() second argument: counter(name, style)
    .replace(/((?<![\w-])counter\([^,)]+,\s*)([\w-]+)(?=[^)]*\))/gm, scopeName)
    // counters() third argument: counters(name, sep, style)
    .replace(
      /((?<![\w-])counters\([^,)]+,\s*[^,)]+,\s*)([\w-]+)(?=[^)]*\))/gm,
      scopeName,
    );
  return restore(replaced);
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
  if (!css.includes("anchor-name") && !css.includes("@position-try"))
    return css;
  const names = new Set<string>();
  const { css: shielded, restore } = shieldCssStrings(css);
  // Collect all anchor-name: --name declarations and @position-try --name declarations
  shielded.replace(
    /(?<![\w-])anchor-name\s*:\s*--(\w[\w-]*)/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  shielded.replace(
    /@position-try\s+--(\w[\w-]*)/g,
    (_: string, name: string) => {
      names.add(name);
      return "";
    },
  );
  if (names.size === 0) return css;

  const scopedNames = new Map<string, string>();
  names.forEach((name) => {
    scopedNames.set(
      name,
      minifyAttributeName(`bascik__${componentName}__anchor__${name}`),
    );
  });
  const scopeName = (match: string, prefix: string, name: string): string => {
    const scoped = scopedNames.get(name);
    return scoped === undefined ? match : `${prefix}--${scoped}`;
  };
  const replaced = shielded
    .replace(/((?<![\w-])anchor-name\s*:\s*)--(\w[\w-]*)(?![\w-])/gm, scopeName)
    .replace(
      /((?<![\w-])position-anchor\s*:\s*)--(\w[\w-]*)(?![\w-])/gm,
      scopeName,
    )
    .replace(/(@position-try\s+)--(\w[\w-]*)(?=\s*\{)/gm, scopeName);
  return restore(replaced);
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
  const commentShield = createContentShield(html);
  const htmlWithMaskedComments = html.includes("<!--")
    ? html.replace(/<!--[\s\S]*?(?:-->|$)/g, (match) =>
        commentShield.hide(match),
      )
    : html;

  const shielded = shieldElementContents(htmlWithMaskedComments, [
    "code",
    "pre",
    "script",
    "textarea",
  ]);

  const cssBlocks: string[] = [];
  const collectStyleBlock = (
    _match: string,
    openTag: string,
    styleContent: string,
  ): string => {
    let css = removeCommentsFromCss(styleContent).trim();
    if (!css) return "";
    // Read `media` the way the browser does, so a range query such as
    // `(width > 600px)` is read whole. The first `media` attribute counts.
    const media =
      readStartTagAttributes(openTag, 0)
        .find((attribute) => attribute.name === "media")
        ?.value.trim() ?? "";
    if (
      media &&
      media.toLowerCase() !== "all" &&
      media.toLowerCase() !== "screen"
    ) {
      css = `@media ${media} {\n${css}\n}`;
    }
    cssBlocks.push(css);
    return "";
  };

  // Removing a block can join the text around it into a new `<style>` block
  // (for example `<sty<style>a{}</style>le>b{}</style>`), so repeat until the
  // HTML stops changing. Every pass that changes the HTML shortens it, so the
  // loop always ends.
  let cleanedHtml = shielded.html;
  let previousHtml: string;
  do {
    previousHtml = cleanedHtml;
    // `(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)`
    // (flags `gi`), in linear time.
    cleanedHtml = replaceScannedElements(
      cleanedHtml,
      "style",
      { opener: "tag-space", closer: "attributes" },
      (openTag, styleContent) => collectStyleBlock("", openTag, styleContent),
    );
  } while (cleanedHtml !== previousHtml);

  // Restore shielded element content first, then restore masked HTML comments.
  const restoredHtml = commentShield.restore(shielded.restore(cleanedHtml));

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
  if (!html.includes("<style") && !html.includes("<STYLE")) {
    return { html, elementsConvertedClasses: [], idsConverted: [] };
  }
  const allElementClasses: string[] = [];
  const allIdsConverted: { idName: string; className: string }[] = [];
  // `(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)`
  // (flags `gi`), in linear time.
  const processedHtml = replaceScannedElements(
    html,
    "style",
    { opener: "tag-space", closer: "attributes" },
    (open: string, styleContent: string, close: string) => {
      let css = resolveCssImportsSync(
        removeCommentsFromCss(styleContent),
        baseFilePath,
      );
      // Shield strings/url() so dots inside them aren't treated as class selectors
      const { css: shieldedCss, restore } = shieldCssStrings(css);
      css = restore(scopeCssClassSelectors(shieldedCss, componentName));
      const { css: idCss, idsConverted } = convertCssIdSelectorsToClasses(
        css,
        componentName,
      );
      css = idCss;
      allIdsConverted.push(...idsConverted);
      const { css: elCss, elementsConvertedClasses } =
        convertCssElementSelectorsToClasses(css, componentName);
      css = elCss;
      allElementClasses.push(...elementsConvertedClasses);
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
