/**
 * @module component-manifest
 *
 * The build-time component manifest (prompt 157, D3): everything a request-time
 * renderer needs to expand a component tag that a server or stream script
 * returned, recorded once per build into `dist/.bascik/components.json`.
 *
 * Per component the manifest holds a `ScopingTemplate`: the real scoping
 * pipeline recorded on a sentinel instance id (scoping-template.ts), with the
 * component's build scripts already run into it and its server and stream
 * scripts staged in the sidecar as `component_script_*` jobs. A renderer
 * instantiates the template for a fresh id by replaying the recorded name
 * hashes (scoping-instantiate.ts) and runs the compiler's own expansion loop
 * over it, so the output is what the build would have produced.
 *
 * A component the template cannot reproduce is recorded as unsupported with
 * one of the D7 reasons (plus a `detail` naming what in the component
 * triggered it, and the line where one is known) and left unexpanded at
 * request time:
 *
 * - a `data-bascik-attr-*` binding onto an attribute scoping rewrites (id,
 *   name, class, usemap) or that resolves `url(#id)` references (style, fill,
 *   stroke, mask, clip-path, filter, marker-*): the build injects the value
 *   BEFORE scoping, a renderer only has the template, so the value could not
 *   be scoped; or onto an id-reference attribute (for, headers, href,
 *   xlink:href) on an element the build does not rewrite it on, since the
 *   request-time rewrite is per target attribute and never sees the element;
 * - a server or stream script whose body or output scope embeds the instance
 *   id (a scoped id or name inside a string literal; per-instance CSS): one
 *   staged module cannot serve every instance;
 * - a `data-bascik-build` script that read its page context: its output
 *   differs per page, and the template has no page;
 * - `data-bascik-attr-src` on a directive script: the module path would be
 *   decided per usage;
 * - a scoping run the template recorder cannot reuse (a CSS `@import` planned
 *   while scoping, console output, a token the minifier split, a prediction
 *   that did not match a second id), or build-script output the template
 *   cannot hold as printed (a prop, slot, attr-binding or preserve marker the
 *   usage would be injected into at request time but not at page time; a
 *   printed root that would inherit the usage's attributes).
 *
 * The manifest exists only for releases whose sidecar has page-owned server
 * or stream entries (ownership.ts); a static site never gets one.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rewriteCssBasePaths } from "./base-path.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { scanWholeAttributes } from "./component-attribute-scan.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { findComponentRoot } from "./component-roots.ts";
import { getProjectPath, getRelativePath } from "./file-system.ts";
import {
  BUILD_ATTR_NAME,
  BUILD_ONCE_ATTR_NAME,
  isDirectiveScriptOpenTag,
  OPEN_TAG_ATTRS,
  SCRIPT_END_TAG,
  SERVER_ATTR_NAME,
  STREAM_ATTR_NAME,
} from "./html-patterns.ts";
import { getAttributeNameHash } from "./names.ts";
import {
  minifyScriptTagsInHtml,
  resolveCssMinifier,
  resolveScriptMinifier,
} from "./page-minification.ts";
import {
  instantiateTemplate,
  join as joinSegments,
  replayTemplateTokens,
  type ScopingResult,
  type ScopingTemplate,
} from "./scoping-instantiate.ts";
import {
  buildScopingTemplate,
  differingField,
  recordScopingRun,
  runScopingPipeline,
  sameResult,
  scopingInputTexts,
  snapshotScopingResult,
} from "./scoping-template.ts";
import {
  extractComponentScriptsToSidecar,
  serverSidecarRegistry,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { maskElementContents } from "./shielding.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { inOrder } from "./ordered-output.ts";
import { deduplicateCss } from "./styles.ts";
import type {
  BascikComponent,
  ComponentList,
  MinifyOptions,
  ScopingOptions,
} from "./types.ts";
import {
  COMPONENT_MANIFEST_SCHEMA_VERSION,
  type ComponentManifest,
  type ManifestCss,
  type ManifestEntry,
  type ManifestJob,
  type UnsupportedEntry,
  type UnsupportedReason,
} from "./component-manifest-file.ts";

// The manifest as a file lives in component-manifest-file.ts, which serving
// a release imports without this builder; re-exported for the build side.
export * from "./component-manifest-file.ts";

/** The config the manifest records; the build passes `BascikConfig`. */
export interface ManifestBuildConfig {
  base?: string;
  minify?: Partial<MinifyOptions>;
  scoping?: Partial<ScopingOptions>;
}

/**
 * The instance ids the template is recorded and verified with. Neither is a
 * build id (8 hex characters) nor a request id (`r` + 7 hex), and the
 * recorder refuses a template whose authored text contains either.
 */
const SENTINEL_ID = "rsentinel";
const VERIFY_ID = "rverified";

const identity = (input: string): string => input;

const sha256 = (body: string): string =>
  `sha256-${createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")}`;

/**
 * Attributes whose bound value scoping would have rewritten (id, name,
 * class; usemap against the scoped `<map name>`) or resolved `url(#id)`
 * references in (D3 step 1).
 */
const SCOPED_TARGET_RE =
  /^(?:id|name|class|usemap|style|fill|stroke|mask|clip-path|filter|marker(?:-[\w-]*)?)$/i;

/**
 * The id-reference attributes the build rewrites only on some elements
 * (id-references.ts). The request-time rewrite is per target attribute and
 * never sees the element, so a binding elsewhere is refused rather than
 * rewritten where the build would not.
 */
const TAG_CONDITIONAL_TARGETS: Record<string, ReadonlySet<string>> = {
  for: new Set(["label", "output"]),
  headers: new Set(["td", "th"]),
  href: new Set(["a", "area", "use"]),
  "xlink:href": new Set(["use"]),
};

const OPEN_TAG_RE = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const HAS_BUILD_SCRIPT_RE = new RegExp(
  String.raw`<script\b${OPEN_TAG_ATTRS}\s(?:${BUILD_ATTR_NAME}|${BUILD_ONCE_ATTR_NAME})`,
  "i",
);

const METADATA_TAGS = new Set(["link", "meta", "script", "style"]);

/**
 * Where attribute inheritance lands in `html`: the index of the first element
 * that is not a metadata tag, as `mergeAttributesOntoRoot` picks it, or -1.
 */
const inheritanceRootIndex = (html: string): number => {
  const masked = maskRawTextContent(html);
  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(masked)) !== null) {
    if (!METADATA_TAGS.has(match[1].toLowerCase())) return match.index;
  }
  return -1;
};

/**
 * Whether usage attributes would land on a different element once build
 * output is part of the template. The build merges them before its build
 * scripts print (onto the first non-metadata element, or nowhere when only a
 * build script precedes the output); a renderer merges them onto the baked
 * template. Both agree exactly when the root precedes every build script, or
 * when neither text has one.
 */
const inheritanceRootShifted = (before: string, after: string): boolean => {
  const rootBefore = inheritanceRootIndex(before);
  const rootAfter = inheritanceRootIndex(after);
  if (rootBefore === -1 && rootAfter === -1) return false;
  const firstBuildScript = HAS_BUILD_SCRIPT_RE.exec(
    maskRawTextContent(before),
  )?.index;
  return !(
    rootBefore !== -1 &&
    (firstBuildScript === undefined || rootBefore < firstBuildScript)
  );
};

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const REQUEST_SCRIPT_RE = new RegExp(
  String.raw`<script\b(${OPEN_TAG_ATTRS}\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})${OPEN_TAG_ATTRS})>([\s\S]*?)${SCRIPT_END_TAG}`,
  "gi",
);

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const SCRIPT_BODY_RE = new RegExp(
  String.raw`<script\b${OPEN_TAG_ATTRS}>([\s\S]*?)(${SCRIPT_END_TAG})`,
  "gi",
);

/** The 1-based line `index` falls on in `text`. */
const lineAt = (text: string, index: number): number =>
  countOccurrences(text.slice(0, index), "\n") + 1;

/**
 * The first `data-bascik-attr-*` binding the template cannot honor, as the
 * build's `injectPropAttributes` would see it: whole attribute names on real
 * open tags, never text inside comments, raw-text content or quoted values.
 * The masks keep every offset, so the open tag's index in the masked text is
 * its line in `html` (see `onAuthoredLine` for the line in the source).
 */
const classifyBindings = (html: string): UnsupportedEntry | null => {
  if (!/data-bascik-attr-/i.test(html)) return null;
  const masked = maskElementContents(
    html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
      " ".repeat(comment.length),
    ),
    ["script", "style", "textarea"],
  );
  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(masked)) !== null) {
    const openTag = match[0];
    if (!/data-bascik-attr-/i.test(openTag)) continue;
    const tag = match[1].toLowerCase();
    const line = lineAt(html, match.index);
    const directiveScript =
      tag === "script" && isDirectiveScriptOpenTag(openTag);
    for (const attr of scanWholeAttributes(openTag)) {
      const target = /^data-bascik-attr-(.+)$/i.exec(attr.name)?.[1];
      if (!target) continue;
      if (directiveScript && target.toLowerCase() === "src")
        return {
          reason: "attr-src-on-directive-script",
          detail: "its data-bascik-attr-src binding is on a directive script",
          line,
        };
      if (SCOPED_TARGET_RE.test(target))
        return {
          reason: "attr-binding-to-scoped-attribute",
          detail: `its data-bascik-attr-${target} binding targets an attribute scoping rewrites`,
          line,
        };
      const rewrittenOn = TAG_CONDITIONAL_TARGETS[target.toLowerCase()];
      if (rewrittenOn && !rewrittenOn.has(tag))
        return {
          reason: "attr-binding-to-scoped-attribute",
          detail: `its data-bascik-attr-${target} binding is on a <${tag}>, where the build does not rewrite ${target}`,
          line,
        };
    }
  }
  return null;
};

/**
 * The markers in `html` the loop injects a usage into (`data-bascik-prop-*`
 * receivers without a value, `data-bascik-slot`, `data-bascik-attr-*`) or
 * scoping consumes (`data-bascik-preserve`), as whole attribute names on real
 * open tags, each counted. A valued `data-bascik-prop-*` is a nested usage's
 * declaration, which the loop expands the same way on both paths.
 */
const INJECTION_MARKER_RE =
  /^data-bascik-(?:prop-[\w-]+|slot|attr-[\w:.-]+|preserve)$/i;

const countInjectionMarkers = (html: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!/data-bascik-(?:prop-|slot|attr-|preserve)/i.test(html)) return counts;
  const masked = maskElementContents(
    html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
      " ".repeat(comment.length),
    ),
    ["script", "style", "textarea"],
  );
  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(masked)) !== null) {
    if (!/data-bascik-/i.test(match[0])) continue;
    for (const attr of scanWholeAttributes(match[0])) {
      const name = attr.name.toLowerCase();
      if (!INJECTION_MARKER_RE.test(name)) continue;
      if (name.startsWith("data-bascik-prop-") && attr.valueStart !== -1)
        continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * The first marker build-script output in `after` printed that `before` did
 * not declare, or null. The build injects the usage's props, slots and attr
 * bindings before its build scripts print, so a printed marker reaches the
 * page as text; baked into the template it would be injected at request time.
 */
const printedInjectionMarker = (
  before: string,
  after: string,
): string | null => {
  const declared = countInjectionMarkers(before);
  for (const [name, count] of countInjectionMarkers(after)) {
    if (count > (declared.get(name) ?? 0)) return name;
  }
  return null;
};

/**
 * The server and stream script elements in `html`, open tag included, in
 * document order. The open tag carries the component's output scope, which
 * embeds the instance id when the component's classes are scoped per
 * instance (per-instance CSS, `scoping.deduplicateCss: false`).
 */
const requestScriptElements = (html: string): string[] =>
  [...html.matchAll(REQUEST_SCRIPT_RE)].map((match) => match[0]);

const SCRIPT_OPEN_TAG_RE = /^<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/i;

/**
 * Why the server and stream script elements of two instances differ: the
 * open tag (its output scope embeds the id, which the author's stylesheet
 * caused) or the body (the author's script embeds a scoped id or name). The
 * two have different fixes, so the detail tells them apart.
 */
const requestScriptDifference = (a: string[], b: string[]): string => {
  const openTagsDiffer =
    a.length === b.length &&
    a.some(
      (element, index) =>
        SCRIPT_OPEN_TAG_RE.exec(element)?.[0] !==
        SCRIPT_OPEN_TAG_RE.exec(b[index])?.[0],
    );
  return openTagsDiffer
    ? "its server or stream script runs with per-instance class names (a stylesheet using url(#id), or scoping.deduplicateCss: false)"
    : "its server or stream script body embeds a scoped id or name, which differs per instance";
};

/** Every token's offset in the text `segmented` joins to with `values`. */
const tokenOffsets = (
  segmented: ScopingTemplate["fileContent"],
  values: string[],
): number[] => {
  const offsets: number[] = [];
  let cursor = segmented.parts[0].length;
  for (let index = 0; index < segmented.tokens.length; index++) {
    offsets.push(cursor);
    cursor += values[segmented.tokens[index]].length;
    cursor += segmented.parts[index + 1].length;
  }
  return offsets;
};

/** The `[start, end)` ranges of every `<script>` body in `html`. */
const scriptBodyRanges = (html: string): Array<[number, number]> =>
  [...html.matchAll(SCRIPT_BODY_RE)].map((match) => {
    // Measured from the end: a quoted attribute value may contain `>`.
    const end = match.index + match[0].length - match[2].length;
    return [end - match[1].length, end];
  });

const countOccurrences = (text: string, token: string): number => {
  let count = 0;
  for (
    let at = text.indexOf(token);
    at !== -1;
    at = text.indexOf(token, at + token.length)
  )
    count++;
  return count;
};

const NAME_CHAR_RE = /[\w-]/;

/**
 * The scoped name around the first occurrence of `token` in `text` that
 * `minified` no longer has whole. With identifiers off the token is the
 * bare instance id inside `bascik__<component>__<id>__<name>`, which is
 * what the author recognizes; with identifiers on the name is the hash.
 */
const splitScopedName = (
  text: string,
  minified: string,
  token: string,
): string => {
  for (
    let at = text.indexOf(token);
    at !== -1;
    at = text.indexOf(token, at + token.length)
  ) {
    let start = at;
    while (start > 0 && NAME_CHAR_RE.test(text[start - 1])) start--;
    let end = at + token.length;
    while (end < text.length && NAME_CHAR_RE.test(text[end])) end++;
    const name = text.slice(start, end);
    if (countOccurrences(minified, name) < countOccurrences(text, name))
      return name;
  }
  return token;
};

interface BuildContext {
  identifiers: boolean;
  base: string;
  dedupeCss: boolean;
  inheritAttributes: boolean;
  jsMinifier: ((code: string) => Promise<string>) | null;
  cssMinifier: ((code: string) => Promise<string>) | null;
}

/**
 * `binding` with its line counted on the file as the author wrote it. The
 * text listComponents hands over has its inline `<style>` blocks extracted
 * and, under `minify.html`, is minified, so a line counted there is wrong
 * whenever anything precedes the trigger (a style line before a binding on
 * line 2 read as line 1). The source is classified the same way; when it
 * finds the same binding, its line is the one `bascik --check` and the dev
 * log report. Without a readable source (an in-memory component) the
 * processed text's line is kept.
 */
const onAuthoredLine = async (
  binding: UnsupportedEntry,
  fileName: string | undefined,
): Promise<UnsupportedEntry> => {
  if (!fileName) return binding;
  let source: string;
  try {
    source = await readFile(fileName, "utf8");
  } catch {
    return binding;
  }
  const authored = classifyBindings(source);
  return authored &&
    authored.reason === binding.reason &&
    authored.detail === binding.detail &&
    authored.line !== undefined
    ? { ...binding, line: authored.line }
    : binding;
};

/**
 * `filePath` for a component listed as `fileName`: the form `bascik --check`
 * and the dev server print (`getDisplayPath`), relative to the component root
 * that owns the file, so every host names it the same way. A file no
 * configured root owns keeps the project-relative path; either way the
 * manifest holds no absolute path and stays byte-identical across checkouts.
 */
const manifestFilePath = (fileName: string): string => {
  // The configured roots may be absolute or project-relative, and the file
  // may be listed either way: try each spelling against them.
  const projectPath = getProjectPath(fileName);
  for (const candidate of [
    fileName,
    resolve(process.cwd(), fileName),
    projectPath,
  ]) {
    if (findComponentRoot(candidate) !== undefined)
      return getRelativePath(candidate, "components");
  }
  return projectPath;
};

/**
 * A built entry and the sidecar entries of its server and stream scripts,
 * which the caller records once the whole manifest is built.
 */
interface BuiltEntry {
  entry: ManifestEntry;
  staged: Record<string, ServerScriptEntry>;
}

const buildEntry = async (
  name: string,
  raw: ComponentList[string],
  ctx: BuildContext,
): Promise<BuiltEntry> => {
  const filePath = raw.fileName ? manifestFilePath(raw.fileName) : name;
  const refused = (unsupported: UnsupportedEntry): BuiltEntry => ({
    entry: {
      name,
      filePath,
      template: null,
      unsupported,
      css: null,
      jobs: [],
      cspStable: { style: false, script: false },
      scriptHashes: [],
    },
    staged: {},
  });
  const unsupported = (reason: UnsupportedReason, detail: string): BuiltEntry =>
    refused({ reason, detail });

  // Decided on the component text, before anything runs: a refused component
  // runs no build script and stages nothing.
  const binding = classifyBindings(raw.fileContent);
  if (binding) return refused(await onAuthoredLine(binding, raw.fileName));

  // The component as the expansion loop hands it to the scope: a fresh copy
  // with its directive scripts stamped (components read by listComponents
  // already are; this fills in components supplied some other way).
  const prepare = (): BascikComponent => {
    const component: BascikComponent = { name, ...raw };
    if (component.scopedIdNames)
      component.scopedIdNames = { ...component.scopedIdNames };
    if (component.fileName)
      component.fileContent = stampDirectiveSources(
        component.fileContent,
        component.fileName,
      );
    return component;
  };
  const inputs = scopingInputTexts(prepare());

  const recorded = recordScopingRun(prepare(), SENTINEL_ID);
  // A run that planned a CSS @import or wrote to the console is one the
  // template recorder never reuses (scoping-template.ts); neither can a
  // request-time instantiation repeat it.
  if (!recorded.clean)
    return unsupported(
      "scoping-template-unavailable",
      "its scoping run planned a CSS @import or wrote to the console, which a template cannot repeat",
    );
  const verify = runScopingPipeline(prepare(), VERIFY_ID);

  // A server or stream script is staged once for every instance, so neither
  // its scoped body nor the output scope on its open tag may depend on the
  // id (D3 step 5).
  const elements = requestScriptElements(recorded.component.fileContent);
  const verifyElements = requestScriptElements(verify.fileContent);
  if (
    elements.length !== verifyElements.length ||
    elements.some((element, index) => element !== verifyElements[index])
  )
    return unsupported(
      "instance-scoped-server-script",
      requestScriptDifference(elements, verifyElements),
    );

  // Component build scripts run once, into the template, with an empty page
  // context: the template has no page. Their output receives the component's
  // output scope exactly as at page time (D3 step 2). The second run is
  // answered by the cache the first one filled. A failing script is handled
  // by executeBuildScripts under `scripts.onBuildScriptError` exactly as on a
  // page: "error" throws, and the build halts here as documented (for a
  // component only ever returned from a server script this is the one place
  // its script runs); "warn" and "ignore" substitute the empty output every
  // page would get, so the template is what the pages are.
  let readsPageContext = false;
  const runBuildScripts = (html: string): Promise<string> =>
    HAS_BUILD_SCRIPT_RE.test(html)
      ? executeBuildScripts(html, raw.fileName, null, {
          pageFile: "",
          pagePath: "",
          sourceFile: raw.fileName,
          onReadsPageContext: () => {
            readsPageContext = true;
          },
        })
      : Promise.resolve(html);
  let textA = await runBuildScripts(recorded.component.fileContent);
  let textB = await runBuildScripts(verify.fileContent);
  if (readsPageContext)
    return unsupported(
      "build-script-reads-page-context",
      "its build script read BASCIK_PAGE_PATH, BASCIK_PAGE_FILE or BASCIK_ROUTE, so its output differs per page",
    );
  if (textA !== recorded.component.fileContent) {
    // Printed markup is part of the template. A marker it introduced would
    // be injected at request time but never at page time (the usage was
    // injected before the script printed), and usage attributes inherited
    // onto a printed root would be kept at request time but dropped at page
    // time.
    const marker = printedInjectionMarker(
      recorded.component.fileContent,
      textA,
    );
    if (marker)
      return unsupported(
        "scoping-template-unavailable",
        `its build script printed ${marker}, which a usage would be injected into at request time but never at page time`,
      );
    if (
      ctx.inheritAttributes &&
      inheritanceRootShifted(recorded.component.fileContent, textA)
    )
      return unsupported(
        "scoping-template-unavailable",
        "usage attributes would be inherited onto its printed root at request time, but the build inherits them before the script prints",
      );
  }

  // Server and stream scripts leave the template as placeholders; the sidecar
  // holds their source (never the manifest). The script elements are the
  // same in both texts (checked above), so both extractions stage the same
  // entries; the sentinel's are kept. Nothing is recorded in the registry
  // here: buildComponentManifest records them once every entry is built.
  const staged: Record<string, ServerScriptEntry> = {};
  textB = extractComponentScriptsToSidecar(textB, name, {}, { record: false });
  textA = extractComponentScriptsToSidecar(textA, name, staged, {
    record: false,
  });

  // The stylesheet as the page pipeline emits it (page-transpile.ts): dedupe
  // -> base rewrite -> `minify.css`, applied to the sentinel CSS before
  // segmentation and to the verify CSS before the prediction is compared, so
  // a per-instance block the template emits is the page's bytes (D3 step 6).
  const pipelineCss = async (
    component: BascikComponent,
  ): Promise<string | undefined> => {
    if (component.cssFileContent === undefined) return undefined;
    const combined = rewriteCssBasePaths(
      deduplicateCss([component], ctx.dedupeCss),
      ctx.base,
    );
    return ctx.cssMinifier ? await ctx.cssMinifier(combined) : combined;
  };
  const resultA: ScopingResult = {
    ...snapshotScopingResult(recorded.component),
    fileContent: textA,
    cssFileContent: await pipelineCss(recorded.component),
  };
  const template = buildScopingTemplate(
    inputs,
    SENTINEL_ID,
    recorded.calls,
    resultA,
  );
  if (!template)
    return unsupported(
      "scoping-template-unavailable",
      "its scoping run could not be recorded as a template",
    );

  // Verified with a second id before any minifier runs, as scoping-template.ts
  // verifies its templates: the prediction must equal the real pipeline.
  const hashName = ctx.identifiers ? getAttributeNameHash : identity;
  const predicted = instantiateTemplate(template, VERIFY_ID, hashName);
  const resultB: ScopingResult = {
    ...snapshotScopingResult(verify),
    fileContent: textB,
    cssFileContent: await pipelineCss(verify),
  };
  if (!predicted)
    return unsupported(
      "scoping-template-unavailable",
      "its template could not be instantiated for a second instance id",
    );
  if (!sameResult(predicted, resultB))
    return unsupported(
      "scoping-template-unavailable",
      `instantiating its template for a second instance id differs from the real scoping run in ${differingField(predicted, resultB)}`,
    );

  // `minify.js` runs on the sentinel output (D3 step 3) and the template is
  // recorded from the minified text. The minifier must have kept every
  // token: either each survives with the same count (so the minified text
  // segments as the recorded run did; byte identity of a second id is not
  // required, because a mangler such as esbuild's picks local names by
  // character frequency, string literals included), or minifying the second
  // id's real output equals the prediction (a scoped id inside a comment is
  // dropped on both sides the same way). `minify.html` is never applied
  // here: it runs per instance at request time.
  const values = replayTemplateTokens(template, SENTINEL_ID, hashName);
  if (!values)
    return unsupported(
      "scoping-template-unavailable",
      "its template's name hashes could not be replayed",
    );
  let finalTemplate = template;
  if (ctx.jsMinifier) {
    const minified = await minifyScriptTagsInHtml(textA, ctx.jsMinifier);
    if (minified !== textA) {
      const minifiedTemplate = buildScopingTemplate(
        inputs,
        SENTINEL_ID,
        recorded.calls,
        { ...resultA, fileContent: minified },
      );
      if (!minifiedTemplate)
        return unsupported(
          "scoping-template-unavailable",
          "its minify.js output could not be recorded as a template",
        );
      const split = values.find(
        (token) =>
          countOccurrences(minified, token) !== countOccurrences(textA, token),
      );
      if (split !== undefined) {
        const minifiedVerify = await minifyScriptTagsInHtml(
          textB,
          ctx.jsMinifier,
        );
        const predictedMinified = instantiateTemplate(
          minifiedTemplate,
          VERIFY_ID,
          hashName,
        );
        if (
          !predictedMinified ||
          predictedMinified.fileContent !== minifiedVerify
        )
          return unsupported(
            "scoping-template-unavailable",
            `minify.js split the scoped name ${JSON.stringify(splitScopedName(textA, minified, split))}`,
          );
      }
      finalTemplate = minifiedTemplate;
    }
  }

  // The block the renderer emits once per response, with its hash; a
  // per-instance stylesheet stays segmented in the template instead.
  const scoped = recorded.component;
  let css: ManifestCss = null;
  let styleStable = true;
  if (scoped.cssFileContent) {
    if (!ctx.dedupeCss || scoped.requiresPerInstanceCss) {
      css = { perInstance: true };
      styleStable = false;
    } else {
      const text = resultA.cssFileContent;
      if (text) {
        css = {
          text,
          hash:
            computePageCspHashes(`<style>${text}</style>`).styles[0] ??
            sha256(text),
        };
      }
    }
  }

  // A token inside a <script> body means every instance ships a different
  // script, so no single hash covers them (D3 step 7).
  const rendered = joinSegments(finalTemplate.fileContent, values);
  const ranges = scriptBodyRanges(rendered);
  const scriptStable = !tokenOffsets(finalTemplate.fileContent, values).some(
    (offset) => ranges.some(([start, end]) => offset >= start && offset < end),
  );
  const scriptHashes = scriptStable
    ? computePageCspHashes(rendered).scripts
    : [];

  // The sidecar entry's sourceFile is the source stamp's path as the builder
  // listed the component (absolute on a real build); the manifest is
  // byte-identical across builds and checkouts (D3 step 8), so the job
  // carries the project-relative form the sidecar entries use.
  const jobs: ManifestJob[] = Object.values(staged).map((entry, index) => ({
    id: entry.id,
    mode: entry.mode,
    ordinal: index + 1,
    ...(entry.sourceFile !== undefined
      ? { sourceFile: getProjectPath(entry.sourceFile) }
      : {}),
    ...(entry.sourceLine !== undefined ? { sourceLine: entry.sourceLine } : {}),
    ...(entry.outputScope !== undefined
      ? { outputScope: entry.outputScope }
      : {}),
  }));

  return {
    entry: {
      name,
      filePath,
      template: finalTemplate,
      css,
      jobs,
      cspStable: { style: styleStable, script: scriptStable },
      scriptHashes,
    },
    staged,
  };
};

/**
 * How many components build at once. Their build scripts already share the
 * process-wide child budget; this only bounds what waits on it.
 */
const MANIFEST_BUILD_CONCURRENCY = 8;

/** Options for {@link buildComponentManifest}. */
export interface ManifestBuildOptions {
  /**
   * Output is held until this settles: a build starts the manifest while
   * pages are still compiling, and its warnings come out where a manifest
   * built after the pages would print them (see ordered-output.ts).
   */
  gate?: Promise<unknown>;
}

/**
 * Record a manifest entry for every component in `componentList` under the
 * build config `config` (the global `BascikConfig`, which the scoping
 * pipeline also reads). Component server and stream scripts are staged in
 * `serverSidecarRegistry` once every entry is built, so the caller can write
 * them to the sidecar under the `components` owner; a build that fails
 * stages none.
 */
export const buildComponentManifest = async (
  componentList: ComponentList,
  config: ManifestBuildConfig,
  { gate }: ManifestBuildOptions = {},
): Promise<ComponentManifest> => {
  const ctx: BuildContext = {
    identifiers: Boolean(config.minify?.identifiers),
    base: config.base ?? "/",
    dedupeCss: config.scoping?.deduplicateCss ?? true,
    inheritAttributes: Boolean(config.scoping?.inheritAttributes),
    jsMinifier: resolveScriptMinifier(),
    cssMinifier: resolveCssMinifier(),
  };
  const names = Object.keys(componentList).sort();
  const built = await inOrder(
    names.length,
    (index) => buildEntry(names[index], componentList[names[index]], ctx),
    { concurrency: MANIFEST_BUILD_CONCURRENCY, gate },
  );
  const components: Record<string, ManifestEntry> = {};
  names.forEach((name, index) => {
    components[name] = built[index].entry;
    serverSidecarRegistry.recordScripts(built[index].staged);
  });
  return {
    schema: COMPONENT_MANIFEST_SCHEMA_VERSION,
    identifiers: ctx.identifiers,
    minifyHtml: Boolean(config.minify?.html),
    base: ctx.base,
    inheritAttributes: ctx.inheritAttributes,
    components,
  };
};

/**
 * A build's manifest started while its pages are still compiling. The
 * manifest depends only on the component list and the config, so it can
 * run beside the page workers instead of after them; its output is held
 * until the build takes it, so it prints where it always did.
 */
let earlyManifest: {
  componentList: ComponentList;
  config: ManifestBuildConfig;
  open: () => void;
  manifest: Promise<ComponentManifest>;
} | null = null;

/**
 * Start building the manifest for `componentList` now, once: the build
 * calls this as soon as a page has a server or stream script, which is what
 * makes a manifest necessary (D1). {@link takeComponentManifest} collects it.
 */
export const startComponentManifest = (
  componentList: ComponentList,
  config: ManifestBuildConfig,
): void => {
  if (earlyManifest) return;
  const gate = Promise.withResolvers<void>();
  const manifest = buildComponentManifest(componentList, config, {
    gate: gate.promise,
  });
  // Reported by takeComponentManifest; a build that fails before taking it
  // never reports it, as a build that never built it would not.
  manifest.catch(() => {});
  earlyManifest = { componentList, config, open: gate.resolve, manifest };
};

/**
 * The manifest for `componentList`: the one started early for this list
 * and config, its held output written now, or one built here.
 */
export const takeComponentManifest = (
  componentList: ComponentList,
  config: ManifestBuildConfig,
): Promise<ComponentManifest> => {
  const early = earlyManifest;
  earlyManifest = null;
  if (
    early &&
    early.componentList === componentList &&
    early.config === config
  ) {
    early.open();
    return early.manifest;
  }
  // Started for another list (the components changed since): its output is
  // never written, and the current list is built from scratch.
  return buildComponentManifest(componentList, config);
};
