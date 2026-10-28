import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import {
  getComponentCss,
  extractInlineStyles,
  resolveCssImports,
} from "./styles.ts";
import { getComponentScripts } from "./javascript.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { BascikConfig } from "./config.ts";
import { minifyHtml } from "./html-minifier.ts";
import { maskElementContents } from "./shielding.ts";
import {
  transformTypeScriptScriptTags,
  TypeScriptTransformError,
  hasStaticModuleSyntax,
} from "./typescript.ts";
import { getScriptType } from "./script-types.ts";
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
import { findCompatibilityMatches } from "./compatibility-checker.ts";
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

const SRC_MARKER_RE = /\ssrc=["']([^"']+)["']/iy;

/**
 * `html.replace(regex, (match, preSrc, srcVal, postSrc, body) => ...)` for
 * `/<script\b((?:[^>"']|"[^"]*"|'[^']*')*?)\ssrc=["']([^"']+)["']((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi`:
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
// `<script\b(?:[^>"']|"[^"]*"|'[^']*')*\s(?:${BUILD_ATTR_NAME}|${BUILD_ONCE_ATTR_NAME})(?=[\s=/>])`
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

  // `(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>`
  // (flags `gi`), in linear time.
  for (const scriptMatch of scanElementContents(nonCodeScan, "script", {
    opener: "word-boundary",
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
  if (isDefaultRoots) {
    componentListCache = builtList;
  }
  return builtList;
};

/** The companion script inlining scan, for the linear-time tests. */
export const __companionScriptTagsForTests = replaceCompanionScriptTags;
