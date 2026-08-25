import { readFile } from "node:fs/promises";
import { minifyAttributeName } from "./names.js";
import type { BascikComponent } from "./types.js";

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
  // The context-aware lookahead confirms we are still in selector position.
  let result = css.replace(
    /(^\s*|[;{}]\s*)([a-z1-6]+)(?=[^{};)]*\{)/gim,
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
  result = result.replace(/(?<=,[ \t]*)[a-z1-6]+(?=[^{};)]*\{)/g, toClass);

  // Pass 3: element selectors in CSS nesting context.
  // Handles `& p { }`, `& > h2 { }`, `& + li { }`, `& ~ span { }`.
  // The `&` anchor is only valid in CSS nesting selectors, making this
  // safe — `&\s+` never appears in property value position.
  result = result.replace(
    /(?<=&\s+(?:[>+~]\s+)?)[a-z1-6]+(?=[^{};)]*\{)/g,
    toClass,
  );

  // Pass 4: element selectors that are descendants of an already-scoped class.
  // Handles `.foo p {}`, `.foo > h2 {}`, `.foo + li {}`, `.foo ~ span {}`.
  //
  // After Pass 1 (class scoping), class names become `bascik__…__foo`. The
  // `bascik__` prefix is a uniquely safe anchor — it never appears in CSS
  // property value position. The negative lookahead `(?!__)` prevents
  // matching the start of another scoped class name (e.g. `bascik__comp__bar`
  // starts with `b` which is in [a-z1-6] but is followed by `ascik__`, so
  // `(?!__)` stops the second `_` from matching after `bascik`).
  //
  // Note: this pass only applies when CSS scoping has already run (Pass 1
  // rewrites `.foo` → `.bascik__comp__foo`, making the anchor available).
  let previousResult: string;
  do {
    previousResult = result;
    result = result.replace(
      /(?<=bascik__[\w-]+\s+(?:[>+~]\s+)?)[a-z1-6]+(?!__)(?=[^{};)]*\{)/g,
      toClass,
    );
  } while (result !== previousResult);

  return { css: result, elementsConvertedClasses };
};

/**
 * If a component's css styles any element, add bascik classes to those elements
 */
// HTML void elements — they have no closing tag, so the paired-tag regex in
// addElementClassesInHtml never matches them. Handle them separately.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

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
    const injectClass = (elementHtml: string): string => {
      // Check only the element's own opening tag for a class attribute,
      // not any nested child's class (which would cause the class to land
      // on the wrong element, e.g. <code> instead of <pre>).
      const openTag = elementHtml.match(new RegExp(`^<${element}\\b[^>]*>`, "i"))?.[0] ?? "";
      if (/\bclass="/.test(openTag)) {
        return elementHtml.replace(/class=".*?(?=")/i, (classStr) => {
          return `${classStr} ${bascikClassName}`;
        });
      }
      if (/\bclass='/.test(openTag)) {
        return elementHtml.replace(/class='.*?(?=')/i, (classStr) => {
          return `${classStr} ${bascikClassName}`;
        });
      }
      return elementHtml.replace(
        new RegExp(`<${element}\\b`, "i"),
        `<${element} class="${bascikClassName}"`,
      );
    };

    if (VOID_ELEMENTS.has(element)) {
      // Void elements: match the standalone opening tag (no closing tag).
      componentHtml = componentHtml.replace(
        new RegExp(`<${element}\\b(\\s[^>]*?)?\\/?>`, "gis"),
        (tag) => injectClass(tag),
      );
      return;
    }

    // Find all the instances of that element in the component.
    // The `s` (dotAll) flag lets `.` match newlines for multi-line element content.
    componentHtml = componentHtml.replace(
      new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)<\\/${element}\\b>`, "gis"),
      (elementHtml: string) => injectClass(elementHtml),
    );
  });
  return componentHtml;
};

/** Returns all `.class { }` rule strings. Useful for CSS analysis. */
export const getCssClasses = (css: string): string[] => {
  const classes = css.match(/\.[\.\w\s\(\)]+{[\w\s\:;#-_]+}/g);
  if (Array.isArray(classes)) return classes;
  return [];
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
      scoped,
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
  const cssStr = css.replace(
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
  return { css: cssStr, idsConverted };
};

/**
 * Inject the generated id-class onto every HTML element whose `id` attribute
 * matches.  Works for both unscoped (`id="idName"`) and already-scoped
 * (`id="bascik__comp__instanceId__idName"`) forms.
 */
export const addIdClassesInHtml = (
  html: string,
  idsConverted: { idName: string; className: string }[],
): string => {
  if (idsConverted.length === 0) return html;
  idsConverted.forEach(({ idName, className }) => {
    if (!html.includes(idName)) return;
    const escaped = idName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(
      new RegExp(`(<[^>]+(?<=\\s)id=(?:"(?:[^"]*__)?${escaped}"|'(?:[^']*__)?${escaped}')[^>]*)>`, "gi"),
      (_: string, tagContent: string) => {
        if (/\bclass="/.test(tagContent)) {
          return (
            tagContent.replace(
              /\bclass="([^"]*)"/,
              (_: string, c: string) => `class="${c} ${className}"`,
            ) + ">"
          );
        }
        if (/\bclass='/.test(tagContent)) {
          return (
            tagContent.replace(
              /\bclass='([^']*)'/,
              (_: string, c: string) => `class='${c} ${className}'`,
            ) + ">"
          );
        }
        return `${tagContent} class="${className}">`;
      },
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

export { minifyCss } from "./css-minifier.js";

export const getComponentCss = async (
  htmlFileName: string,
  cssFileNames: string[],
): Promise<string | undefined> => {
  if (!htmlFileName || !Array.isArray(cssFileNames)) return;
  const cssFileName = cssFileNames.find(
    (cssFileName) => cssFileName.replace(/\.css$/, ".html") === htmlFileName,
  );
  if (!cssFileName) return;
  try {
    return removeCommentsFromCss((await readFile(cssFileName)).toString());
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
    result = result.replace(
      new RegExp(`(?<=@layer[^{;]*)\\b${name}\\b`, "gm"),
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
  let result = css;
  containerNames.forEach((name) => {
    const scoped = minifyAttributeName(
      `bascik__${componentName}__container__${name}`,
    );
    result = result.replace(
      new RegExp(`(?<=@container\\s+)${name}(?=\\s*[({])`, "gm"),
      () => scoped,
    );
    result = result.replace(
      new RegExp(`(container(?:-name)?\\s*:\\s*)${name}`, "gm"),
      (_, p1) => `${p1}${scoped}`,
    );
  });
  return result;
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

  let result = css;
  names.forEach((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scoped = minifyAttributeName(
      `bascik__${componentName}__counter__${name}`,
    );
    // Scope the @counter-style declaration
    result = result.replace(
      new RegExp(`(@counter-style\\s+)${escaped}(?=\\s*\\{)`, "gm"),
      (_, p1) => `${p1}${scoped}`,
    );
    // Scope list-style and list-style-type property references
    result = result.replace(
      new RegExp(`(list-style(?:-type)?\\s*:\\s*)${escaped}\\b`, "gm"),
      (_, p1) => `${p1}${scoped}`,
    );
    // Scope counter() second argument: counter(name, style)
    result = result.replace(
      new RegExp(`(counter\\([^,)]+,\\s*)${escaped}(?=[^)]*\\))`, "gm"),
      (_, p1) => `${p1}${scoped}`,
    );
    // Scope counters() third argument: counters(name, sep, style)
    result = result.replace(
      new RegExp(
        `(counters\\([^,)]+,\\s*[^,)]+,\\s*)${escaped}(?=[^)]*\\))`,
        "gm",
      ),
      (_, p1) => `${p1}${scoped}`,
    );
  });
  return result;
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
  // Collect all anchor-name: --name declarations
  css.replace(
    /anchor-name\s*:\s*--(\w[\w-]*)/g,
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

  // Shield raw-text / code element contents so literal <style> tags in code examples
  // or scripts are untouched.
  const preserved: string[] = [];
  let maskedHtml = html;
  const skipTags = ["code", "pre", "script", "textarea"];
  for (const tag of skipTags) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attr = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
    maskedHtml = maskedHtml.replace(
      new RegExp(`(<${esc}(?:\\b${attr})?>)([\\s\\S]*?)(<\\/${esc}>)`, "gi"),
      (_match, open, inner, close) => {
        preserved.push(inner);
        return `${open}\x00BSKIP${preserved.length - 1}\x00${close}`;
      },
    );
  }

  const cssBlocks: string[] = [];
  const cleanedHtml = maskedHtml.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, openTag: string, styleContent: string) => {
      let css = removeCommentsFromCss(styleContent).trim();
      if (!css) return "";
      const mediaMatch = openTag.match(/\bmedia\s*=\s*["']?([^"'>]+)["']?/i);
      if (
        mediaMatch &&
        mediaMatch[1].trim() &&
        mediaMatch[1].toLowerCase() !== "all" &&
        mediaMatch[1].toLowerCase() !== "screen"
      ) {
        css = `@media ${mediaMatch[1].trim()} {\n${css}\n}`;
      }
      cssBlocks.push(css);
      return "";
    },
  );

  // Restore preserved raw-text element contents
  let finalHtml = cleanedHtml;
  for (let i = preserved.length - 1; i >= 0; i--) {
    finalHtml = finalHtml.split(`\x00BSKIP${i}\x00`).join(preserved[i]);
  }

  return {
    html: finalHtml,
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
): {
  html: string;
  elementsConvertedClasses: string[];
  idsConverted: { idName: string; className: string }[];
} => {
  const allElementClasses: string[] = [];
  const allIdsConverted: { idName: string; className: string }[] = [];
  const processedHtml = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, open: string, styleContent: string, close: string) => {
      let css = removeCommentsFromCss(styleContent);
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
  usedComponents: Pick<BascikComponent, "name" | "cssFileContent">[],
  dedup: boolean = true,
): string => {
  if (!dedup) {
    // Per-instance class scoping: every instance emits its own CSS block.
    return usedComponents
      .map(({ cssFileContent }) => cssFileContent)
      .filter((css): css is string => Boolean(css))
      .join(" ");
  }
  const seen = new Set<string>();
  return usedComponents
    .filter(({ name }) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map(({ cssFileContent }) => cssFileContent)
    .filter((css): css is string => Boolean(css))
    .join(" ");
};
