import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getComponentCss, extractInlineStyles, resolveCssImports } from "./styles.ts";
import { getComponentScripts } from "./javascript.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { minifyHtml } from "./html-minifier.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

// Warn if a component name shadows a native HTML element
export const NATIVE_HTML_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
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
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
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
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "small",
  "slot",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
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
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

let componentListCache: ComponentList | null = null;

export const invalidateComponentListCache = () => {
  componentListCache = null;
};

/** Load all component HTML and CSS files from the configured components directory. */
const BARE_TOKEN_SPEC = String.raw`[^\s"'=<>\`]+`;
const ATTR_VALUE_SPEC = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN_SPEC})`;
const ATTR_SPEC = String.raw`${BARE_TOKEN_SPEC}(?:\s*=\s*${ATTR_VALUE_SPEC})?`;
const BUILD_FLAG_SPEC = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE_SPEC})?`;

const COMPONENT_BUILD_SCRIPT_RE = new RegExp(
  `<script\\b(?:\\s+${ATTR_SPEC})*\\s+${BUILD_FLAG_SPEC}(?:\\s+${ATTR_SPEC})*\\s*>([\\s\\S]*?)<\\/script>`,
  "gi",
);

export const isPageAwareBuildScript = (
  openTag: string,
  scriptContent: string,
): boolean => {
  if (/\bdata-bascik-page-aware\b/i.test(openTag)) return true;
  if (/\bdata-bascik-build\s*=\s*["']?page["']?/i.test(openTag)) return true;
  if (/\bprocess\.env\.(BASCIK_PAGE_PATH|BASCIK_PAGE_FILE|BASCIK_ROUTE)\b/.test(scriptContent)) {
    return true;
  }
  return false;
};

export const listComponents = async (): Promise<ComponentList> => {
  if (componentListCache) return componentListCache;
  const componentFileNames =
    (await deepReadDirFlat(
      BascikConfig.directory.components,
      /\.(html|css|js|ts|mjs)$/,
    )) ?? [];
  const componentHtmlFileNames = (componentFileNames as string[]).filter(
    (fileName) => fileName.match(/\.html$/) && !fileName.match(/\.(test|spec)\.html$/),
  );
  const componentCssFileNames = (componentFileNames as string[]).filter(
    (fileName) => fileName.match(/\.css$/) && !fileName.match(/\.(test|spec)\.css$/),
  );
  const componentScriptFileNames = (componentFileNames as string[]).filter(
    (fileName) => fileName.match(/\.(js|ts|mjs)$/) && !fileName.match(/\.(test|spec)\.(js|ts|mjs)$/),
  );
  const components = await Promise.all(
    componentHtmlFileNames.map(async (fileName) => {
      // Name the file name without the extension.
      // Name is used in all the mappings components
      const componentName = fileName.replace(/^.*[\\/]/, "").split(".")[0].toLowerCase();
      if (NATIVE_HTML_ELEMENTS.has(componentName)) {
        console.warn(
          `warning: Component "${componentName}" has the same name as a native HTML element. ` +
          `This may cause unexpected behavior — consider a hyphenated name like "my-${componentName}".`,
        );
      } else if (!componentName.includes("-")) {
        console.warn(
          `warning: Component "${componentName}" is not hyphenated. ` +
          `Under WHATWG HTML §4.13, custom elements should include a hyphen (e.g. "my-${componentName}") to avoid collisions with future HTML standards.`,
        );
      }
      let fileContentBuffer: Buffer;
      let cssFileContent: string | undefined;
      let companionScripts: Awaited<ReturnType<typeof getComponentScripts>> | undefined;
      try {
        [fileContentBuffer, cssFileContent, companionScripts] = await Promise.all([
          readFile(fileName),
          getComponentCss(fileName, componentCssFileNames),
          getComponentScripts(fileName, componentScriptFileNames),
        ]);
      } catch (e) {
        console.warn("warning: Failed to process %s", fileName, e);
        return {};
      }

      const rawContent = fileContentBuffer.toString();
      // Run build scripts before minification so that generated content
      // stays in its original position (minifyHtml moves <script> tags).
      // Page-aware component build scripts are deferred to page transpilation time.
      const buildMatches = [...rawContent.matchAll(COMPONENT_BUILD_SCRIPT_RE)];
      let resolvedContent = rawContent;

      if (buildMatches.length > 0) {
        const deferredPlaceholders: Array<{ placeholder: string; tag: string }> = [];
        let hasStaticScripts = false;
        let withPlaceholders = rawContent;

        for (let i = buildMatches.length - 1; i >= 0; i--) {
          const match = buildMatches[i];
          const [fullTag, scriptContent] = match;
          const index = match.index ?? 0;
          const openTag = fullTag.slice(0, fullTag.length - scriptContent.length - "</script>".length);

          if (isPageAwareBuildScript(openTag, scriptContent)) {
            const placeholder = `<!--__BASCIK_DEFERRED_BUILD_SCRIPT_${i}__-->`;
            deferredPlaceholders.push({ placeholder, tag: fullTag });
            withPlaceholders =
              withPlaceholders.slice(0, index) +
              placeholder +
              withPlaceholders.slice(index + fullTag.length);
          } else {
            hasStaticScripts = true;
          }
        }

        if (hasStaticScripts) {
          resolvedContent = await executeBuildScripts(withPlaceholders, fileName);
          for (const { placeholder, tag } of deferredPlaceholders) {
            resolvedContent = resolvedContent.replace(placeholder, () => tag);
          }
        }
      }

      if (companionScripts && companionScripts.scriptMap.size > 0) {
        resolvedContent = resolvedContent.replace(
          /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
          (match, preSrc, srcVal, postSrc) => {
            const baseSrc = basename(srcVal);
            const scriptInfo = companionScripts!.scriptMap.get(baseSrc) ?? companionScripts!.scriptMap.get(srcVal);
            if (scriptInfo) {
              const otherAttrs = `${preSrc}${postSrc}`.replace(/\s+/g, " ").trim();
              const attrStr = otherAttrs ? ` ${otherAttrs}` : "";
              return `<script${attrStr} data-bascik-source="${scriptInfo.relPath}">\n${scriptInfo.code}\n</script>`;
            }
            return match;
          },
        );
      }
      const { html: cleanedContent, css: inlineCss } = extractInlineStyles(resolvedContent);
      const resolvedInlineCss = inlineCss ? await resolveCssImports(inlineCss, fileName) : "";
      const combinedCss = [cssFileContent, resolvedInlineCss].filter(Boolean).join("\n");
      let minifiedContent: string;
      try {
        minifiedContent = minifyHtml(cleanedContent);
      } catch (minErr) {
        const behavior = BascikConfig.onMinifyError ?? "error";
        if (behavior === "error") {
          console.error(`[bascik] HTML minification failed for component "${fileName}":`, minErr);
          throw minErr;
        }
        console.warn(`[bascik] HTML minification failed for component "${fileName}", proceeding unminified:`, minErr);
        minifiedContent = cleanedContent;
      }
      const component: BascikComponent = {
        name: componentName,
        fileName,
        fileContent: minifiedContent,
      };
      if (combinedCss) {
        component.cssFileContent = combinedCss;
      }
      return component;
    }),
  );
  componentListCache = (components as BascikComponent[]).reduce(
    (acc: ComponentList, { name, ...rest }) => {
      if (!name) return acc;
      acc[name] = rest as Omit<BascikComponent, "name">;
      return acc;
    },
    {} as ComponentList,
  );
  return componentListCache;
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML tag manipulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches a run of attribute text inside an opening tag, stopping at the
 * first unquoted `>`.  The alternation is unambiguous: a character is either
 * a quote (starting a quoted value) or a non-quote, non-`>` character, so the
 * regex engine never has to explore overlapping parses.  The previous form,
 * `(?:"[^"]*"|'[^']*'|[^>])*`, let `[^>]` also match quote characters, which
 * made the parser ambiguous and caused catastrophic (exponential) backtracking
 * whenever the surrounding pattern could not match — e.g. a `data-bascik-prop-*`
 * marker with no balancing close tag would hang the build.
 */
const ATTR_VALUE = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/**
 * Return a same-length copy of `htmlString` where HTML comments and the inner content of
 * `<script>`, `<style>`, and `<textarea>` elements are blanked out with
 * spaces. Component-tag searches run against the masked string so literal
 * tag text inside comments or raw-text elements (e.g. `<my-card>` or `<body>`
 * mentioned in a comment, JSON-LD string, or code example) is never resolved
 * as a component or structural tag.
 * Because lengths are preserved, indices found in the masked string are
 * valid in the original.
 */
export const maskRawTextContent = (htmlString: string): string => {
  const hasComments = htmlString.includes("<!--");
  const hasRawTags = /<(?:script|style|textarea)\b/i.test(htmlString);
  if (!hasComments && !hasRawTags) {
    return htmlString;
  }
  let masked = htmlString;
  if (hasComments) {
    masked = masked.replace(/<!--[\s\S]*?-->/g, (m) =>
      m.length >= 7 ? `<!--${" ".repeat(m.length - 7)}-->` : m,
    );
  }
  if (hasRawTags) {
    masked = masked.replace(
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      new RegExp(
        `(<(script|style|textarea)(?:${ATTR_VALUE})>)([\\s\\S]*?)(<\\/\\2\\s*>)`,
        "gi",
      ),
      (_m, open: string, _tag: string, content: string, close: string) =>
        `${open}${" ".repeat(content.length)}${close}`,
    );
  }
  return masked;
};

/**
 * Find the first `<tagName ...>` opening tag in `htmlString` and return its
 * full text plus start/end indices.  The attribute scan is quote-aware so a
 * `>` inside a quoted attribute value does not end the tag early.
 * Occurrences inside `<script>`, `<style>`, and `<textarea>` content are
 * ignored — they are text, not markup.
 */
const findOpenTag = (
  htmlString: string,
  tagName: string,
  masked?: string,
): { openTag: string; start: number; end: number } | null => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return null;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRegexp = new RegExp(`<${tn}(?![\w-])(?:${ATTR_VALUE})>`, "i");
  const openTagMatch = openTagRegexp.exec(masked ?? maskRawTextContent(htmlString));
  if (!openTagMatch) return null;
  return {
    openTag: openTagMatch[0],
    start: openTagMatch.index,
    end: openTagMatch.index + openTagMatch[0].length,
  };
};

export const replaceTag = (
  htmlString: string,
  tagName: string,
  transpiledTag: string,
  masked?: string,
): string => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return htmlString;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags first: <tagName ...>...</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml = masked ?? maskRawTextContent(htmlString);
  const openTag = findOpenTag(htmlString, tagName, maskedHtml);
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex = findMatchingClose(htmlString, tagName, openTag.end, maskedHtml);
    if (closeIndex !== -1) {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeTagRegexp = new RegExp(`^<\\/${tn}\\s*>`, "i");
      const closeTagMatch = closeTagRegexp.exec(htmlString.slice(closeIndex));
      if (closeTagMatch) {
        // Splice by index so that `$` characters in transpiledTag (e.g.
        // SQL positional parameters like $1, $2 in slot content) are never
        // interpreted as back-references, which would cause infinite
        // expansion loops.
        const endIndex = closeIndex + closeTagMatch[0].length;
        return (
          htmlString.slice(0, openTag.start) +
          transpiledTag +
          htmlString.slice(endIndex)
        );
      }
    }
  }
  // Fall back to self-closing: <tagName ... /> or <tagName/>
  // Use a replacement function for the same `$`-safety reason.
  // Search the masked string so a literal tag inside <script>/<style>/<textarea>
  // content is never replaced; splice by index into the original string.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const selfClosingRegexp = new RegExp(`<${tn}(?:${ATTR_VALUE})\\s*\\/?>`, "i");
  const selfClosingMatch = selfClosingRegexp.exec(maskedHtml);
  if (!selfClosingMatch) return htmlString;
  return (
    htmlString.slice(0, selfClosingMatch.index) +
    transpiledTag +
    htmlString.slice(selfClosingMatch.index + selfClosingMatch[0].length)
  );
};

export const getTagContents = (
  htmlString: string,
  tagName: string,
): { content?: string; innerContent?: string } => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return {};
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const regexp = new RegExp(
    `(?<content><${tn}[^>]*>(?<innerContent>([\\s\\S]*?))<\\/${tn}>)`,
    "i",
  );
  const match = htmlString.match(regexp);
  if (!match) return {};
  // { content, innerContent }
  return { ...match.groups };
};

const componentRegexCache = new WeakMap<ComponentList, { namesKey: string; regex: RegExp | null }>();

export const getFirstComponent = (
  htmlString: string,
  componentList: ComponentList,
  masked?: string,
): Partial<BascikComponent> & { index?: number } => {
  if (!htmlString) return {};

  const componentNames = Object.keys(componentList)
    .filter((name) => /^[a-zA-Z][\w:-]*$/.test(name))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const namesKey = componentNames.join("\0");
  let cached = componentRegexCache.get(componentList);
  if (!cached || cached.namesKey !== namesKey) {
    // Super important here, reverse, makes it so we're matching on the most specific tag first
    // Meaning, it will find test-comp-clone before test-comp,
    // because reverse, the longer tag will be first in the regexp, and therefore match first.
    // It's like how an ingress controller works.
    const escapedComponentNames = componentNames
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = escapedComponentNames.length === 0
      ? null
      : new RegExp(`<(${escapedComponentNames.join("|")})(?![\\w-])[\\s\\S]*?>`, "i");
    cached = { namesKey, regex };
    componentRegexCache.set(componentList, cached);
  }

  const matchComponentName = cached.regex;
  if (!matchComponentName) return {};

  // Match against the masked string so literal component-tag text inside
  // <script>/<style>/<textarea> content (e.g. JSON-LD strings) is ignored.
  const maskedHtml = masked ?? maskRawTextContent(htmlString);
  const match = maskedHtml.match(matchComponentName);
  if (!match) {
    return {};
  }
  const firstComponentName = match[1].toLowerCase();
  return {
    name: firstComponentName,
    index: match.index,
    ...getTag(htmlString, firstComponentName, componentList, maskedHtml),
  };
};

export const getTag = (
  htmlString: string,
  tagName: string,
  componentList?: ComponentList,
  masked?: string,
): Partial<BascikComponent> => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return {};
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags: <tagName ...>content</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml = masked ?? maskRawTextContent(htmlString);
  const openTag = findOpenTag(htmlString, tagName, maskedHtml);
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex = findMatchingClose(htmlString, tagName, openTag.end, maskedHtml);
    if (closeIndex !== -1) {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeTagRegexp = new RegExp(`^<\\/${tn}\\s*>`, "i");
      const closeTagMatch = closeTagRegexp.exec(htmlString.slice(closeIndex));
      if (closeTagMatch) {
        const returnObj = {
          content: htmlString.slice(
            openTag.start,
            closeIndex + closeTagMatch[0].length,
          ),
          innerContent: htmlString.slice(openTag.end, closeIndex),
        };
        if (!componentList) return returnObj;
        return { ...returnObj, ...componentList[tagName.toLowerCase()] };
      }
    }
  }

  // Try self-closing: <tagName ... /> or <tagName/>
  // Search the masked string so literal tag text inside raw-text elements is skipped.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const selfClosingPattern = new RegExp(
      `<${tn}(?![\\w-])([\\s\\S]*?)\\/?>`,
      "i",
    );
  const selfClosingMatch = selfClosingPattern.exec(maskedHtml);
  if (selfClosingMatch) {
    const returnObj = {
      content: htmlString.slice(
        selfClosingMatch.index,
        selfClosingMatch.index + selfClosingMatch[0].length,
      ),
      innerContent: "",
    };
    if (!componentList) return returnObj;
    return { ...returnObj, ...componentList[tagName.toLowerCase()] };
  }

  return {};
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML minification
// ─────────────────────────────────────────────────────────────────────────────

export { minifyHtml, extractScriptTags } from "./html-minifier.ts";

// ─── Props ────────────────────────────────────────────────────────────────────

const decodePropEntities = (value: string): string => value.replace(
  /&(amp|lt|gt|quot|#39|#x27);/gi,
  (_match, entity: string) => ({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    "#x27": "'",
  })[entity.toLowerCase()] ?? _match,
);

const escapePropValue = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

/**
 * Extract data-bascik-prop-* attributes from a component usage tag string.
 * e.g. '<my-comp data-bascik-prop-title="Hello">' → { title: "Hello" }
 */
export const extractProps = (
  componentContent: string | undefined,
): Record<string, string> => {
  const props: Record<string, string> = {};
  if (!componentContent) return props;
  const openingTag = componentContent.match(
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    new RegExp(`^<[a-zA-Z][\\w:-]*(?:${ATTR_VALUE})>`, "i"),
  )?.[0];
  if (!openingTag) return props;
  // Accept both double-quoted and single-quoted prop values,
  // e.g. data-bascik-prop-title="Hi" or data-bascik-prop-title='Hi'.
  const regexp = /data-bascik-prop-([\w-]+)=("[^"]*"|'[^']*')/gi;
  let match;
  while ((match = regexp.exec(openingTag)) !== null) {
    const followingCharacter = openingTag[match.index + match[0].length];
    if (followingCharacter && !/[\s/>]/.test(followingCharacter)) {
      console.warn(
        `Ignoring malformed data-bascik-prop-${match[1]}: the value contains an unescaped delimiting quote. Use &quot; or &#39; for quotes inside prop values.`,
      );
      continue;
    }
    props[match[1]] = decodePropEntities(match[2].slice(1, -1));
  }
  return props;
};

// ─────────────────────────────────────────────────────────────────────────────
// Prop injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each prop, find elements in the component template that carry a
 * `data-bascik-prop-{name}` attribute, replace their inner content with the
 * prop value, and strip the marker attribute.
 *
 * e.g. template `<p data-bascik-prop-title></p>` + { title: "Hi" }
 *      → `<p>Hi</p>`
 */
export const injectProps = (
  fileContent: string | undefined,
  props: Record<string, string>,
): string => {
  if (!fileContent) return "";
  let result = fileContent;
  Object.entries(props).forEach(([propName, propValue]) => {
    if (!result.includes(propName)) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(propName)) return;
    const attrName = `data-bascik-prop-${propName}`;
    const escapedPropValue = escapePropValue(propValue);
    // Match: <tagName [attrsBefore] data-bascik-prop-name[=value] [attrsAfter]>...</tagName>
    // The attr scans are quote-aware so a `>` inside a quoted attribute value
    // (e.g. title="a > b") does not end the opening tag early.
    result = result.replace(
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      new RegExp(
        `<(\\w+(?:-\\w+)*?)(${ATTR_VALUE}?)\\s+${attrName}(?:=("[^"]*"|'[^']*'))?(${ATTR_VALUE})>([\\s\\S]*?)<\\/\\1>`,
        "gi",
      ),
      (
        match: string,
        tagName: string,
        attrsBefore: string,
        markerValue: string | undefined,
        attrsAfter: string,
        _oldContent: string,
      ) => markerValue
        ? match
        : `<${tagName}${attrsBefore}${attrsAfter}>${escapedPropValue}</${tagName}>`,
    );
  });
  // Strip any remaining data-bascik-prop-* markers whose prop was not provided.
  // Only strip markers that have NO value (prop receivers, e.g. `data-bascik-prop-label`
  // followed immediately by `>` or whitespace). Markers with a value
  // (e.g. `data-bascik-prop-label="featured"`) are child component prop declarations
  // and must be preserved so nested components receive their props.
  return result.replace(/\s+data-bascik-prop-[\w-]+(?=[>\s])/gi, "");
};

// ─── Named Slots ──────────────────────────────────────────────────────────────

/**
 * Find the index of the closing `</tagName>` that properly balances with the
 * opening tag whose content starts at `contentStart`.  Uses a simple depth
 * counter so nested elements of the same tag type are handled correctly.
 *
 * Returns the index of `</tagName>` in `html`, or -1 if not found.
 */
const findMatchingClose = (
  html: string,
  tagName: string,
  contentStart: number,
  masked?: string,
): number => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return -1;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openRe = new RegExp(`<${tn}[\\s>]`, "gi");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const closeRe = new RegExp(`<\\/${tn}>`, "gi");
  // Scan the masked string so literal tag text inside <script>/<style>/<textarea>
  // content never skews the depth counter. Indices are valid in the original.
  const maskedHtml = masked ?? maskRawTextContent(html);
  let depth = 1;
  let pos = contentStart;
  while (pos < maskedHtml.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(maskedHtml);
    const closeMatch = closeRe.exec(maskedHtml);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.index) {
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    } else {
      depth++;
      pos = openMatch.index + openMatch[0].length;
    }
  }
  return -1;
};

/**
 * Parse all `data-bascik-slot="name"` wrapper elements from `innerContent`,
 * returning an array of `{ slotName, startIndex, endIndex, content }` objects
 * where `startIndex`/`endIndex` delimit the entire wrapper element (including
 * its opening and closing tags) in the original string.
 *
 * Uses a stack-based depth counter so nested same-tag elements are handled
 * correctly — e.g. a `<div data-bascik-slot="x"><div>…</div></div>` wrapper
 * that contains inner `<div>` elements will be correctly closed at the outer
 * `</div>`, not the first inner one.
 */
const parseNamedSlots = (
  innerContent: string,
): Array<{ slotName: string; startIndex: number; endIndex: number; content: string }> => {
  if (!innerContent.includes("data-bascik-slot")) return [];
  const results: Array<{ slotName: string; startIndex: number; endIndex: number; content: string }> = [];
  // Quote-aware attribute scan (ATTR_VALUE) so the marker may appear after
  // other attributes, and `data-bascik-slot` inside a quoted attribute value
  // never false-positives.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot="([^"]+)"(?:${ATTR_VALUE})>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(innerContent)) !== null) {
    const [fullOpen, tagName, slotName] = match;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(innerContent, tagName, contentStart);
    if (closeIndex === -1) continue;
    const closeTag = `</${tagName}>`;
    const endIndex = closeIndex + closeTag.length;
    results.push({
      slotName,
      startIndex: match.index,
      endIndex,
      content: innerContent.slice(contentStart, closeIndex),
    });
    // Advance past the entire wrapper element so we don't re-process it
    openTagRe.lastIndex = endIndex;
  }
  return results;
};

/**
 * Strip `data-bascik-slot="name"` wrapper elements from inner content,
 * leaving only the content intended for the default slot.
 *
 * e.g. '<p>body</p><div data-bascik-slot="side"><nav>nav</nav></div>'
 *      → '<p>body</p>'
 */
export const extractDefaultSlotContent = (
  innerContent: string | undefined,
): string => {
  if (!innerContent) return "";
  const named = parseNamedSlots(innerContent);
  if (named.length === 0) return innerContent.trim();
  // Remove each named-slot wrapper from right-to-left to preserve indices
  let result = innerContent;
  for (let i = named.length - 1; i >= 0; i--) {
    const { startIndex, endIndex } = named[i];
    result = result.slice(0, startIndex) + result.slice(endIndex);
  }
  return result.trim();
};

/**
 * Extract named slot content from a component usage's inner HTML.
 * Looks for wrapper elements carrying `data-bascik-slot="slotName"`.
 *
 * e.g. '<div data-bascik-slot="header"><h1>H</h1></div>'
 *      → { header: "<h1>H</h1>" }
 */
export const extractNamedSlotContent = (
  innerContent: string | undefined,
): Record<string, string> => {
  if (!innerContent) return {};
  const slots: Record<string, string> = {};
  for (const { slotName, content } of parseNamedSlots(innerContent)) {
    slots[slotName] = content;
  }
  return slots;
};

/**
 * In a component template, replace `data-bascik-slot="name"` placeholder
 * elements with the corresponding named slot content.  Placeholders with no
 * matching content are removed entirely.
 *
 * e.g. template `<footer><div data-bascik-slot="links"></div></footer>`
 *      slots   `{ links: "<a href='/'>Home</a>" }`
 *      → `<footer><a href='/'>Home</a></footer>`
 */
export const replaceNamedSlots = (
  fileContent: string,
  slots: Record<string, string>,
): string => {
  // Scan wrappers with the same depth-aware parser used for extraction so
  // nested same-tag elements inside a placeholder's fallback content are
  // handled correctly, then replace right-to-left to preserve indices.
  const wrappers = parseNamedSlots(fileContent);
  let result = fileContent;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const { slotName, startIndex, endIndex, content } = wrappers[i];
    // Use the element's own inner content as fallback when the slot is not provided
    const replacement = slotName in slots ? slots[slotName] : content;
    result = result.slice(0, startIndex) + replacement + result.slice(endIndex);
  }
  return result;
};

/**
 * In a component template, replace valueless `data-bascik-slot` default slot
 * marker elements with `defaultSlotContent`.  When no content is provided the
 * marker element's own inner content is kept as fallback.
 *
 * Depth-aware: nested same-tag elements inside the marker's fallback content
 * are balanced correctly, and other attributes may precede the marker.
 */
export const replaceDefaultSlots = (
  fileContent: string,
  defaultSlotContent: string,
): string => {
  if (!fileContent.includes("data-bascik-slot")) return fileContent;
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot(?!\\s*=)(?:${ATTR_VALUE})>`,
    "gi",
  );
  const wrappers: Array<{ startIndex: number; endIndex: number; content: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(fileContent)) !== null) {
    const [fullOpen, tagName] = match;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(fileContent, tagName, contentStart);
    if (closeIndex === -1) continue;
    const endIndex = closeIndex + `</${tagName}>`.length;
    wrappers.push({
      startIndex: match.index,
      endIndex,
      content: fileContent.slice(contentStart, closeIndex),
    });
    openTagRe.lastIndex = endIndex;
  }
  let result = fileContent;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const { startIndex, endIndex, content } = wrappers[i];
    const replacement = defaultSlotContent || content;
    result = result.slice(0, startIndex) + replacement + result.slice(endIndex);
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Attribute inheritance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract attributes from a component usage tag that should be inherited by
 * the component's root element.  All data-bascik-* attributes are excluded.
 *
 * e.g. '<my-nav class="sticky" aria-label="nav" data-bascik-prop-x="y">'
 *      → { class: "sticky", "aria-label": "nav" }
 */
export const extractInheritableAttributes = (
  componentContent: string | undefined,
): Record<string, string> => {
  if (!componentContent) return {};
  const attrs: Record<string, string> = {};
  // Grab just the opening tag text (up to the first > or />).
  // The attribute scan is quote-aware so a `>` inside a quoted attribute value
  // (e.g. title="a > b") does not end the opening tag early.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagMatch = componentContent.match(
    new RegExp(`^<[\\w-]+(${ATTR_VALUE})(?:\\s*\\/?>)`),
  );
  if (!openTagMatch || !openTagMatch[1]) return attrs;
  const attrStr = openTagMatch[1];
  // Accept both double-quoted and single-quoted attribute values.
  const attrRegex = /\s+([\w:-]+)(?:=("[^"]*"|'[^']*'))?/g;
  let match;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    const [, name, rawValue] = match;
    const value = rawValue === undefined ? "" : rawValue.slice(1, -1);
    if (!name.startsWith("data-bascik-")) {
      attrs[name] = value;
    }
  }
  return attrs;
};

/**
 * Merge inheritable attributes onto the first (root) element of transpiled HTML.
 *  - class: appended to existing classes, or added if absent.
 *  - Other attributes: added only if the root element does not already have them.
 */
export const mergeAttributesOntoRoot = (
  html: string,
  attrs: Record<string, string>,
): string => {
  if (!Object.keys(attrs).length) return html;
  return html.replace(
    /^((?:\s*(?:<!--[\s\S]*?-->|<(?:script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/(?:script|style)\s*>))*\s*)(<[a-zA-Z][\w-]*)((?:\s[^>]*?)?)(\s*\/?>)/i,
    (_match: string, leading: string, tagName: string, existing: string, close: string) => {
      let attrStr = existing || "";
      const existingNames = new Set<string>();
      const attrRegex = /\s+([\w:-]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g;
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(attrStr)) !== null) {
        existingNames.add(match[1].toLowerCase());
      }

      for (const [name, value] of Object.entries(attrs)) {
        if (name === "class" && value) {
          if (/class="/.test(attrStr)) {
            attrStr = attrStr.replace(
              /class="([^"]*)"/,
              (_, cls) => `class="${cls} ${value}"`,
            );
          } else if (/class='/.test(attrStr)) {
            attrStr = attrStr.replace(
              /class='([^']*)'/,
              (_, cls) => `class='${cls} ${value}'`,
            );
          } else {
            attrStr += ` class="${value}"`;
          }
        } else if (value !== undefined && !existingNames.has(name.toLowerCase())) {
          attrStr += ` ${name}="${value}"`;
        }
      }
      return `${leading}${tagName}${attrStr}${close}`;
    },
  );
};
