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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rewriteCssBasePaths } from "./base-path.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { scanWholeAttributes } from "./component-attribute-scan.ts";
import { computePageCspHashes } from "./csp-hashes.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { getProjectPath } from "./file-system.ts";
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
  type ServerScriptEntry,
  type ServerScriptMode,
} from "./server-sidecar.ts";
import { maskElementContents } from "./shielding.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { deduplicateCss } from "./styles.ts";
import type {
  BascikComponent,
  ComponentList,
  MinifyOptions,
  ScopingOptions,
} from "./types.ts";

export const COMPONENT_MANIFEST_SCHEMA_VERSION = 1;

export type UnsupportedReason =
  | "attr-binding-to-scoped-attribute"
  | "instance-scoped-server-script"
  | "build-script-reads-page-context"
  | "attr-src-on-directive-script"
  | "scoping-template-unavailable";

/** A server or stream script of a component, staged once in the sidecar. */
export interface ManifestJob {
  id: string;
  mode: ServerScriptMode;
  /** 1-based position among the component's server and stream scripts. */
  ordinal: number;
  sourceFile?: string;
  sourceLine?: number;
  /** The encoded `data-bascik-output-scope` the runner applies to the job's output. */
  outputScope?: string;
}

/**
 * The component's stylesheet as the page pipeline emits it: `text` is the
 * exact bytes (dedupe -> base rewrite -> `minify.css`) and `hash` the CSP
 * hash of `<style>text</style>`. `perInstance` when the CSS embeds the
 * instance id (`url(#id)`, or `scoping.deduplicateCss: false`), in which case
 * it stays segmented in `template.cssFileContent`. Null without a stylesheet.
 */
export type ManifestCss =
  { text: string; hash: string } | { perInstance: true } | null;

/**
 * Why a component is left unexpanded at request time. `reason` is the D7
 * category a renderer and `bascik --check` key on; `detail` says what in
 * this component triggered it (several distinct refusals share a reason, and
 * the reason alone gives the author nothing to change); `line` is the
 * 1-based line of the offending open tag in `filePath` when one is known.
 */
export interface UnsupportedEntry {
  reason: UnsupportedReason;
  detail?: string;
  line?: number;
}

export const UNSUPPORTED_REASONS: ReadonlySet<string> =
  new Set<UnsupportedReason>([
    "attr-binding-to-scoped-attribute",
    "instance-scoped-server-script",
    "build-script-reads-page-context",
    "attr-src-on-directive-script",
    "scoping-template-unavailable",
  ]);

export interface ManifestEntry {
  name: string;
  /** Project-relative path of the component file, for diagnostics. */
  filePath: string;
  template: ScopingTemplate | null;
  unsupported?: UnsupportedEntry;
  css: ManifestCss;
  jobs: ManifestJob[];
  /**
   * Whether every instance emits the same style block and the same client
   * script bodies, so one set of CSP hashes covers all of them (D5).
   */
  cspStable: { style: boolean; script: boolean };
  /** The first instance's client script hashes when `cspStable.script`. */
  scriptHashes: string[];
}

export interface ComponentManifest {
  schema: number;
  /** `minify.identifiers` at build time: picks the name hash at request time. */
  identifiers: boolean;
  minifyHtml: boolean;
  base: string;
  inheritAttributes: boolean;
  components: Record<string, ManifestEntry>;
}

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

const buildEntry = async (
  name: string,
  raw: ComponentList[string],
  ctx: BuildContext,
): Promise<ManifestEntry> => {
  const filePath = raw.fileName ? getProjectPath(raw.fileName) : name;
  const refused = (unsupported: UnsupportedEntry): ManifestEntry => ({
    name,
    filePath,
    template: null,
    unsupported,
    css: null,
    jobs: [],
    cspStable: { style: false, script: false },
    scriptHashes: [],
  });
  const unsupported = (
    reason: UnsupportedReason,
    detail: string,
  ): ManifestEntry => refused({ reason, detail });

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
  // same in both texts (checked above), so both extractions record the same
  // entries; the sentinel's is recorded last and is what the registry keeps.
  const staged: Record<string, ServerScriptEntry> = {};
  textB = extractComponentScriptsToSidecar(textB, name, {});
  textA = extractComponentScriptsToSidecar(textA, name, staged);

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
  // carries the project-relative form, like `filePath`.
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
    name,
    filePath,
    template: finalTemplate,
    css,
    jobs,
    cspStable: { style: styleStable, script: scriptStable },
    scriptHashes,
  };
};

/**
 * Record a manifest entry for every component in `componentList` under the
 * build config `config` (the global `BascikConfig`, which the scoping
 * pipeline also reads). Component server and stream scripts are staged in
 * `serverSidecarRegistry` as a side effect, so the caller can write them to
 * the sidecar under the `components` owner.
 */
export const buildComponentManifest = async (
  componentList: ComponentList,
  config: ManifestBuildConfig,
): Promise<ComponentManifest> => {
  const ctx: BuildContext = {
    identifiers: Boolean(config.minify?.identifiers),
    base: config.base ?? "/",
    dedupeCss: config.scoping?.deduplicateCss ?? true,
    inheritAttributes: Boolean(config.scoping?.inheritAttributes),
    jsMinifier: resolveScriptMinifier(),
    cssMinifier: resolveCssMinifier(),
  };
  const components: Record<string, ManifestEntry> = {};
  // Sequential: a component's second run is answered by the cache its first
  // run filled, and console output stays in component order.
  for (const name of Object.keys(componentList).sort()) {
    components[name] = await buildEntry(name, componentList[name], ctx);
  }
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
 * The CSP hashes any request-rendered instance of a manifest component can
 * contribute to a page (D5): the style hash of every component whose block
 * is the same for every instance, and the first-instance script hashes of
 * every component whose scripts are. Deduplicated and sorted.
 */
export const manifestCspHashes = (
  manifest: ComponentManifest,
): { scripts: string[]; styles: string[] } => {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const entry of Object.values(manifest.components)) {
    if (entry.unsupported) continue;
    if (entry.cspStable.style && entry.css && "hash" in entry.css)
      styles.add(entry.css.hash);
    if (entry.cspStable.script)
      for (const hash of entry.scriptHashes) scripts.add(hash);
  }
  const sorted = (hashes: Set<string>) =>
    [...hashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { scripts: sorted(scripts), styles: sorted(styles) };
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
};

/**
 * The manifest with every object's keys sorted, so `JSON.stringify` of it is
 * byte-identical across builds (D3 step 8). The ownership transaction stages
 * this through `stageJsonArtifact`; `writeComponentManifest` writes the same
 * bytes directly.
 */
export const sortedComponentManifest = (
  manifest: ComponentManifest,
): ComponentManifest => sortKeysDeep(manifest) as ComponentManifest;

export const componentManifestPath = (distDir: string): string =>
  join(distDir, ".bascik", "components.json");

export const writeComponentManifest = async (
  distDir: string,
  manifest: ComponentManifest,
): Promise<string> => {
  const path = componentManifestPath(distDir);
  await mkdir(join(distDir, ".bascik"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(sortedComponentManifest(manifest), null, 2),
    "utf8",
  );
  return path;
};

const rebuildHint =
  "Run `bascik --build` to regenerate dist/.bascik/components.json.";

/**
 * Read `dist/.bascik/components.json`. Null when absent (a static release
 * has none); a manifest of another schema or one that does not parse is a
 * stale build and throws the rebuild message, like the sidecar.
 */
export const readComponentManifest = async (
  distDir: string,
): Promise<ComponentManifest | null> => {
  const path = componentManifestPath(distDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `[bascik] component manifest at ${path} could not be read: ${(err as Error).message}. ${rebuildHint}`,
    );
  }
  let parsed: Partial<ComponentManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<ComponentManifest>;
  } catch (err) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (${(err as Error).message}). ${rebuildHint}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (not an object). ${rebuildHint}`,
    );
  }
  if (parsed.schema !== COMPONENT_MANIFEST_SCHEMA_VERSION) {
    // JSON.stringify keeps a string "1" distinguishable from the number 1.
    throw new Error(
      `[bascik] component manifest at ${path} uses schema ${JSON.stringify(parsed.schema)}, ` +
        `but this runtime understands schema ${COMPONENT_MANIFEST_SCHEMA_VERSION}. ${rebuildHint}`,
    );
  }
  if (
    !parsed.components ||
    typeof parsed.components !== "object" ||
    Array.isArray(parsed.components)
  ) {
    throw new Error(
      `[bascik] component manifest at ${path} is malformed (no "components" member). ${rebuildHint}`,
    );
  }
  // Each entry is validated here, like the sidecar loader validates its
  // entries, so a hand-edited or truncated entry is a located rebuild message
  // and never a TypeError in whoever dereferences it (check.ts, phase 3's
  // renderer).
  for (const [name, entry] of Object.entries(parsed.components)) {
    const problem = manifestEntryProblem(entry);
    if (problem) {
      throw new Error(
        `[bascik] component manifest at ${path} is malformed (entry "${name}" ${problem}). ${rebuildHint}`,
      );
    }
  }
  return parsed as ComponentManifest;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What makes `entry` not a `ManifestEntry`, or null when it is one. */
const manifestEntryProblem = (entry: unknown): string | null => {
  if (!isPlainObject(entry)) return "is not an object";
  if (typeof entry.name !== "string") return 'has no "name"';
  if (typeof entry.filePath !== "string") return 'has no "filePath"';
  if (entry.template !== null && !isPlainObject(entry.template))
    return 'has a "template" that is neither an object nor null';
  if (entry.unsupported !== undefined) {
    if (!isPlainObject(entry.unsupported))
      return 'has a malformed "unsupported"';
    if (!UNSUPPORTED_REASONS.has(String(entry.unsupported.reason)))
      return `has an unknown unsupported reason ${JSON.stringify(entry.unsupported.reason)}`;
    if (
      entry.unsupported.detail !== undefined &&
      typeof entry.unsupported.detail !== "string"
    )
      return 'has a non-string "unsupported.detail"';
    if (
      entry.unsupported.line !== undefined &&
      typeof entry.unsupported.line !== "number"
    )
      return 'has a non-numeric "unsupported.line"';
  }
  if (entry.css !== null && !isPlainObject(entry.css))
    return 'has a "css" that is neither an object nor null';
  if (!Array.isArray(entry.jobs)) return 'has no "jobs" array';
  if (
    !isPlainObject(entry.cspStable) ||
    typeof entry.cspStable.style !== "boolean" ||
    typeof entry.cspStable.script !== "boolean"
  )
    return 'has no "cspStable" with boolean "style" and "script"';
  if (!Array.isArray(entry.scriptHashes)) return 'has no "scriptHashes" array';
  return null;
};
