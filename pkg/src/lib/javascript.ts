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
import { getScriptType, isJavaScriptScript } from "./script-types.ts";
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
import { shieldElementContents } from "./shielding.ts";
import type { BascikComponent } from "./types.ts";

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
    methodRegex.flags.includes("g") ? methodRegex.flags : methodRegex.flags + "g",
  );

  let match;
  while ((match = regex.exec(src)) !== null) {
    const startIndex = match.index + match[0].length;
    let depth = 1;
    let i = startIndex;
    let inString: string | null = null;

    while (i < src.length && depth > 0) {
      const char = src[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === inString) inString = null;
      } else {
        if (char === '"' || char === "'" || char === "`") inString = char;
        else if (char === "(") depth++;
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
): string => {
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const attrRegex = new RegExp(`(\\s${attrName}=)("[^"]*"|'[^']*')`, "gm");

  // This simple regex identifies tags loosely. It handles nested attributes
  // because we only process the attributes inside the matched tag brackets.
  return html.replace(
    /<[a-zA-Z0-9-]+(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/g,
    (tagMatch) => {
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
    });
};
export const prefixElementAttribute = (
  component: BascikComponent,
  attribute: "id" | "name" | "class",
  componentInstanceId: string | null = null,
  deduplicateCss: boolean = true,
  skipElementContents: string[] = [],
): BascikComponent => {
  if (!component.fileContent) return component;

  // Shield inner content of skip elements (e.g. <code>, <pre>) from all transforms.
  const { html: shieldedContent, restore } = shieldElementContents(
    component.fileContent,
    skipElementContents,
  );
  component.fileContent = shieldedContent;
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
  const scopeKey =
    attribute === "class" && deduplicateCss ? component.name : componentInstanceName;
  const attributesToReplace: Array<{
    attributeName: string;
    obfuscatedAttributeName: string;
  }> = [];

  // For class attributes: extract all class names defined in the component's CSS
  // (companion .css and inline <style> tags). Only classes present in component CSS
  // are scoped; classes not in component CSS are treated as global classes.
  let scopedClassesSet: Set<string> | null = null;
  if (attribute === "class" && (component.cssFileContent !== undefined || component.fileContent.includes("<style"))) {
    scopedClassesSet = new Set<string>();
    const cssSources: string[] = [];
    if (component.cssFileContent) {
      cssSources.push(resolveCssImportsSync(component.cssFileContent, component.fileName));
    }
    if (component.fileContent && component.fileContent.includes("<style")) {
      const { css: inlineCss } = extractInlineStyles(component.fileContent);
      if (inlineCss) cssSources.push(resolveCssImportsSync(inlineCss, component.fileName));
    }
    const combinedCss = cssSources.join("\n");
    if (combinedCss) {
      const { css: shieldedCss } = shieldCssStrings(combinedCss);
      for (const m of shieldedCss.matchAll(/(?<=\.)[a-zA-Z_][a-zA-Z0-9_-]*/g)) {
        scopedClassesSet.add(m[0]);
      }
    }
  }

  // Shield <meta> elements from name-attribute scoping. The `name` attribute
  // on <meta> refers to a standardized metadata vocabulary (e.g. "viewport",
  // "description", "robots") and must never be mangled by the scoping pipeline.
  const shieldedMetaTags: string[] = [];
  if (attribute === "name") {
    component.fileContent = component.fileContent.replace(
      /<meta\b[^>]*(?:\/>|>)/gi,
      (tag) => {
        const idx = shieldedMetaTags.push(tag) - 1;
        return `\x00BMETATAG${idx}\x00`;
      },
    );
  }

  // Use replaceSafeAttr instead of a global regex to ignore `class="x"` inside `data-foo='class="x"'`
  const scopedAttrsHtml = replaceSafeAttr(
    component.fileContent,
    attribute,
    (fullMatch, prefix, quotedVal) => {
      const quote = quotedVal[0];
      const match = quotedVal.slice(1, -1);
      if (!match) return fullMatch;
      const newInner = match
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((attributeName: string) => {
          if (attribute === "class" && scopedClassesSet !== null && !scopedClassesSet.has(attributeName)) {
            return attributeName;
          }
          const name = `bascik__${scopeKey}__${attributeName}`;
          const obfuscatedAttributeName = minifyAttributeName(name);
          attributesToReplace.push({ attributeName, obfuscatedAttributeName });
          return obfuscatedAttributeName;
        })
        .join(" ");
      return `${prefix}${quote}${newInner}${quote}`;
    },
  );

  // Discover class names used only in JS (never in a class= attr).
  // The CSS pass scopes every class name it finds, so JS-only classes would
  // otherwise be scoped in CSS but left unscoped in JS, making the two out of sync.
  // Covers: classList.*, querySelector-family (".cls"), className =, setAttribute("class",…)
  if (attribute === "class") {
    const knownClasses = new Set(attributesToReplace.map((a) => a.attributeName));
    const addIfNew = (className: string): void => {
      if (scopedClassesSet !== null && !scopedClassesSet.has(className)) {
        return;
      }
      if (!knownClasses.has(className)) {
        attributesToReplace.push({
          attributeName: className,
          obfuscatedAttributeName: minifyAttributeName(`bascik__${scopeKey}__${className}`),
        });
        knownClasses.add(className);
      }
    };

    for (const scriptMatch of scopedAttrsHtml.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi,
    )) {
      const openTag = scriptMatch[1];
      if (/\b(?:data-bascik-server|data-bascik-build|data-bascik-routes)\b/i.test(openTag)) continue;
      const src = scriptMatch[2];

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
        /(?:querySelector(?:All)?|closest|matches)\(\s*["']([^"']*)["']\s*\)/gm,
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
        /setAttribute\(\s*["']class["']\s*,\s*["']([^"']*)["']\s*\)/gm,
      )) {
        for (const token of attrMatch[1].trim().split(/\s+/)) {
          if (token) addIfNew(token);
        }
      }
    }
  }

  // Rewrite DOM selector references in script blocks to use the scoped attribute values.
  const scopedHtml = scopedAttrsHtml.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script[^>]*>)/gi,
    (match, open) => {
      if (/\b(?:data-bascik-server|data-bascik-build|data-bascik-routes)\b/i.test(open)) return match;
      let updatedMatch = match;
      attributesToReplace.forEach(
        ({ attributeName, obfuscatedAttributeName }) => {
          if (!updatedMatch.includes(attributeName)) return;
          const rewriteSelectorRef = (regexp: RegExp, dot = ""): string => {
            // https://www.codemzy.com/blog/regex-groups-with-replace
            return updatedMatch.replace(regexp, (match, start, middle, end) => {
              return `${start}${dot}${obfuscatedAttributeName}${end}`;
            });
          };

          // Escape the attribute name once for use in RegExp patterns.
          const escapedAttr = attributeName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );

          // Rewrite the full selector string of a querySelector-family call,
          // replacing every occurrence of the scoped token.  Handles both
          // single-token selectors ("#id", ".cls") and compound selectors
          // (".foo .bar", "#id .child", etc.).
          // Limitation: adjacent-class compound selectors without a space
          // (.foo.bar) are not rewritten for the non-leading token because
          // `.bar` is preceded by a word character.  Use a space or combinator
          // to separate selectors instead.
          const rewriteInSelectorString = (
            method: string,
            prefix: string,
          ): void => {
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const methodCallRegex = new RegExp(`(${method}\\(\\s*['"][^'"]*['"]\\s*\\))`, "gm");
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const tokenRegex = new RegExp(
              `(?<![a-zA-Z0-9_-])\\${prefix}${escapedAttr}(?![a-zA-Z0-9_-])`,
              "g",
            );
            updatedMatch = updatedMatch.replace(
              methodCallRegex,
              (call) =>
                call.replace(
                  // Token must NOT be immediately preceded or followed by
                  // alphanumeric, underscore, or hyphen (avoids partial
                  // matches inside already-scoped names like __myClass).
                  tokenRegex,
                  () => `${prefix}${obfuscatedAttributeName}`,
                ),
            );
          };

          if (attribute === "id") {
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const getByIdRegex = new RegExp(
              `(?<start>getElementById\\(\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(getByIdRegex);
            // querySelector-family — compound-aware
            for (const method of [
              "querySelector",
              "querySelectorAll",
              "closest",
              "matches",
            ]) {
              rewriteInSelectorString(method, "#");
            }
            // element.setAttribute("id", "value")
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const setIdRegex = new RegExp(
              `(?<start>setAttribute\\(\\s*["']id["'],\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(setIdRegex);
          } else if (attribute === "name") {
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const getByNameRegex = new RegExp(
              `(?<start>getElementsByName\\(\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(getByNameRegex);
            // element.setAttribute("name", "value")
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const setNameRegex = new RegExp(
              `(?<start>setAttribute\\(\\s*["']name["'],\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(setNameRegex);
          } else if (attribute === "class") {
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const getByClassRegex = new RegExp(
              `(?<start>getElementsByClassName\\(\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(getByClassRegex);
            // querySelector-family — compound-aware
            for (const method of [
              "querySelector",
              "querySelectorAll",
              "closest",
              "matches",
            ]) {
              rewriteInSelectorString(method, ".");
            }
            // classList.add / classList.remove — multi-arg aware.
            // Match the entire call then replace every quoted token matching
            // the class name. Handles both `classList.add("x")` and
            // `classList.add("x", "y", …)` forms.
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const classTokenAllRegex = new RegExp(`(["'])${escapedAttr}\\1`, "g");
            updatedMatch = replaceBalancedCall(
              updatedMatch,
              /classList\.(?:add|remove)\s*\(/gm,
              (call) =>
                call.replace(
                  classTokenAllRegex,
                  (_match, quote: string) =>
                    `${quote}${obfuscatedAttributeName}${quote}`,
                ),
            );
            // classList.toggle — rewrites the class-name (first) arg only.
            // Deliberately does NOT require `)` after the closing quote so
            // `classList.toggle("open", condition)` is handled correctly.
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const classTokenSingleRegex = new RegExp(`(["'])${escapedAttr}\\1`);
            updatedMatch = replaceBalancedCall(
              updatedMatch,
              /classList\.toggle\s*\(/gm,
              (call) =>
                call.replace(
                  classTokenSingleRegex,
                  (_match, quote: string) =>
                    `${quote}${obfuscatedAttributeName}${quote}`,
                ),
            );
            // classList.contains — always single arg
            updatedMatch = replaceBalancedCall(
              updatedMatch,
              /classList\.contains\s*\(/gm,
              (call) =>
                call.replace(
                  classTokenSingleRegex,
                  (_match, quote: string) =>
                    `${quote}${obfuscatedAttributeName}${quote}`,
                ),
            );
            // classList.replace(oldToken, newToken) — rewrites both args if
            // either matches a scoped class name.
            updatedMatch = replaceBalancedCall(
              updatedMatch,
              /classList\.replace\s*\(/gm,
              (call) =>
                call.replace(
                  classTokenAllRegex,
                  (_match, quote: string) =>
                    `${quote}${obfuscatedAttributeName}${quote}`,
                ),
            );
            // element.setAttribute("class", "value")
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const setClassRegex = new RegExp(
              `(?<start>setAttribute\\(\\s*["']class["'],\\s*["'])(?<middle>${escapedAttr})(?<end>["']\\s*\\))`,
              "gm",
            );
            updatedMatch = rewriteSelectorRef(setClassRegex);
            // element.className setter — handles both single-class and
            // space-separated multi-class assignments (className = "…" or
            // className += "…").  Replaces each known class token in the
            // string value using the same word-boundary guards as above.
            // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const classNameTokenRegex = new RegExp(
              `(?<![a-zA-Z0-9_-])${escapedAttr}(?![a-zA-Z0-9_-])`,
              "g",
            );
            updatedMatch = updatedMatch.replace(
              /(\bclassName\s*\+?=\s*["'])([^"']*)(['"])/gm,
              (_, prefix, classes, suffix) => {
                const replaced = classes.replace(
                  classNameTokenRegex,
                  () => obfuscatedAttributeName,
                );
                return `${prefix}${replaced}${suffix}`;
              },
            );
          }
        },
      );
      return updatedMatch;
    },
  );
  component.fileContent = scopedHtml;

  // Restore shielded <meta> elements.
  if (shieldedMetaTags.length > 0) {
    component.fileContent = component.fileContent.replace(
      /\x00BMETATAG(\d+)\x00/g,
      (_, idx) => shieldedMetaTags[parseInt(idx, 10)],
    );
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
      component.cssFileContent = resolveCssImportsSync(
        component.cssFileContent,
        component.fileName,
      );
      // Handle basic replacement of classnames in css file.
      // Shield string literals and url(...) contents first so dots inside
      // them (file extensions, domains) are never mistaken for class selectors:
      //   url(./img.png)  must NOT become  url(./img.bascik__…__png)
      const { css: shieldedCss, restore: restoreCssStrings } = shieldCssStrings(
        component.cssFileContent,
      );
      component.cssFileContent = restoreCssStrings(
        shieldedCss.replace(/(?<=\.)[a-z_][a-z0-9-_]*/gim, (className) => {
          return minifyAttributeName(`bascik__${scopeKey}__${className}`);
        }),
      );

      const { css: elSelectorToClassCss, elementsConvertedClasses } =
        convertCssElementSelectorsToClasses(component.cssFileContent, scopeKey);
      component.cssFileContent = elSelectorToClassCss;
      allElementClasses.push(...elementsConvertedClasses);

      component.cssFileContent = prefixKeyframes(
        component.cssFileContent,
        scopeKey,
      );

      // Convert CSS hash-ID selectors (#id) to component-scoped class selectors.
      // Uses a context-aware lookahead to avoid matching hex color values.
      const { css: idSelectorCss, idsConverted } =
        convertCssIdSelectorsToClasses(component.cssFileContent, scopeKey);
      component.cssFileContent = idSelectorCss;
      allIdsConverted.push(...idsConverted);

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
    );
  }

  // Restore any inner content that was shielded from transforms.
  component.fileContent = restore(component.fileContent);

  return component;
};
export interface ComponentScriptInfo {
  relPath: string;
  code: string;
}

export interface ComponentScriptsResult {
  scriptMap: Map<string, ComponentScriptInfo>;
}

export const getComponentScripts = async (
  htmlFileName: string,
  scriptFileNames: string[],
): Promise<ComponentScriptsResult> => {
  const scriptMap = new Map<string, ComponentScriptInfo>();
  if (!htmlFileName || !Array.isArray(scriptFileNames) || scriptFileNames.length === 0) {
    return { scriptMap };
  }

  const htmlDir = dirname(htmlFileName);
  const compDir = BascikConfig.directory.components;
  const isSubfolder = htmlDir !== compDir && htmlDir.startsWith(compDir);
  const componentBaseName = basename(htmlFileName, ".html").toLowerCase();

  const matchingScriptFiles = scriptFileNames.filter((scriptPath) => {
    const scriptDir = dirname(scriptPath);
    if (isSubfolder) {
      return scriptDir === htmlDir || scriptDir.startsWith(htmlDir + "/");
    } else {
      const scriptBaseName = basename(scriptPath);
      const nameWithoutExt = scriptBaseName.replace(/\.(js|ts|mjs)$/, "").toLowerCase();
      return (
        nameWithoutExt === componentBaseName ||
        nameWithoutExt.startsWith(`${componentBaseName}.`) ||
        nameWithoutExt.startsWith(`${componentBaseName}-`) ||
        nameWithoutExt.startsWith(`${componentBaseName}_`)
      );
    }
  });

  matchingScriptFiles.sort((a, b) => {
    const aBase = basename(a).toLowerCase();
    const bBase = basename(b).toLowerCase();
    const aMain = aBase.replace(/\.(js|ts|mjs)$/, "") === componentBaseName;
    const bMain = bBase.replace(/\.(js|ts|mjs)$/, "") === componentBaseName;
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;
    return a.localeCompare(b);
  });

  for (const scriptPath of matchingScriptFiles) {
    try {
      const code = (await readFile(scriptPath)).toString();
      const relPath = relative(process.cwd(), scriptPath).replace(/\\/g, "/");
      const baseName = basename(scriptPath);
      const info: ComponentScriptInfo = { relPath, code };

      scriptMap.set(baseName, info);
      scriptMap.set(`./${baseName}`, info);
      scriptMap.set(relPath, info);

    } catch (err) {
      console.warn("warning: Failed to read script for %s", scriptPath, err);
    }
  }

  return {
    scriptMap,
  };
};

export const namespaceScriptTags = (
  component: BascikComponent,
): BascikComponent => {
  // Only wrap <script> tags with no type or type="text/javascript"
  component.fileContent = component.fileContent.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script[^>]*>)/gi,
    (match, open, code, close, offset) => {
      // Server scripts, build scripts, and route scripts run in Node.js — never wrap in browser IIFE
      if (/\b(?:data-bascik-server|data-bascik-build|data-bascik-routes)\b/i.test(open)) return match;

      // Extract data-bascik-source attribute if present
      const sourceAttrMatch = open.match(/\bdata-bascik-source=["']([^"']+)["']/i);
      const customSourcePath = sourceAttrMatch ? sourceAttrMatch[1] : null;

      // Clean data-bascik-source attribute from open tag
      const cleanOpen = open.replace(/\s*data-bascik-source=["']([^"']+)["']/i, "");

      // Check for type attribute
      const type = getScriptType(cleanOpen);
      const isJsType = isJavaScriptScript(cleanOpen);

      const isExternal = /\bsrc\s*=/i.test(cleanOpen);
      const shouldWrap = !isExternal &&
        (type === undefined || type === "text/javascript");

      const targetPath = customSourcePath || (component.fileName ? relative(process.cwd(), component.fileName).replace(/\\/g, "/") : null);

      if (isExternal) return match;

      if (!shouldWrap) {
        // If type is present and not text/javascript, leave unchanged.
        // If it is a JS type (like module), still add sourceURL if possible.
        if (isJsType && targetPath) {
          const sourceUrlComment = `\n//# sourceURL=${targetPath}`;
          return `${cleanOpen}${code}${sourceUrlComment}${close}`;
        }
        return match;
      }

      const leading = code.startsWith("\n") ? "" : "\n";
      const trailing = code.endsWith("\n") ? "" : "\n";

      if (targetPath) {
        const sourceUrlComment = `\n//# sourceURL=${targetPath}`;
        return `${cleanOpen}(function() {${leading}${code}${trailing}})();${sourceUrlComment}${close}`;
      } else {
        return `${cleanOpen}(function() {${leading}${code}${trailing}})();${close}`;
      }
    },
  );
  return component;
};

// JavaScript minification is exported from js-minifier.ts.


