import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import {
  getComponentCss,
  extractInlineStyles,
  resolveCssImports,
} from "./styles.ts";
import { getComponentScripts } from "./javascript.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { minifyHtml } from "./html-minifier.ts";
import {
  createContentShield,
  maskElementContents,
  shieldElementContents,
} from "./shielding.ts";
import {
  transformTypeScriptScriptTags,
  TypeScriptTransformError,
  hasStaticModuleSyntax,
} from "./typescript.ts";
import { getScriptType } from "./script-types.ts";
import { stampScriptLines, withScriptLine } from "./script-source-lines.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import {
  SCRIPT_END_TAG,
  scriptOpenTag,
  BUILD_ATTR_NAME,
  ROUTES_ATTR_NAME,
  SERVER_ATTR_NAME,
  STREAM_ATTR_NAME,
  isPageAwareBuildOpenTag,
} from "./html-patterns.ts";
import { findCompatibilityMatches } from "./compatibility-checker.ts";
import { stderr as colorErr } from "./colors.ts";
import {
  PLAUSIBLE_TAG_NAME,
  PRESERVE_WILDCARD_PATTERN,
} from "./config-validation.ts";
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

/** Load all component HTML and CSS files from the configured components directory. */
const BARE_TOKEN_SPEC = String.raw`[^\s"'=<>\`]+`;
const ATTR_VALUE_SPEC = String.raw`(?:"[^"]*"|'[^']*'|${BARE_TOKEN_SPEC})`;
const ATTR_SPEC = String.raw`${BARE_TOKEN_SPEC}(?:\s*=\s*${ATTR_VALUE_SPEC})?`;
const BUILD_FLAG_SPEC = String.raw`data-bascik-build(?:\s*=\s*${ATTR_VALUE_SPEC})?`;

const COMPONENT_BUILD_SCRIPT_RE = new RegExp(
  `<script\\b(?:\\s+${ATTR_SPEC})*\\s+${BUILD_FLAG_SPEC}(?:\\s+${ATTR_SPEC})*\\s*>([\\s\\S]*?)${SCRIPT_END_TAG}`,
  "gi",
);

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)${BUILD_ATTR_NAME}`,
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
      rawCss = await readFile(cssFileName, "utf8");
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
  componentCompatFingerprints.set(fileName, fingerprint);

  const relHtml =
    relative(process.cwd(), fileName).replace(/\\/g, "/") || fileName;
  const noComments = rawHtml.replace(/<!--[\s\S]*?-->/g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ";
  });
  const nonCodeScan = maskElementContents(noComments, [
    "textarea",
    ...(BascikConfig.scoping?.preserve ?? ["code"])
      .map((t) => String(t))
      .filter(
        (t) => PLAUSIBLE_TAG_NAME.test(t) || PRESERVE_WILDCARD_PATTERN.test(t),
      ),
  ]);

  const seenWarnings = new Set<string>();
  const emitWarning = (
    displayPath: string,
    line: number,
    ruleId: string,
    message: string,
    suggestion: string,
  ) => {
    const key = `${displayPath}:${line}:${ruleId}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    console.warn(
      `${colorErr.tag("warn", "[bascik] warning")} ${colorErr.dim(`(${ruleId})`)} in ${colorErr.cyan(`${displayPath}:${line}`)}: ${message} ${colorErr.dim(suggestion)}`,
    );
  };

  const styleBlockRegex =
    /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style(?:[\t\n\f\r /][^>]*)?>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleBlockRegex.exec(nonCodeScan)) !== null) {
    const styleBody = styleMatch[2] ?? "";
    const styleOffset = styleMatch.index + styleMatch[1].length;
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

  const scriptBlockRegex =
    /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptBlockRegex.exec(nonCodeScan)) !== null) {
    const openTag = scriptMatch[1];
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
      const scriptBody = scriptMatch[2] ?? "";
      const scriptOffset = scriptMatch.index + openTag.length;
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
};

export const isPageAwareBuildScript = (
  openTag: string,
  scriptContent: string,
): boolean => {
  if (isPageAwareBuildOpenTag(openTag)) return true;
  if (
    /\bprocess\.env\.(BASCIK_PAGE_PATH|BASCIK_PAGE_FILE|BASCIK_ROUTE)\b/.test(
      scriptContent,
    )
  ) {
    return true;
  }
  return false;
};

/**
 * Derives the component tag name from a file path.
 * Lowercases the base name without the file extension.
 */
export const deriveComponentName = (fileName: string): string => {
  return fileName
    .replace(/^.*[\\/]/, "")
    .split(".")[0]
    .toLowerCase();
};

const COMPONENT_FILE_RE = /\.(html|css|js|ts|mjs)$/;
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
      fileName.match(/\.(js|ts|mjs)$/) &&
      !fileName.match(/\.(test|spec)\.(js|ts|mjs)$/),
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
        [fileContentBuffer, cssFileContent, companionScripts] =
          await Promise.all([
            readFile(fileName),
            getComponentCss(
              fileName,
              componentCssFileNames,
              importedStylesheets,
            ),
            getComponentScripts(fileName, componentScriptFileNames),
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

      const rawContent = fileContentBuffer.toString();
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
      // Run build scripts before minification so that generated content
      // stays in its original position (minifyHtml moves <script> tags).
      // Page-aware component build scripts are deferred to page transpilation time.
      const buildMatches = [
        ...stampedContent.matchAll(COMPONENT_BUILD_SCRIPT_RE),
      ];
      let resolvedContent = stampedContent;

      if (buildMatches.length > 0) {
        const deferredPlaceholders: Array<{
          placeholder: string;
          tag: string;
        }> = [];
        let hasStaticScripts = false;
        let withPlaceholders = stampedContent;

        for (let i = buildMatches.length - 1; i >= 0; i--) {
          const match = buildMatches[i];
          const [fullTag, scriptContent] = match;
          const index = match.index ?? 0;
          const openTag = scriptOpenTag(fullTag, scriptContent);

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
          resolvedContent = await executeBuildScripts(
            withPlaceholders,
            fileName,
          );
          for (const { placeholder, tag } of deferredPlaceholders) {
            resolvedContent = resolvedContent.replace(placeholder, () => tag);
          }
        }
      }

      if (companionScripts && companionScripts.scriptMap.size > 0) {
        resolvedContent = resolvedContent.replace(
          // Quote-aware attributes around a whole-name `src` (never `data-src`).
          // The body is matched too: browsers ignore inline content when `src`
          // is set, so a body never stops the companion from being inlined.
          /<script\b((?:[^>"']|"[^"]*"|'[^']*')*?)\ssrc=["']([^"']+)["']((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi,
          (match, preSrc, srcVal, postSrc, ignoredBody: string) => {
            const baseSrc = basename(srcVal);
            const scriptInfo =
              companionScripts!.scriptMap.get(baseSrc) ??
              companionScripts!.scriptMap.get(srcVal);
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
  const builtList = (components as BascikComponent[]).reduce(
    (acc: ComponentList, { name, ...rest }) => {
      if (!name) return acc;
      acc[name] = rest as Omit<BascikComponent, "name">;
      return acc;
    },
    {} as ComponentList,
  );
  if (isDefaultRoots) {
    componentListCache = builtList;
  }
  return builtList;
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
 * One attribute of a start tag: the name with its span, plus the value with
 * the raw (still entity-encoded, quote chars included when quoted) text.
 * `valueStart`/`valueEnd` are -1 when the attribute has no value. Span
 * coordinates are relative to the scanned tag string.
 */
interface ScannedAttribute {
  /** Authored attribute name, case preserved. */
  name: string;
  nameStart: number;
  nameEnd: number;
  /** -1 when the attribute has no value (`disabled`, `data-bascik-slot`). */
  valueStart: number;
  valueEnd: number;
  /** The whole `name=value` span, from name start to value end. */
  start: number;
  end: number;
}

/**
 * Scan the attributes of one opening tag string (the text between `<` and
 * `>`).  Following the WHATWG tokenizer states, a quote delimits a value only
 * after `=`, so a token that merely looks like an attribute inside another
 * attribute's quoted value (e.g. `data-bascik-prop-x` inside `title=...`) is
 * never reported as an attribute.  Returns the attributes in document order.
 */
const scanWholeAttributes = (openTag: string): ScannedAttribute[] => {
  const attrs: ScannedAttribute[] = [];
  // Skip the `<` and the tag name: the first attribute can start anywhere
  // after the name (whitespace or directly, as in `<div/disabled>`).
  let i = 0;
  const n = openTag.length;
  if (n > 0 && openTag.charCodeAt(0) === 60 /* < */) i = 1;
  while (i < n && !/[\s/>]/.test(openTag[i])) i++;
  while (i < n) {
    while (i < n && /[\s/]/.test(openTag[i])) i++;
    if (i >= n || openTag[i] === ">") break;
    const nameStart = i;
    while (i < n && !/[\s=/>]/.test(openTag[i])) i++;
    const nameEnd = i;
    let valueStart = -1;
    let valueEnd = -1;
    let attrEnd = nameEnd;
    while (i < n && /[\s]/.test(openTag[i])) i++;
    if (i < n && openTag[i] === "=") {
      i++;
      while (i < n && /[\s]/.test(openTag[i])) i++;
      if (i < n && (openTag[i] === '"' || openTag[i] === "'")) {
        const quote = openTag[i];
        i++;
        valueStart = i;
        while (i < n && openTag[i] !== quote) i++;
        valueEnd = i;
        if (i < n) i++; // past the closing quote
      } else {
        // Unquoted value: characters other than whitespace, quotes, `=`, `<`,
        // `>`, and backtick. `/` is allowed (e.g. `path=/about`).
        valueStart = i;
        while (i < n && !/[\s"'=<>`]/.test(openTag[i])) i++;
        valueEnd = i;
      }
      attrEnd = i;
    }
    attrs.push({
      name: openTag.slice(nameStart, nameEnd),
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
      start: nameStart,
      end: attrEnd,
    });
  }
  return attrs;
};

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
    masked = maskElementContents(masked, ["script", "style", "textarea"]);
  }
  return masked;
};

// The passes maskRawTextContent runs, in order, each with the opener text a
// scan could start a match at. Mirrors maskElementContents for the raw tags.
const MASK_PASSES: Array<{
  match: RegExp;
  opener: RegExp;
  blank: (
    match: string,
    open?: string,
    inner?: string,
    close?: string,
  ) => string;
}> = [
  {
    match: /<!--[\s\S]*?-->/g,
    opener: /<!--/g,
    blank: (match) =>
      match.length >= 7 ? `<!--${" ".repeat(match.length - 7)}-->` : match,
  },
  ...["script", "style", "textarea"].map((tag) => ({
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    match: new RegExp(
      `(<${tag}(?:\\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)([\\s\\S]*?)(<\\/${tag}\\s*>)`,
      "gi",
    ),
    // `\b` after the name passes for any following character outside [A-Za-z0-9_].
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    opener: new RegExp(`<${tag}(?![A-Za-z0-9_])`, "gi"),
    blank: (_match: string, open?: string, inner?: string, close?: string) =>
      `${open}${" ".repeat(inner!.length)}${close}`,
  })),
];

// The end of a segment is unsafe when it could be the start of an opener that
// the following text completes (`<scr` + `ipt>`).
const PARTIAL_OPENER_AT_END =
  /<(?:!-?-?|s(?:c(?:r(?:i(?:pt?)?)?)?|t(?:y(?:le?)?)?)?|t(?:e(?:x(?:t(?:a(?:r(?:ea?)?)?)?)?)?)?)?$/i;

/**
 * Mask `htmlString` exactly like `maskRawTextContent`, and report whether the
 * string is closed: every pass ends idle, with no opener that a match attempt
 * failed on (so more text could complete it) and no partial opener at the end.
 * For a closed string `a`, `maskRawTextContent(a + b)` always equals
 * `masked + maskRawTextContent(b)`, so its mask can be reused as a prefix.
 */
export const maskRawTextContentWithClosure = (
  htmlString: string,
): { masked: string; closed: boolean } => {
  const hasComments = htmlString.includes("<!--");
  const hasRawTags = /<(?:script|style|textarea)\b/i.test(htmlString);
  const closedEnd = !PARTIAL_OPENER_AT_END.test(htmlString.slice(-9));
  if (!hasComments && !hasRawTags)
    return { masked: htmlString, closed: closedEnd };
  let masked = htmlString;
  let closed = closedEnd;
  MASK_PASSES.forEach((pass, index) => {
    if (index === 0 ? !hasComments : !hasRawTags) return;
    const input = masked;
    const starts: number[] = [];
    const ends: number[] = [];
    masked = input.replace(pass.match, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args[index === 0 ? 1 : 4] as number;
      starts.push(offset);
      ends.push(offset + match.length);
      return index === 0
        ? pass.blank(match)
        : pass.blank(
            match,
            args[1] as string,
            args[2] as string,
            args[3] as string,
          );
    });
    if (!closed) return;
    // Any opener outside every match is a failed attempt that more text could complete.
    let matchIndex = 0;
    pass.opener.lastIndex = 0;
    for (
      let opener = pass.opener.exec(input);
      opener !== null;
      opener = pass.opener.exec(input)
    ) {
      while (matchIndex < ends.length && ends[matchIndex] <= opener.index)
        matchIndex++;
      if (matchIndex >= starts.length || opener.index < starts[matchIndex]) {
        closed = false;
        break;
      }
      pass.opener.lastIndex = opener.index + 1;
    }
  });
  return { masked, closed };
};

/**
 * Update `masked` (the mask of `body`) after `body[start, end)` is replaced by
 * `replacement`, without re-masking the whole page. `closedThrough` is a
 * position at or before `start` whose prefix `body[0, closedThrough)` is
 * already known to be closed, or -1 when the prefix is known not to be.
 *
 * `masked` is null when any part (the prefix, the replaced text, or the
 * replacement) is not closed; the caller must then re-mask the whole page.
 * The returned `closedThrough` is `start` when the prefix is closed (the
 * prefix is unchanged by the substitution, so it stays closed for the next
 * one) and -1 when it is not, so later substitutions skip the attempt.
 */
export const spliceRawTextMask = (
  body: string,
  masked: string,
  start: number,
  end: number,
  replacement: string,
  closedThrough: number,
): { masked: string | null; closedThrough: number } => {
  if (closedThrough < 0 || closedThrough > start)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(closedThrough, start)).closed)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(start, end)).closed)
    return { masked: null, closedThrough: start };
  const inserted = maskRawTextContentWithClosure(replacement);
  if (!inserted.closed) return { masked: null, closedThrough: start };
  return {
    masked: masked.slice(0, start) + inserted.masked + masked.slice(end),
    closedThrough: start,
  };
};

const createAttributeValueCheck = (html: string) => {
  let cursor = 0;
  let state: "text" | "tag" | "before-value" | "quoted" | "unquoted" = "text";
  let quote = "";
  return (index: number): boolean => {
    while (cursor < index) {
      const char = html[cursor];
      if (state === "quoted") {
        if (char === quote) state = "tag";
      } else if (state === "unquoted") {
        if (char === ">") state = "text";
        else if (/\s/.test(char)) state = "tag";
      } else if (state === "before-value") {
        if (char === '"' || char === "'") {
          quote = char;
          state = "quoted";
        } else if (char === ">") state = "text";
        else if (!/\s/.test(char)) state = "unquoted";
      } else if (state === "tag") {
        if (char === "=") state = "before-value";
        else if (char === ">") state = "text";
      } else if (char === "<" && /[a-zA-Z/!?]/.test(html[cursor + 1] ?? "")) {
        state = "tag";
      }
      cursor++;
    }
    return (
      state === "quoted" || state === "unquoted" || state === "before-value"
    );
  };
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
  searchFrom = 0,
): { openTag: string; start: number; end: number } | null => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return null;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A fresh `g` instance per call so `lastIndex` is invocation-local (pages
  // may transpile concurrently); V8 caches the compiled pattern by source.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRegexp = new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi");
  openTagRegexp.lastIndex = searchFrom;
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const isInsideAttributeValue = createAttributeValueCheck(maskedHtml);
  let openTagMatch: RegExpExecArray | null;
  while ((openTagMatch = openTagRegexp.exec(maskedHtml)) !== null) {
    if (isInsideAttributeValue(openTagMatch.index)) continue;
    return {
      openTag: openTagMatch[0],
      start: openTagMatch.index,
      end: openTagMatch.index + openTagMatch[0].length,
    };
  }
  return null;
};

export const replaceTag = (
  htmlString: string,
  tagName: string,
  transpiledTag: string,
  masked?: string,
  offsets?: { startIndex?: number; endIndex?: number },
): string => {
  if (
    offsets &&
    typeof offsets.startIndex === "number" &&
    typeof offsets.endIndex === "number"
  ) {
    return (
      htmlString.slice(0, offsets.startIndex) +
      transpiledTag +
      htmlString.slice(offsets.endIndex)
    );
  }
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return htmlString;
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags first: <tagName ...>...</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const openTag = findOpenTag(htmlString, tagName, maskedHtml);
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex = findMatchingClose(
      htmlString,
      tagName,
      openTag.end,
      maskedHtml,
    );
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
  const selfClosingRegexp = new RegExp(
    `<${tn}(?:${ATTR_VALUE})\\s*\\/?>`,
    "gi",
  );
  const isInsideAttributeValue = createAttributeValueCheck(maskedHtml);
  let selfClosingMatch: RegExpExecArray | null;
  while ((selfClosingMatch = selfClosingRegexp.exec(maskedHtml)) !== null) {
    if (isInsideAttributeValue(selfClosingMatch.index)) continue;
    break;
  }
  if (!selfClosingMatch) return htmlString;
  return (
    htmlString.slice(0, selfClosingMatch.index) +
    transpiledTag +
    htmlString.slice(selfClosingMatch.index + selfClosingMatch[0].length)
  );
};

const componentRegexCache = new WeakMap<
  ComponentList,
  {
    keyCount: number;
    firstKey: string | undefined;
    lastKey: string | undefined;
    regex: RegExp | null;
  }
>();

/**
 * Test-only instrumentation: bytes of already-resolved document prefix that a
 * component search had to skip over before reaching its match. A search from
 * offset zero on every substitution makes this quadratic in instance count;
 * a cursor resuming at the last replacement keeps it linear.
 */
export const __componentScanStatsForTests = {
  prefixBytesExamined: 0,
  reset(): void {
    this.prefixBytesExamined = 0;
  },
};

/**
 * Find the first component tag in `htmlString` at or after `searchFrom`.
 *
 * `searchFrom` is the cursor from prompt 63: after a replacement at index S,
 * no new component tag can appear before S in the unchanged prefix, so the
 * caller resumes the search at S (never at the replacement END, which would
 * skip components nested in the inserted template). Returned indices are
 * always in whole-document coordinates.
 */
export const getFirstComponent = (
  htmlString: string,
  componentList: ComponentList,
  masked?: string,
  searchFrom = 0,
): Partial<BascikComponent> & { index?: number } => {
  if (!htmlString) return {};

  const rawKeys = Object.keys(componentList);
  const keyCount = rawKeys.length;
  const firstKey = rawKeys[0];
  const lastKey = rawKeys[keyCount - 1];
  let cached = componentRegexCache.get(componentList);
  if (
    !cached ||
    cached.keyCount !== keyCount ||
    cached.firstKey !== firstKey ||
    cached.lastKey !== lastKey
  ) {
    const componentNames = rawKeys
      .filter((name) => /^[a-zA-Z][\w:-]*$/.test(name))
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    // Super important here, reverse, makes it so we're matching on the most specific tag first
    // Meaning, it will find test-comp-clone before test-comp,
    // because reverse, the longer tag will be first in the regexp, and therefore match first.
    // It's like how an ingress controller works.
    const escapedComponentNames = componentNames.map((name) =>
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const regex =
      escapedComponentNames.length === 0
        ? null
        : new RegExp(
            `<(${escapedComponentNames.join("|")})(?![\\w-])[\\s\\S]*?>`,
            "gi",
          );
    cached = { keyCount, firstKey, lastKey, regex };
    componentRegexCache.set(componentList, cached);
  }

  if (!cached.regex) return {};
  // Never exec the shared cached instance: `lastIndex` on a `g` regex is
  // mutable state, and pages can transpile concurrently. Clone per call.
  const matchComponentName = new RegExp(
    cached.regex.source,
    cached.regex.flags,
  );
  matchComponentName.lastIndex = searchFrom;

  // Match against the masked string so literal component-tag text inside
  // <script>/<style>/<textarea> content (e.g. JSON-LD strings) is ignored.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const isInsideAttributeValue = createAttributeValueCheck(maskedHtml);
  let match: RegExpExecArray | null;
  while ((match = matchComponentName.exec(maskedHtml)) !== null) {
    if (isInsideAttributeValue(match.index)) continue;
    break;
  }
  if (!match) {
    __componentScanStatsForTests.prefixBytesExamined += Math.max(
      0,
      maskedHtml.length - searchFrom,
    );
    return {};
  }
  __componentScanStatsForTests.prefixBytesExamined += match.index - searchFrom;
  const firstComponentName = match[1].toLowerCase();
  const tagInfo = getTag(
    htmlString,
    firstComponentName,
    componentList,
    maskedHtml,
    match.index,
  );
  const resultObj: Partial<BascikComponent> & {
    index?: number;
    startIndex?: number;
    endIndex?: number;
    contentStart?: number;
    closeIndex?: number;
  } = {
    name: firstComponentName,
    index: match.index,
    ...tagInfo,
  };
  if (typeof tagInfo.startIndex === "number") {
    Object.defineProperty(resultObj, "startIndex", {
      value: tagInfo.startIndex,
      enumerable: false,
    });
  }
  if (typeof tagInfo.endIndex === "number") {
    Object.defineProperty(resultObj, "endIndex", {
      value: tagInfo.endIndex,
      enumerable: false,
    });
  }
  // Where the usage tag's inner content starts and its closing tag begins (-1 when the tag has
  // no closing tag), so a caller can edit just the inner content.
  if (typeof tagInfo.contentStart === "number") {
    Object.defineProperty(resultObj, "contentStart", {
      value: tagInfo.contentStart,
      enumerable: false,
    });
  }
  if (typeof tagInfo.closeIndex === "number") {
    Object.defineProperty(resultObj, "closeIndex", {
      value: tagInfo.closeIndex,
      enumerable: false,
    });
  }
  return resultObj;
};

export const getTag = (
  htmlString: string,
  tagName: string,
  componentList?: ComponentList,
  masked?: string,
  searchFrom = 0,
): Partial<BascikComponent> & {
  startIndex?: number;
  contentStart?: number;
  closeIndex?: number;
  endIndex?: number;
} => {
  if (!/^[a-zA-Z][\w:-]*$/.test(tagName)) return {};
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try paired tags: <tagName ...>content</tagName>
  // Use findMatchingClose (a depth counter) instead of a lazy regex so nested
  // same-name elements pair with the correct (balanced) closing tag, e.g.
  // <my-list>...<my-list></my-list>...</my-list>.
  const maskedHtml =
    masked !== undefined ? masked : maskRawTextContent(htmlString);
  const openTag = findOpenTag(htmlString, tagName, maskedHtml, searchFrom);
  if (openTag && !/\/\s*>$/.test(openTag.openTag)) {
    const closeIndex = findMatchingClose(
      htmlString,
      tagName,
      openTag.end,
      maskedHtml,
    );
    if (closeIndex !== -1) {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeTagRegexp = new RegExp(`^<\\/${tn}\\s*>`, "i");
      const closeTagMatch = closeTagRegexp.exec(htmlString.slice(closeIndex));
      if (closeTagMatch) {
        const returnObj: Partial<BascikComponent> & {
          startIndex?: number;
          contentStart?: number;
          closeIndex?: number;
          endIndex?: number;
        } = {
          content: htmlString.slice(
            openTag.start,
            closeIndex + closeTagMatch[0].length,
          ),
          innerContent: htmlString.slice(openTag.end, closeIndex),
        };
        Object.defineProperties(returnObj, {
          startIndex: { value: openTag.start, enumerable: false },
          contentStart: { value: openTag.end, enumerable: false },
          closeIndex: { value: closeIndex, enumerable: false },
          endIndex: {
            value: closeIndex + closeTagMatch[0].length,
            enumerable: false,
          },
        });
        if (!componentList) return returnObj;
        const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
        Object.defineProperties(res, {
          startIndex: { value: openTag.start, enumerable: false },
          contentStart: { value: openTag.end, enumerable: false },
          closeIndex: { value: closeIndex, enumerable: false },
          endIndex: {
            value: closeIndex + closeTagMatch[0].length,
            enumerable: false,
          },
        });
        return res;
      }
    }
  }

  if (openTag) {
    const returnObj: Partial<BascikComponent> & {
      startIndex?: number;
      contentStart?: number;
      closeIndex?: number;
      endIndex?: number;
    } = {
      content: openTag.openTag,
      innerContent: "",
    };
    Object.defineProperties(returnObj, {
      startIndex: { value: openTag.start, enumerable: false },
      contentStart: { value: openTag.end, enumerable: false },
      closeIndex: { value: -1, enumerable: false },
      endIndex: { value: openTag.end, enumerable: false },
    });
    if (!componentList) return returnObj;
    const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
    Object.defineProperties(res, {
      startIndex: { value: openTag.start, enumerable: false },
      contentStart: { value: openTag.end, enumerable: false },
      closeIndex: { value: -1, enumerable: false },
      endIndex: { value: openTag.end, enumerable: false },
    });
    return res;
  }

  // Try self-closing: <tagName ... /> or <tagName/>
  // Search the masked string so literal tag text inside raw-text elements is skipped.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const selfClosingPattern = new RegExp(
    `<${tn}(?![\\w-])([\\s\\S]*?)\\/?>`,
    "gi",
  );
  selfClosingPattern.lastIndex = searchFrom;
  const isInsideAttributeValue = createAttributeValueCheck(maskedHtml);
  let selfClosingMatch: RegExpExecArray | null;
  while ((selfClosingMatch = selfClosingPattern.exec(maskedHtml)) !== null) {
    if (isInsideAttributeValue(selfClosingMatch.index)) continue;
    break;
  }
  if (selfClosingMatch) {
    const returnObj: Partial<BascikComponent> & {
      startIndex?: number;
      contentStart?: number;
      closeIndex?: number;
      endIndex?: number;
    } = {
      content: htmlString.slice(
        selfClosingMatch.index,
        selfClosingMatch.index + selfClosingMatch[0].length,
      ),
      innerContent: "",
    };
    Object.defineProperties(returnObj, {
      startIndex: { value: selfClosingMatch.index, enumerable: false },
      contentStart: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
      closeIndex: { value: -1, enumerable: false },
      endIndex: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
    });
    if (!componentList) return returnObj;
    const res = { ...returnObj, ...componentList[tagName.toLowerCase()] };
    Object.defineProperties(res, {
      startIndex: { value: selfClosingMatch.index, enumerable: false },
      contentStart: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
      closeIndex: { value: -1, enumerable: false },
      endIndex: {
        value: selfClosingMatch.index + selfClosingMatch[0].length,
        enumerable: false,
      },
    });
    return res;
  }

  return {};
};

// ─── Props ────────────────────────────────────────────────────────────────────

const decodePropEntities = (value: string): string =>
  value.replace(
    /&(amp|lt|gt|quot|#39|#x27);/gi,
    (_match, entity: string) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        "#x27": "'",
      })[entity.toLowerCase()] ?? _match,
  );

const escapePropValue = (value: string): string =>
  value
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
  if (!componentContent || !/data-bascik-prop-/i.test(componentContent))
    return props;
  const openingTag = componentContent.match(
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    new RegExp(`^<[a-zA-Z][\\w:-]*(?:${ATTR_VALUE})>`, "i"),
  )?.[0];
  if (!openingTag) return props;
  // Only whole attribute names count. A token that looks like a prop marker
  // inside another attribute's quoted value (e.g. a doc reference in
  // `title="see data-bascik-prop-x"`) is text, never a prop.
  const propRegexpPrefix = /^data-bascik-prop-/i;
  for (const attr of scanWholeAttributes(openingTag)) {
    const propMatch = propRegexpPrefix.exec(attr.name);
    if (!propMatch) continue;
    const propName = attr.name.slice(propMatch[0].length);
    if (!/^[\w-]+$/.test(propName)) continue;
    // A valueless marker is a template receiver, not a provided value; it
    // contributes no prop (matching the pre-scanner extraction which required
    // an `= value`).
    if (attr.valueStart === -1) continue;
    const rawVal = openingTag.slice(attr.valueStart, attr.valueEnd);
    const isQuoted =
      openingTag[attr.valueStart - 1] === '"' ||
      openingTag[attr.valueStart - 1] === "'";
    if (isQuoted) {
      const followingCharacter = openingTag[attr.valueEnd + 1];
      if (followingCharacter && !/[\s/>]/.test(followingCharacter)) {
        console.warn(
          `Ignoring malformed data-bascik-prop-${propName}: the value contains an unescaped delimiting quote. Use &quot; or &#39; for quotes inside prop values.`,
        );
        continue;
      }
      props[propName] = decodePropEntities(rawVal);
    } else {
      // Unquoted value: it never contains `/>` or `=` delimiters; a trailing
      // `/` belongs to the self-closing syntax, so drop it.
      const cleanUnquoted = rawVal.endsWith("/") ? rawVal.slice(0, -1) : rawVal;
      props[propName] = decodePropEntities(cleanUnquoted);
    }
  }
  return props;
};

export const injectPropAttributes = (
  fileContent: string | undefined,
  props: Record<string, string>,
): string => {
  if (!fileContent) return "";
  if (!fileContent.includes("data-bascik-attr-")) return fileContent;

  const propsLowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(props)) {
    propsLowerMap.set(k.toLowerCase(), v);
  }

  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? fileContent.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
        commentShield.hide(comment),
      )
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);

  const rewritten = rawShield.html.replace(
    new RegExp(`<([a-zA-Z][\\w:-]*)(?:${ATTR_VALUE})>`, "gi"),
    (openingTag: string) => {
      if (!openingTag.includes("data-bascik-attr-")) return openingTag;
      // Whole attribute names only: a token that looks like a directive inside
      // another attribute's quoted value is text, never a directive.
      const directives: Array<{
        start: number;
        end: number;
        targetName: string;
        rawPropName?: string;
      }> = [];
      for (const attr of scanWholeAttributes(openingTag)) {
        const match = /^data-bascik-attr-(.*)$/i.exec(attr.name);
        if (!match) continue;
        const targetName = match[1];
        const rawPropName =
          attr.valueStart !== -1
            ? openingTag.slice(attr.valueStart - 1, attr.valueEnd + 1)
            : undefined;
        let start = attr.start;
        if (start > 0 && /\s/.test(openingTag[start - 1])) start--;
        directives.push({
          start,
          end: attr.end,
          targetName,
          rawPropName,
        });
      }

      let result = openingTag;
      for (let index = directives.length - 1; index >= 0; index--) {
        const directive = directives[index];
        result = result.slice(0, directive.start) + result.slice(directive.end);
      }

      for (const { targetName, rawPropName } of directives) {
        const isQuoted =
          rawPropName?.startsWith('"') || rawPropName?.startsWith("'");
        const propName = isQuoted ? rawPropName?.slice(1, -1) : undefined;
        if (
          !/^[a-zA-Z_:][\w:.-]*$/.test(targetName) ||
          !propName ||
          !/^[a-zA-Z0-9_-]+$/.test(propName)
        ) {
          console.warn(
            `Ignoring malformed data-bascik-attr-${targetName}: expected a quoted prop name.`,
          );
          continue;
        }

        const propValue =
          props[propName] ?? propsLowerMap.get(propName.toLowerCase());
        if (propValue === undefined) continue;
        const attribute = ` ${targetName}="${escapePropValue(propValue)}"`;
        // Whole-name conflict check: the target may already exist, but a
        // "target-looking" token inside another attribute's quoted value is
        // text and must not count as the target.
        const existing = scanWholeAttributes(result).find(
          (attr) => attr.name.toLowerCase() === targetName.toLowerCase(),
        );
        if (existing) {
          console.warn(
            `Attribute binding conflict: attribute "${targetName}" already exists; prop "${propName}" wins.`,
          );
          result =
            result.slice(0, existing.start) +
            attribute.slice(1) +
            result.slice(existing.end);
        } else {
          result = result.replace(
            /(\s*\/?>)$/,
            (_match, close: string) => `${attribute}${close}`,
          );
        }
      }

      return result;
    },
  );
  return commentShield.restore(rawShield.restore(rewritten));
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
  if (
    Object.keys(props).length === 0 &&
    !fileContent.includes("data-bascik-prop-")
  ) {
    return fileContent;
  }
  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? fileContent.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
        commentShield.hide(comment),
      )
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);
  let result = rawShield.html;
  const resultLower = result.toLowerCase();
  Object.entries(props).forEach(([propName, propValue]) => {
    if (!resultLower.includes(propName.toLowerCase())) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(propName)) return;
    const attrName = `data-bascik-prop-${propName}`;
    const escapedPropValue = escapePropValue(propValue);
    // Scan whole opening tags and act only on whole attribute names, so a
    // marker token inside another attribute's quoted value is never confused
    // with a receiver.
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const openTagRe = new RegExp(`<([a-zA-Z][\\w:-]*)(?:${ATTR_VALUE})>`, "gi");
    let searchIndex = 0;
    while (searchIndex < result.length) {
      openTagRe.lastIndex = searchIndex;
      const openMatch = openTagRe.exec(result);
      if (!openMatch) break;
      const openTag = openMatch[0];
      const tagName = openMatch[1];
      const receiverAttr = scanWholeAttributes(openTag).find(
        (attr) =>
          attr.name.toLowerCase() === attrName.toLowerCase() &&
          attr.valueStart === -1 &&
          // A self-closing marker (`data-bascik-prop-x/>`) is not a receiver.
          (/[\s>]/.test(openTag[attr.nameEnd] ?? "") ||
            attr.nameEnd >= openTag.length),
      );
      if (!receiverAttr) {
        searchIndex = openMatch.index + openTag.length;
        continue;
      }
      const contentStart = openMatch.index + openTag.length;
      const closeIndex = findMatchingClose(result, tagName, contentStart);
      if (closeIndex === -1) {
        searchIndex = contentStart;
        continue;
      }
      const closeTag = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
        result.slice(closeIndex),
      )?.[0];
      if (!closeTag) {
        searchIndex = contentStart;
        continue;
      }
      // Remove the receiver attribute from the opening tag.
      let attrStart = receiverAttr.start;
      if (attrStart > 0 && /\s/.test(openTag[attrStart - 1])) attrStart--;
      const newOpenTag =
        openTag.slice(0, attrStart) + openTag.slice(receiverAttr.end);
      const replacement = `${newOpenTag}${escapedPropValue}${closeTag}`;
      result =
        result.slice(0, openMatch.index) +
        replacement +
        result.slice(closeIndex + closeTag.length);
      searchIndex = openMatch.index + replacement.length;
    }
  });
  // Strip any remaining data-bascik-prop-* markers whose prop was not provided.
  // Only strip markers that are whole attribute names WITHOUT a value (prop
  // receivers, e.g. `data-bascik-prop-label` followed by whitespace or `>`).
  // Markers with a value (e.g. `data-bascik-prop-label="featured"`) are child
  // component prop declarations and must be preserved so nested components
  // receive their props.  A token that only appears inside prose or inside
  // another attribute's quoted value is text, never a marker.
  const stripped = stripUnfilledPropMarkers(result);
  return commentShield.restore(rawShield.restore(stripped));
};

const stripUnfilledPropMarkers = (html: string): string => {
  // Whole attribute names only: a token that merely looks like a marker inside
  // prose or another attribute's quoted value is text and is never stripped.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<([a-zA-Z][\\w:-]*)((?:${ATTR_VALUE})[\\s>])`,
    "gi",
  );
  let result = html;
  let openTagMatch: RegExpExecArray | null;
  while ((openTagMatch = openTagRe.exec(result)) !== null) {
    const openTag = openTagMatch[0];
    const tagStart = openTagMatch.index;
    const removals: Array<{ start: number; end: number }> = [];
    for (const attr of scanWholeAttributes(openTag)) {
      if (!/^data-bascik-prop-[\w-]+$/i.test(attr.name)) continue;
      // Keep markers that carry a value: they are child component prop
      // declarations that must reach the nested component.
      if (attr.valueStart !== -1) continue;
      // A marker on a self-closing tag (`data-bascik-prop-x/>`) is left as
      // authored, matching the old receiver boundary.
      if (
        !/[\s>]/.test(openTag[attr.nameEnd] ?? "") &&
        attr.nameEnd < openTag.length
      )
        continue;
      let start = attr.start;
      if (start > 0 && /\s/.test(openTag[start - 1])) start--;
      removals.push({ start, end: attr.end });
    }
    if (removals.length === 0) {
      openTagRe.lastIndex = tagStart + openTag.length;
      continue;
    }
    // Rebuild the tag keeping only the non-removed pieces.
    let pieces = "";
    let cursor = 0;
    for (const { start, end } of removals) {
      pieces += openTag.slice(cursor, start);
      cursor = end;
    }
    pieces += openTag.slice(cursor);
    result =
      result.slice(0, tagStart) +
      pieces +
      result.slice(tagStart + openTag.length);
    // Re-scan from the same document offset: the tag was rewritten but the
    // outer regex must not skip content (positions after the tag shifted).
    openTagRe.lastIndex = tagStart;
  }
  return result;
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
  const openRe = new RegExp(`<${tn}(?![\\w-])(?:${ATTR_VALUE})>`, "gi");
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const closeRe = new RegExp(`<\\/${tn}\\s*>`, "gi");
  // Scan the masked string so literal tag text inside <script>/<style>/<textarea>
  // content never skews the depth counter. Indices are valid in the original.
  const maskedHtml = masked !== undefined ? masked : maskRawTextContent(html);
  const isInsideAttributeValue = createAttributeValueCheck(maskedHtml);
  let depth = 1;
  let pos = contentStart;
  while (pos < maskedHtml.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(maskedHtml);
    const closeMatch = closeRe.exec(maskedHtml);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.index) {
      if (isInsideAttributeValue(closeMatch.index)) {
        pos = closeMatch.index + closeMatch[0].length;
        continue;
      }
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    } else {
      if (!isInsideAttributeValue(openMatch.index)) {
        if (!/\/\s*>$/.test(openMatch[0])) {
          depth++;
        }
      }
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
  componentNames: ReadonlySet<string> = new Set(),
): Array<{
  slotName: string;
  startIndex: number;
  endIndex: number;
  content: string;
}> => {
  if (!innerContent.includes("data-bascik-slot")) return [];
  const results: Array<{
    slotName: string;
    startIndex: number;
    endIndex: number;
    content: string;
  }> = [];
  const masked = maskRawTextContent(innerContent);
  // Quote-aware attribute scan (ATTR_VALUE) so the marker may appear after
  // other attributes, and `data-bascik-slot` inside a quoted attribute value
  // never false-positives.
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s"'=<>` +
      "`" +
      `/>]+))(?:${ATTR_VALUE})>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName, doubleName, singleName, unquotedName] = match;
    const slotName = doubleName ?? singleName ?? unquotedName;
    if (
      isInsideNestedComponent(innerContent, match.index, componentNames, masked)
    )
      continue;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(
      innerContent,
      tagName,
      contentStart,
      masked,
    );
    if (closeIndex === -1) continue;
    const closeTagMatch = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
      innerContent.slice(closeIndex),
    );
    const closeTagLen = closeTagMatch
      ? closeTagMatch[0].length
      : `</${tagName}>`.length;
    const endIndex = closeIndex + closeTagLen;
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
 * Returns true when an index is inside an unresolved child component usage.
 * Named slots belong to their nearest component boundary, so a parent must not
 * consume slot wrappers authored inside a nested component's usage content.
 */
const isInsideNestedComponent = (
  html: string,
  index: number,
  componentNames: ReadonlySet<string>,
  preMasked?: string,
): boolean => {
  if (componentNames.size === 0) return false;
  const masked = preMasked !== undefined ? preMasked : maskRawTextContent(html);
  for (const componentName of componentNames) {
    let searchFrom = 0;
    while (searchFrom < index) {
      const child = getTag(html, componentName, undefined, masked, searchFrom);
      const startIndex = child.startIndex;
      const contentStart = child.contentStart;
      const closeIndex = child.closeIndex;
      const endIndex = child.endIndex;
      if (typeof startIndex !== "number" || startIndex >= index) break;
      if (
        typeof contentStart === "number" &&
        typeof closeIndex === "number" &&
        closeIndex !== -1 &&
        index >= contentStart &&
        index < closeIndex
      ) {
        return true;
      }
      searchFrom =
        typeof endIndex === "number" && endIndex > startIndex
          ? endIndex
          : startIndex + 1;
    }
  }
  return false;
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
  componentNames: ReadonlySet<string> = new Set(),
): string => {
  if (!innerContent) return "";
  const named = parseNamedSlots(innerContent, componentNames);
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
  componentNames: ReadonlySet<string> = new Set(),
): Record<string, string> => {
  if (!innerContent) return {};
  const slots: Record<string, string> = {};
  for (const { slotName, content } of parseNamedSlots(
    innerContent,
    componentNames,
  )) {
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
  componentNames: ReadonlySet<string> = new Set(),
): string => {
  // Scan wrappers with the same depth-aware parser used for extraction so
  // nested same-tag elements inside a placeholder's fallback content are
  // handled correctly, then replace right-to-left to preserve indices.
  const wrappers = parseNamedSlots(fileContent, componentNames);
  if (wrappers.length === 0) return fileContent;
  const slotsLowerMap = new Map<string, string>();
  for (const [key, val] of Object.entries(slots)) {
    slotsLowerMap.set(key.toLowerCase(), val);
  }
  let result = fileContent;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const { slotName, startIndex, endIndex, content } = wrappers[i];
    // Use the element's own inner content as fallback when the slot is not provided
    const matchedSlot =
      slotName in slots
        ? slots[slotName]
        : slotsLowerMap.get(slotName.toLowerCase());
    const replacement = matchedSlot !== undefined ? matchedSlot : content;
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
  const masked = maskRawTextContent(fileContent);
  // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const openTagRe = new RegExp(
    `<(\\w+(?:-\\w+)*)(?=[\\s>])(?:${ATTR_VALUE}?)\\s+data-bascik-slot(?!\\s*=)(?:${ATTR_VALUE})>`,
    "gi",
  );
  const wrappers: Array<{
    startIndex: number;
    endIndex: number;
    content: string;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(masked)) !== null) {
    const [fullOpen, tagName] = match;
    const contentStart = match.index + fullOpen.length;
    const closeIndex = findMatchingClose(
      fileContent,
      tagName,
      contentStart,
      masked,
    );
    if (closeIndex === -1) continue;
    const closeTagMatch = new RegExp(`^<\\/${tagName}\\s*>`, "i").exec(
      fileContent.slice(closeIndex),
    );
    const closeTagLen = closeTagMatch
      ? closeTagMatch[0].length
      : `</${tagName}>`.length;
    const endIndex = closeIndex + closeTagLen;
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
  // Accept double-quoted, single-quoted, whitespace-spaced, and unquoted attribute values.
  const attrRegex = /\s+([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`/>]+))?/g;
  let match;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    const [, name, rawValue] = match;
    if (name.startsWith("data-bascik-")) continue;
    if (rawValue === undefined) {
      attrs[name] = "";
    } else if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      attrs[name] = rawValue.slice(1, -1);
    } else {
      attrs[name] = rawValue;
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
  const masked = maskRawTextContent(html);
  const tagRegex = new RegExp(`<([a-zA-Z][\\w-]*)(?:${ATTR_VALUE})>`, "gi");
  const metadataTags = new Set(["link", "meta", "script", "style"]);
  let rootMatch: RegExpExecArray | null = null;
  let candidate: RegExpExecArray | null;
  while ((candidate = tagRegex.exec(masked)) !== null) {
    if (!metadataTags.has(candidate[1].toLowerCase())) {
      rootMatch = candidate;
      break;
    }
  }
  if (!rootMatch) return html;

  const rootTag = html.slice(
    rootMatch.index,
    rootMatch.index + rootMatch[0].length,
  );
  const rootParts =
    /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\s*\/?>)$/i.exec(rootTag);
  if (!rootParts) return html;
  const [, tagName, existing, close] = rootParts;
  let attrStr = existing || "";
  const existingNames = new Set<string>();
  const attrRegex = /\s+([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`/>]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    existingNames.add(match[1].toLowerCase());
  }

  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "class" && value) {
      if (/\sclass\s*=\s*"/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*"([^"]*)"/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}="${classes ? `${classes} ` : ""}${value}"`,
        );
      } else if (/\sclass\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*'([^']*)'/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}='${classes ? `${classes} ` : ""}${value}'`,
        );
      } else if (/\sclass\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(class)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, classes: string) =>
            ` ${attrName}="${classes} ${value}"`,
        );
      } else {
        attrStr += ` class="${value}"`;
      }
    } else if (lowerName === "style" && value) {
      if (/\sstyle\s*=\s*"/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*"([^"]*)"/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}"`,
        );
      } else if (/\sstyle\s*=\s*'/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*'([^']*)'/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}='${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}'`,
        );
      } else if (/\sstyle\s*=\s*[^\s"'=<>`/>]+/i.test(attrStr)) {
        attrStr = attrStr.replace(
          /\s(style)\s*=\s*([^\s"'=<>`/>]+)/i,
          (_, attrName: string, style: string) =>
            ` ${attrName}="${style}${style.trimEnd().endsWith(";") ? " " : "; "}${value}"`,
        );
      } else {
        attrStr += ` style="${value}"`;
      }
    } else if (value !== undefined && !existingNames.has(lowerName)) {
      attrStr += ` ${name}="${value}"`;
    }
  }

  const mergedRoot = `<${tagName}${attrStr}${close}`;
  return (
    html.slice(0, rootMatch.index) +
    mergedRoot +
    html.slice(rootMatch.index + rootTag.length)
  );
};
