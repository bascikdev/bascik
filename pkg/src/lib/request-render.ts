/**
 * @module request-render
 *
 * Request-time component rendering (prompt 157, D4): a server or stream
 * script may return component tags, and `wrapRunner` wraps a host's
 * `ScriptJobRunner` so that each job's output is expanded by the compiler's
 * own loop (component-expansion-core.ts) with the build-time manifest as its
 * scope. The renderer is therefore the compiler, not a second scanner: every
 * masking, slot, prop and nesting rule the build applies to page markup
 * applies to script output.
 *
 * Per request, the wrapper keeps one state object (issued ids, the nested-job
 * budget, which component stylesheets were emitted, and a per-mode decision
 * chain) and, per page job:
 *
 * 1. runs the host's job; output without a `<` is returned untouched;
 * 2. expands the output with `manifestScope`: each supported component's
 *    `ScopingTemplate` is instantiated for a fresh request id by replaying
 *    its recorded name hashes (scoping-instantiate.ts), and the component's
 *    staged server and stream scripts are replaced by request-local markers;
 *    each expanded top-level usage then gets the build's base-path rewrite
 *    and, under `minify.html`, the build's minification as it would apply
 *    where the usage sits in the page (inside a `<pre>`, a table, ...), with
 *    client scripts hoisted to the end of that outermost instance;
 * 3. runs the marked nested jobs through `host.runComponentJob` with the
 *    parent's remaining budget and the runner's own signal, renders their
 *    output the same way (nested components, bounded depth), and splices
 *    each at its marker; a nested `stream` script resolves with its parent;
 * 4. decides, in dispatch order per mode, which component stylesheets this
 *    job must carry, and prepends them to the job's output so every
 *    stylesheet is in the body before the first instance it styles.
 *
 * Security: only markers minted in step 2 are ever dispatched. A directive
 * script, a guessed `server_script_*` or `component_script_*` placeholder, or
 * a marker-shaped comment in the author's output (props and slot content
 * included) is inert text and passes through verbatim, as it does today.
 * Unsupported and unknown tags pass through verbatim too; a dev host hears
 * about them once per (route, tag).
 *
 * This module must stay portable: no `node:*` imports, no `process`, no
 * `Buffer`, no config module. `serverless-contract.test.ts` bundles it for a
 * Web platform and fails on any Node reference.
 */
import { rewriteHtmlBasePaths } from "./base-path.ts";
import {
  createAttributeValueScanner,
  type ComponentSearchState,
} from "./component-attribute-scan.ts";
import {
  ComponentExpansionLimitError,
  expandComponents,
  type ExpandOptions,
} from "./component-expansion-core.ts";
import { maskRawTextContent } from "./component-masking.ts";
import { getFirstComponent } from "./component-tags.ts";
import { getHtmlAttributeValue } from "./html-patterns.ts";
import {
  DOCUMENT_FRAGMENT_CONTEXT,
  fragmentContexts,
  fragmentEdges,
  leadingCollapsibleWhitespace,
  trailingCollapsibleWhitespace,
  minifyHtmlFragment,
  type FragmentContext,
} from "./html-minifier.ts";
import {
  applyScopingResult,
  instantiateTemplate,
} from "./scoping-instantiate.ts";
import type { ComponentManifest, ManifestEntry } from "./component-manifest.ts";
import type {
  ExecutionPlan,
  ScriptJobRunner,
  ScriptMode,
} from "./request-execution.ts";
import type { BascikComponent, ComponentList } from "./types.ts";

/**
 * What one request may spend on component rendering. Instances and size are
 * per script output (a runaway output is one job's fault); depth and nested
 * jobs are per response (a nested job is itself a script output).
 */
export const REQUEST_RENDER_LIMITS = {
  /** Component instances one script output may expand to. */
  maxInstances: 1000,
  /**
   * Rendered size of one script output that has components in it, in
   * characters (UTF-16 code units, 4 Mi of them). An output with no
   * component tag is never measured: it is the author's, as before.
   */
  maxOutputChars: 4 * 1024 * 1024,
  /** How deep output-returns-component-returns-output may nest. */
  maxDepth: 4,
  /** Nested component scripts one response may run. */
  maxNestedJobs: 64,
} as const;

/** Host-neutral dependencies of the renderer (D4). */
export interface RenderHost {
  manifest: ComponentManifest | null;
  /**
   * The scoped-name hash: identity when the manifest was built without
   * `minify.identifiers`, the build's attribute-name hash otherwise (Node:
   * `getAttributeNameHash`; a Worker: sha256 under `nodejs_compat`).
   */
  hashName: (input: string) => string;
  /** A hex digest for instance ids and markers (sha256 hex on every host). */
  hashHex: (input: string) => string;
  /** The request's route, for ids and diagnostics. */
  httpPath: string;
  /** The page job budget; nested jobs get what is left of it. */
  timeoutMs: number;
  /**
   * Run one staged component script. The host applies its own
   * `onServerScriptError` policy, as it does for page jobs: a throw here
   * fails the parent job (a 500 for a `server` parent before commit, an
   * empty slot for a `stream` parent).
   */
  runComponentJob: (
    id: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<string>;
  /** Dev only: log `message` the first time `key` is seen. Production hosts omit it. */
  warnOnce?: (key: string, message: string) => void;
  /**
   * `createExternalTagMatcher(components.external)`: silences the dev log
   * for a tag no component defines. A real component with the same name
   * still expands, and an unsupported one is still logged, as at build time
   * (external-components.ts).
   */
  externalTags: (tag: string) => boolean;
}

/**
 * A budget, depth or stage failure while rendering one script output. The
 * message names the route and, when one is involved, the component file.
 */
export class RequestRenderError extends Error {
  readonly httpPath: string;
  readonly componentFile: string | undefined;

  // Plain fields, not parameter properties: the sources also run under
  // Node's own type stripping, which rejects non-erasable syntax.
  constructor(message: string, httpPath: string, componentFile?: string) {
    super(message);
    this.name = "RequestRenderError";
    this.httpPath = httpPath;
    this.componentFile = componentFile;
  }
}

/**
 * The route a host gives the renderer as `httpPath`: the request URL's
 * pathname, percent-decoded the way page lookup decodes it, so every
 * spelling of one route (`/catalog`, `/c%61talog`) salts the same ids. A
 * host that passed the raw pathname would mint new ids, and new names to
 * hash, for each spelling a client invents, and Node (which sees the raw
 * path) and workerd (which sees a normalized one) would disagree. A
 * malformed escape is kept as written; routing refuses it anyway.
 */
export const requestRoutePath = (url: string): string => {
  const pathname = new URL(url).pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

/** The request id shape: `r` + 7 hex, disjoint from the build's 8 hex (D2). */
export const REQUEST_INSTANCE_ID_RE = /^r[0-9a-f]{7}$/;

/**
 * Mint the request-time instance id for the `ordinal`-th instance of
 * `componentName` in the output of job `jobId` on `httpPath`, salted like
 * `deriveInstanceId` against the ids already issued for the request. The job
 * id (for a nested job's output, its parent's key and marker site) and a
 * per-job ordinal make it deterministic regardless of the order in which
 * jobs complete; the shape keeps it disjoint from every build id.
 */
export const requestInstanceId = (
  hashHex: (input: string) => string,
  httpPath: string,
  jobId: string,
  componentName: string,
  ordinal: number,
  issuedIds: Set<string>,
): string => {
  const base = `${httpPath}::job:${jobId}::${componentName}::${ordinal}`;
  let attempt = 0;
  while (true) {
    const input = attempt === 0 ? base : `${base}::salt:${attempt}`;
    const id = `r${hashHex(input).slice(0, 7)}`;
    if (!issuedIds.has(id)) {
      issuedIds.add(id);
      return id;
    }
    attempt++;
  }
};

const hasOwn = (map: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

const SINGLE_ID_TARGET_RE =
  /^(?:form|list|popovertarget|commandfor|aria-activedescendant|aria-errormessage)$/i;
const ID_LIST_TARGET_RE =
  /^(?:for|headers|itemref|aria-(?:labelledby|describedby|controls|owns|flowto|details))$/i;
const FRAGMENT_TARGET_RE = /^(?:xlink:)?href$/i;

/**
 * Map a bound attribute value through the instance's scoped id names, per
 * target attribute, exactly where the build's id-reference rewrite
 * (id-references.ts) would have: a fragment `href`, the single-id attributes,
 * and the whitespace-separated id lists, token by token. Every other target
 * is text. The build decides some of these per element (`for` on a label,
 * `href` on an anchor); the manifest refuses a binding on any other element
 * (component-manifest.ts), so the target alone decides here.
 */
export const rewriteIdReferenceTarget = (
  target: string,
  value: string,
  scopedIdNames: Record<string, string>,
): string => {
  if (FRAGMENT_TARGET_RE.test(target)) {
    if (!value.startsWith("#") || value.length === 1) return value;
    const id = value.slice(1);
    return hasOwn(scopedIdNames, id) ? `#${scopedIdNames[id]}` : value;
  }
  if (SINGLE_ID_TARGET_RE.test(target)) {
    return hasOwn(scopedIdNames, value) ? scopedIdNames[value] : value;
  }
  if (ID_LIST_TARGET_RE.test(target)) {
    return value.replace(/\S+/g, (id) =>
      hasOwn(scopedIdNames, id) ? scopedIdNames[id] : id,
    );
  }
  return value;
};

/**
 * The entries a renderer can expand: recorded as a template, not refused.
 * The one predicate for "this manifest has something to render": the
 * renderer, the core's adapter warning and the Cloudflare build's stub
 * decision all use it, so they cannot disagree.
 */
export const isRenderable = (
  entry: ManifestEntry,
): entry is ManifestEntry & {
  template: NonNullable<ManifestEntry["template"]>;
} => entry.template !== null && entry.unsupported === undefined;

export const manifestHasComponents = (
  manifest: ComponentManifest | null | undefined,
): manifest is ComponentManifest =>
  Boolean(manifest) && Object.values(manifest!.components).some(isRenderable);

/**
 * The expansion loop's component list for a manifest: only renderable
 * entries, so an unsupported or unknown tag is never found and passes
 * through verbatim. The text is a stand-in; `manifestScope` replaces it with
 * the instantiated template before anything reads it. Cached per manifest
 * object: `getFirstComponent` keys its compiled tag regex on the list.
 */
const componentLists = new WeakMap<ComponentManifest, ComponentList>();
const componentListFor = (manifest: ComponentManifest): ComponentList => {
  let list = componentLists.get(manifest);
  if (!list) {
    list = {};
    for (const [name, entry] of Object.entries(manifest.components)) {
      if (!isRenderable(entry)) continue;
      list[name] = { fileName: entry.filePath, fileContent: "<!---->" };
    }
    componentLists.set(manifest, list);
  }
  return list;
};

/** One top-level component usage in a script output. */
export interface UsageSpan {
  name: string;
  start: number;
  end: number;
}

/**
 * Finishes the expanded top-level usages before they are spliced back (the
 * request path's base-path rewrite and minification). Called once per
 * output with every usage and its expansion, in order, so it can read the
 * output around them in one pass and an adjacent usage's expansion as its
 * neighbor; returns the finished pieces.
 */
export type UsageFinalizer = (
  html: string,
  spans: readonly UsageSpan[],
  pieces: readonly string[],
) => string[];

/**
 * Expand `html` one top-level usage at a time: the usages are located in one
 * linear pass over the output (and its mask, computed once), and each usage's
 * own text is expanded by the loop as a string of its own size, nested
 * components included.
 *
 * The loop splices every instance into the whole page and searches it again
 * from the instance start, which V8 pays for by flattening the page (and its
 * mask) on each search: a 2 MiB output with a thousand instances copies
 * gigabytes. A build page is small; a script output is bounded only by the
 * render budget, so the renderer keeps the loop's cost per usage instead.
 * Expansion order, ordinals, ids and the usage extents are the loop's own
 * (the search and the mask are the loop's), so the bytes are identical;
 * what differs is only what a malformed template could reach past its own
 * instance (an unclosed nested tag, raw-text element or comment), which
 * stays inside the instance here.
 *
 * Both limits are the whole output's, as in one loop over it: each usage
 * gets what is left of the substitution allowance, and of the size
 * tripwire after the text already emitted and the author's text still to
 * come, so many usages that each grow (a component that places its slot
 * twice, nested) are stopped at the output's size, not each at its own.
 */
export const expandByUsage = (
  html: string,
  componentList: ComponentList,
  opts: ExpandOptions,
  usedComponents: BascikComponent[] = [],
  finalize?: UsageFinalizer,
): string => {
  const masked = maskRawTextContent(html);
  const searchState: ComponentSearchState = {};
  const spans: UsageSpan[] = [];
  let cursor = 0;
  while (true) {
    const found = getFirstComponent(
      html,
      componentList,
      masked,
      cursor,
      searchState,
    ) as Partial<BascikComponent> & { startIndex?: number; endIndex?: number };
    if (
      !found.name ||
      typeof found.startIndex !== "number" ||
      typeof found.endIndex !== "number"
    )
      break;
    spans.push({
      name: found.name,
      start: found.startIndex,
      end: found.endIndex,
    });
    cursor = found.endIndex;
  }
  if (spans.length === 0) return html;
  const { maxSubstitutions, maxOutputBytes } = opts.limits;
  // The loop checks the size before its first search too.
  if (html.length > maxOutputBytes)
    throw new ComponentExpansionLimitError(0, `<${spans[0].name}>`);
  const pieces: string[] = [];
  const expanded: string[] = [];
  let emitted = 0;
  cursor = 0;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    // The loop counts substitutions per call and trips before it searches
    // again, so each usage gets what is left of the whole output's allowance.
    const remaining = maxSubstitutions - usedComponents.length;
    if (remaining <= 0)
      throw new ComponentExpansionLimitError(
        usedComponents.length,
        `<${span.name}>`,
      );
    const lead = html.slice(cursor, span.start);
    pieces.push(lead);
    emitted += lead.length;
    const piece = expandComponents(
      html.slice(span.start, span.end),
      componentList,
      {
        ...opts,
        limits: {
          maxSubstitutions: remaining,
          maxOutputBytes: maxOutputBytes - emitted - (html.length - span.end),
        },
      },
      usedComponents,
    ).transpiledHtmlBody;
    expanded.push(piece);
    pieces.push("");
    emitted += piece.length;
    cursor = span.end;
  }
  pieces.push(html.slice(cursor));
  // Pieces alternate: author text, usage, author text, ..., author text.
  const finished = finalize ? finalize(html, spans, expanded) : expanded;
  for (let index = 0; index < finished.length; index++)
    pieces[2 * index + 1] = finished[index];
  return pieces.join("");
};

/**
 * The request path's finish for each expanded top-level usage. The build
 * rewrites base paths in, then minifies, the whole page once
 * (page-transpile.ts); each usage gets the same, as the build would apply
 * it where the usage sits: `outer` is where the output sits in the page,
 * and the output around each usage says the rest. A nested instance is
 * finished with its outermost one, so a `<pre>` in a parent template keeps
 * a child's whitespace. Undefined when there is nothing to do.
 */
export const usageFinalizer = (
  manifest: ComponentManifest,
  outer: FragmentContext = DOCUMENT_FRAGMENT_CONTEXT,
): UsageFinalizer | undefined =>
  manifest.minifyHtml || manifest.base !== "/"
    ? (html, spans, pieces) => {
        const rebased = pieces.map((piece) =>
          rewriteHtmlBasePaths(piece, manifest.base),
        );
        if (!manifest.minifyHtml) return rebased;
        const contexts = fragmentContexts(html, spans, outer);
        // Two usages written next to each other are each other's neighbors
        // in the page as their instances, not as their usage tags.
        const edges = new Map<number, ReturnType<typeof fragmentEdges>>();
        const edgesOf = (index: number) => {
          let found = edges.get(index);
          if (!found) edges.set(index, (found = fragmentEdges(rebased[index])));
          return found;
        };
        const finished = rebased.map((piece, index) => {
          const context = { ...contexts[index] };
          if (context.beforeIsSpan) {
            const last = edgesOf(index - 1).last;
            if (last !== "none") context.before = last;
          }
          if (context.afterIsSpan) {
            const first = edgesOf(index + 1).first;
            if (first !== "none") context.after = first;
          }
          return minifyHtmlFragment(piece, context);
        });
        // Whitespace at the end of one instance and the start of the next,
        // written with nothing between them, is one text run in the built
        // page and collapses to one space; outside a <pre> it is kept once.
        for (let index = 1; index < finished.length; index++) {
          const context = contexts[index];
          if (
            context.inPre ||
            context.verbatim ||
            spans[index].start !== spans[index - 1].end ||
            trailingCollapsibleWhitespace(finished[index - 1]) === 0
          )
            continue;
          finished[index] = finished[index].slice(
            leadingCollapsibleWhitespace(finished[index]),
          );
        }
        return finished;
      }
    : undefined;

/**
 * The staged placeholder of a component job inside an instantiated template,
 * as server-sidecar.ts writes it. The optional stream marker and the attribute
 * order are fixed by the writer; quotes are matched loosely in case a later
 * sidecar writer changes them.
 */
const PLACEHOLDER_RE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*<\/script\s*>/gi;

const JOB_ATTRIBUTE = "data-bascik-job";

/** The marker element nested job `n` of this request is spliced at. */
const jobMarker = (nonce: string, n: number): string =>
  `<script type="text/bascik-server" ${JOB_ATTRIBUTE}="${nonce}:${n}"></script>`;

/**
 * Component tags left in rendered output, as page-transpile.ts finds them
 * after a build. Tags inside comments, raw-text elements and attribute
 * values are text.
 */
const UNRESOLVED_TAG_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/gi;

interface JobMarker {
  n: number;
  id: string;
  entry: ManifestEntry;
}

interface MarkerSite {
  start: number;
  end: number;
  n: number;
}

interface RenderedFragment {
  html: string;
  /** Every expanded instance, parent instances first, in document order. */
  used: BascikComponent[];
}

interface RequestState {
  issuedIds: Set<string>;
  jobsRun: number;
  emittedCss: Set<string>;
  cssChain: Record<ScriptMode, Promise<void>>;
  nonce: string;
}

let nonceCounter = 0;

/**
 * Where each script segment sits in its page, for `minify.html`: one scan of
 * the page's static text per plan object, which a host keeps per stored
 * page, so a request reads it from here.
 */
const planContexts = new WeakMap<ExecutionPlan, Map<string, FragmentContext>>();
const segmentContextsFor = (
  plan: ExecutionPlan,
): Map<string, FragmentContext> => {
  let contexts = planContexts.get(plan);
  if (!contexts) {
    const decoder = new TextDecoder();
    let page = "";
    const spans: { start: number; end: number }[] = [];
    const ids: string[] = [];
    for (const segment of plan.segments) {
      if (segment.kind === "static") page += decoder.decode(segment.bytes);
      else {
        spans.push({ start: page.length, end: page.length });
        ids.push(segment.id);
      }
    }
    const found = fragmentContexts(page, spans);
    contexts = new Map(ids.map((id, index) => [id, found[index]]));
    planContexts.set(plan, contexts);
  }
  return contexts;
};

/**
 * Wrap a page-job runner so component tags in its output are rendered. The
 * runner itself is returned when the manifest is null or has nothing to
 * render: a static site, or one whose components are all unsupported, pays
 * nothing. One wrapper serves one request.
 */
export const wrapRunner = (
  run: ScriptJobRunner,
  plan: ExecutionPlan,
  host: RenderHost,
): ScriptJobRunner => {
  const manifest = host.manifest;
  if (!manifestHasComponents(manifest)) return run;
  const list = componentListFor(manifest);
  const modes = new Map<string, ScriptMode>();
  for (const segment of plan.segments) {
    if (segment.kind === "script") modes.set(segment.id, segment.mode);
  }
  const state: RequestState = {
    issuedIds: new Set(),
    jobsRun: 0,
    emittedCss: new Set(),
    cssChain: { server: Promise.resolve(), stream: Promise.resolve() },
    // Request-local, so no author text can spell a marker: the time, a
    // counter and a random draw are hashed, never exposed.
    nonce: host
      .hashHex(
        `${host.httpPath}\u0000${Date.now()}\u0000${++nonceCounter}\u0000${Math.random()}`,
      )
      .slice(0, 32),
  };
  const { httpPath } = host;
  const limits = REQUEST_RENDER_LIMITS;

  const located = (entry: ManifestEntry | undefined, line?: number) =>
    entry
      ? ` (<${entry.name}>, ${entry.filePath}${line !== undefined ? `:${line}` : ""})`
      : "";
  const lastEntry = (used: BascikComponent[]) =>
    used.length ? manifest.components[used[used.length - 1].name] : undefined;

  /**
   * Instantiate the component's template for `instanceId` and mark its
   * staged scripts. Returns null, leaving the usage as written, when the
   * computed names collide (which the template cannot represent).
   */
  const manifestScope = (
    component: BascikComponent,
    instanceId: string,
    markers: JobMarker[],
    mode: ScriptMode,
  ): BascikComponent | null => {
    const entry = manifest.components[component.name];
    if (!entry || !isRenderable(entry)) return null;
    const result = instantiateTemplate(
      entry.template,
      instanceId,
      host.hashName,
    );
    if (!result) {
      host.warnOnce?.(
        `${httpPath}::collision:<${entry.name}>`,
        `[bascik] Component tag <${entry.name}> in ${mode}-script output at "${httpPath}" is left unexpanded: ` +
          `the scoped names computed for instance ${instanceId} of ${entry.filePath} collide with each other.`,
      );
      return null;
    }
    // The usage object is fresh per search and carries the splice offsets the
    // loop reads back, so it is scoped in place, as the build's scope does.
    const scoped = applyScopingResult(component, result);
    if (entry.jobs.length > 0) {
      const jobIds = new Map(entry.jobs.map((job) => [job.id, job]));
      scoped.fileContent = scoped.fileContent.replace(
        PLACEHOLDER_RE,
        (element: string, attrs: string) => {
          const openTag = `<script${attrs}>`;
          if (
            getHtmlAttributeValue(openTag, "type")?.toLowerCase() !==
            "text/bascik-server"
          )
            return element;
          const id = getHtmlAttributeValue(openTag, "data-bascik-server-id");
          if (!id || !jobIds.has(id)) return element;
          const n = markers.length;
          markers.push({ n, id, entry });
          return jobMarker(state.nonce, n);
        },
      );
    }
    return scoped;
  };

  /** Where this request's markers are in `html`, in document order. */
  const findMarkerSites = (html: string): MarkerSite[] => {
    const sites: MarkerSite[] = [];
    if (!html.includes(state.nonce)) return sites;
    const prefix = `${state.nonce}:`;
    const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const value = getHtmlAttributeValue(`<script${match[1]}>`, JOB_ATTRIBUTE);
      if (!value || !value.startsWith(prefix)) continue;
      const n = Number(value.slice(prefix.length));
      if (!Number.isInteger(n)) continue;
      sites.push({ start: match.index, end: match.index + match[0].length, n });
    }
    return sites;
  };

  /** Dev only: one log per (route, tag) for a tag the manifest cannot expand. */
  const warnUnresolved = (html: string, mode: ScriptMode): void => {
    const masked = maskRawTextContent(html);
    const scanner = createAttributeValueScanner(masked);
    const seen = new Set<string>();
    for (const match of masked.matchAll(UNRESOLVED_TAG_RE)) {
      // A tag inside an attribute value is text: it neither warns nor
      // stands in for a later use of the same tag in markup.
      if (scanner.isInsideValue(match.index)) continue;
      const tag = match[1].toLowerCase();
      if (seen.has(tag)) continue;
      seen.add(tag);
      const entry = manifest.components[tag];
      if (entry && isRenderable(entry)) continue;
      const key = `${httpPath}::<${tag}>`;
      if (entry?.unsupported) {
        const { reason, detail, line } = entry.unsupported;
        host.warnOnce!(
          key,
          `[bascik] Component tag <${tag}> in ${mode}-script output at "${httpPath}" is left unexpanded: ` +
            `${entry.filePath}${line !== undefined ? `:${line}` : ""} cannot be rendered at request time ` +
            `(${reason}${detail ? `: ${detail}` : ""}).`,
        );
      } else if (!host.externalTags(tag)) {
        host.warnOnce!(
          key,
          `[bascik] Unresolved component tag <${tag}> in ${mode}-script output at "${httpPath}": ` +
            `no matching component file found, so it reaches the client as written.`,
        );
      }
    }
  };

  const renderFragment = async (
    output: string,
    jobId: string,
    mode: ScriptMode,
    depth: number,
    signal: AbortSignal,
    started: number,
    outer: FragmentContext,
  ): Promise<RenderedFragment> => {
    const markers: JobMarker[] = [];
    const used: BascikComponent[] = [];
    const warn: ExpandOptions["warn"] = host.warnOnce
      ? (message) =>
          host.warnOnce!(
            `${httpPath}::${message}`,
            `[bascik] ${message} (in ${mode}-script output at "${httpPath}")`,
          )
      : () => {};
    // The loop's runaway tripwire. A usage can render smaller than it is
    // written (an unused prop or slot), so the output may pass through
    // more than the limit on the way to a result within it; it may not
    // grow past the limit by more than its own written size, nor past
    // twice the limit at all.
    const tripwire = Math.min(
      2 * limits.maxOutputChars,
      limits.maxOutputChars + output.length,
    );
    let html: string;
    try {
      html = expandByUsage(
        output,
        list,
        {
          scope: (component, instanceId) =>
            manifestScope(component, instanceId, markers, mode),
          mintId: (name, ordinal) =>
            requestInstanceId(
              host.hashHex,
              httpPath,
              jobId,
              name,
              ordinal,
              state.issuedIds,
            ),
          injectAttrProps: "after-scope",
          rewriteIdRefs: rewriteIdReferenceTarget,
          numberSourceUrls: false,
          inheritAttributes: manifest.inheritAttributes,
          instanceState: { ordinalMap: new Map(), issuedIds: state.issuedIds },
          // The loop trips at the limit before it searches again, so one
          // more substitution is allowed than instances; the size tripwire
          // is a runaway guard, the exact size is checked on the result.
          limits: {
            maxSubstitutions: limits.maxInstances + 1,
            maxOutputBytes: tripwire,
          },
          onError: (component, stage, error) => {
            throw new RequestRenderError(
              `[bascik] Rendering <${component.name}> (${component.fileName ?? "unknown file"}) ` +
                `from ${mode}-script output at "${httpPath}" failed during ${stage}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              httpPath,
              component.fileName,
            );
          },
          warn,
        },
        used,
        usageFinalizer(manifest, outer),
      );
    } catch (error) {
      if (!(error instanceof ComponentExpansionLimitError)) throw error;
      const limit = `4 MiB (${limits.maxOutputChars} characters) limit per script output`;
      if (output.length > tripwire) {
        throw new RequestRenderError(
          `[bascik] ${mode}-script output at "${httpPath}" is ${output.length} characters before rendering, ` +
            `over twice the ${limit}, and has component tags in it, so it is refused before they are expanded.`,
          httpPath,
        );
      }
      // The request scope never strips a usage, so every substitution is a
      // used instance; past the instance limit it was the instance count.
      const entry = lastEntry(used);
      if (used.length > limits.maxInstances) {
        throw new RequestRenderError(
          `[bascik] ${mode}-script output at "${httpPath}" expands to more than ` +
            `${limits.maxInstances} component instances${located(entry)}; ` +
            `the limit is ${limits.maxInstances} instances per script output.`,
          httpPath,
          entry?.filePath,
        );
      }
      throw new RequestRenderError(
        `[bascik] ${mode}-script output at "${httpPath}" grew past ${tripwire} characters while expanding ` +
          `components${located(entry)}, over the ${limit}.`,
        httpPath,
        entry?.filePath,
      );
    }
    // Only rendered output is measured: one without a component instance is
    // the author's text, returned as it was before request-time rendering.
    // The location names the last instance expanded, the one that was
    // being added when the output went over.
    const checkSize = (text: string, rendered: BascikComponent[]) => {
      if (rendered.length === 0 || text.length <= limits.maxOutputChars) return;
      const entry = lastEntry(rendered);
      throw new RequestRenderError(
        `[bascik] ${mode}-script output at "${httpPath}" rendered to ${text.length} characters, ` +
          `over the 4 MiB (${limits.maxOutputChars} characters) limit per script output${located(entry)}.`,
        httpPath,
        entry?.filePath,
      );
    };
    checkSize(html, used);
    if (host.warnOnce) warnUnresolved(html, mode);

    if (markers.length === 0) return { html, used };
    // A marker dropped with a slot's fallback content was never placed, so
    // its job never runs, as a placeholder dropped at build time never does.
    const sites = findMarkerSites(html);
    if (sites.length === 0) return { html, used };
    // Where each nested job's output lands, for its own instances.
    const siteContexts = manifest.minifyHtml
      ? fragmentContexts(html, sites, outer)
      : undefined;
    const contextOf = new Map<number, FragmentContext>();
    sites.forEach((site, index) =>
      contextOf.set(site.n, siteContexts?.[index] ?? DOCUMENT_FRAGMENT_CONTEXT),
    );
    const pending = new Map<number, JobMarker>();
    for (const site of sites) {
      const marker = markers[site.n];
      if (marker) pending.set(site.n, marker);
    }
    const first = markers[sites[0].n];
    const firstJob = first.entry.jobs.find((job) => job.id === first.id);
    if (depth >= limits.maxDepth) {
      throw new RequestRenderError(
        `[bascik] ${mode}-script output at "${httpPath}" nests component scripts deeper than ` +
          `${limits.maxDepth} levels${located(first.entry, firstJob?.sourceLine)}; ` +
          `a component script's output may return components to depth ${limits.maxDepth}.`,
        httpPath,
        first.entry.filePath,
      );
    }
    if (state.jobsRun + pending.size > limits.maxNestedJobs) {
      throw new RequestRenderError(
        `[bascik] ${mode}-script output at "${httpPath}" would run more than ` +
          `${limits.maxNestedJobs} nested component scripts in one response${located(first.entry, firstJob?.sourceLine)}; ` +
          `the limit is ${limits.maxNestedJobs} per response.`,
        httpPath,
        first.entry.filePath,
      );
    }
    state.jobsRun += pending.size;

    const outputs = new Map<number, RenderedFragment>();
    await Promise.all(
      [...pending].map(async ([n, marker]) => {
        // The parent's remaining budget, never zero: a nested job started at
        // the deadline still runs and times out on its own terms.
        const remaining = Math.max(1, host.timeoutMs - (Date.now() - started));
        const nested = await host.runComponentJob(marker.id, signal, remaining);
        outputs.set(
          n,
          nested.includes("<")
            ? await renderFragment(
                nested,
                // Keyed by the parent job and the marker's site, never by the
                // component script id alone: every instance of a component
                // runs the same script, so siblings would share one base id
                // and the salt order would follow nested completion order.
                `${jobId}/${n}`,
                mode,
                depth + 1,
                signal,
                started,
                contextOf.get(n) ?? DOCUMENT_FRAGMENT_CONTEXT,
              )
            : { html: nested, used: [] },
        );
      }),
    );
    let spliced = "";
    let cursor = 0;
    for (const site of sites) {
      const fragment = outputs.get(site.n);
      if (!fragment) continue;
      spliced += html.slice(cursor, site.start) + fragment.html;
      cursor = site.end;
    }
    spliced += html.slice(cursor);
    for (const fragment of outputs.values()) used.push(...fragment.used);
    checkSize(spliced, used);
    return { html: spliced, used };
  };

  /**
   * The stylesheets this job's output must carry: each used component's
   * block once per response per mode, or once per instance when its CSS
   * embeds the instance id. Called in dispatch order, which is document
   * order for both buffered and streamed jobs, so the first instance of a
   * component in the document gets the block whatever order jobs finish in.
   */
  const decideCss = (mode: ScriptMode, used: BascikComponent[]): string => {
    let blocks = "";
    for (const component of used) {
      const entry = manifest.components[component.name];
      if (!entry?.css) continue;
      if ("perInstance" in entry.css) {
        if (component.cssFileContent)
          blocks += `<style>${component.cssFileContent}</style>`;
        continue;
      }
      const key = `${mode}:${component.name}`;
      if (state.emittedCss.has(key)) continue;
      state.emittedCss.add(key);
      blocks += `<style>${entry.css.text}</style>`;
    }
    return blocks;
  };

  return async (id, signal) => {
    const mode = modes.get(id) ?? "server";
    // Take a place in this mode's decision chain at dispatch, before any
    // await: the stylesheet decision for this job waits for every job
    // dispatched before it, and releases whether this job succeeds or not.
    const previous = state.cssChain[mode];
    let release!: () => void;
    state.cssChain[mode] = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = Date.now();
    try {
      const output = await run(id, signal);
      if (!output.includes("<")) return output;
      const fragment = await renderFragment(
        output,
        id,
        mode,
        0,
        signal,
        started,
        manifest.minifyHtml
          ? (segmentContextsFor(plan).get(id) ?? DOCUMENT_FRAGMENT_CONTEXT)
          : DOCUMENT_FRAGMENT_CONTEXT,
      );
      if (fragment.used.length === 0) return fragment.html;
      await previous;
      return decideCss(mode, fragment.used) + fragment.html;
    } finally {
      release();
    }
  };
};
