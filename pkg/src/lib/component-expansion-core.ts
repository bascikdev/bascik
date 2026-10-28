/**
 * @module component-expansion-core
 *
 * The component expansion loop with its host-bound calls as parameters
 * (prompt 157). `recursivelyTranspile` (component-expansion.ts) is this loop
 * with the build-time scope, id minter, config and diagnostics plugged in; a
 * request-time renderer plugs in a manifest-backed scope and a per-request id
 * minter and runs the same loop on server and stream script output inside a
 * Worker. The renderer is therefore the compiler's own loop, not a second
 * scanner: every masking, slot, prop and nesting rule here applies to both.
 *
 * This module must stay portable: no `node:*` imports, no `process`, no
 * `Buffer`, no config module. `serverless-contract.test.ts` bundles it for a
 * Web platform and fails on any Node reference.
 */
import {
  extractInheritableAttributes,
  mergeAttributesOntoRoot,
} from "./component-inheritance.ts";
import { maskRawTextContent, spliceRawTextMask } from "./component-masking.ts";
import {
  extractProps,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";
import {
  extractDefaultSlotContent,
  extractNamedSlotContent,
  replaceDefaultSlots,
  replaceNamedSlots,
} from "./component-slots.ts";
import { checkScanBudget, chargeScan } from "./component-scan-budget.ts";
import { getFirstComponent, replaceTag } from "./component-tags.ts";
import type { ComponentSearchState } from "./component-attribute-scan.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { numberInstanceSourceUrls } from "./script-source-lines.ts";
import { stripPreserveDirectives } from "./shielding.ts";
import type {
  BascikComponent,
  ComponentList,
  TranspileResult,
} from "./types.ts";

/** Per-page state shared by every expansion pass over that page. */
export interface ComponentInstanceState {
  /** Instances seen per component name; the next ordinal is the count + 1. */
  ordinalMap: Map<string, number>;
  /** Every instance id minted so far, so a minter can resolve collisions. */
  issuedIds: Set<string>;
}

/**
 * The stage names reported through `onError`, in loop order. "" is the prop
 * extraction and id minting before the first stage.
 */
export type ExpansionStage =
  | ""
  | "attribute scoping"
  | "prop injection"
  | "slot resolution"
  | "attribute inheritance"
  | "substitution";

export interface ExpandOptions {
  /**
   * Scope one instance (ids, names, classes, scripts) under `instanceId`.
   * The loop reads the result's usage fields (`content`, `innerContent`,
   * `fileName`, the splice offsets) as well as its scoped output, so the
   * returned object must carry the usage it was given: either the same
   * object mutated (the build's `scopeComponentInstance`) or a copy such as
   * `applyScopingResult({ ...component }, result)` (scoping-instantiate.ts).
   * Returning null leaves the usage tag unexpanded and out of
   * `usedComponents`: the search continues after it.
   */
  scope: (
    component: BascikComponent,
    instanceId: string,
  ) => BascikComponent | null;
  /**
   * Mint the instance id for the `ordinal`-th instance of `componentName`.
   * Called before `scope`, which needs the id, so an instance that `scope`
   * declines still consumed its ordinal.
   */
  mintId: (componentName: string, ordinal: number) => string;
  /**
   * When `data-bascik-attr-*` bindings receive their values. The build injects
   * them before scoping so a value bound to `id`, `name` or `class` is scoped
   * like authored markup. A request-time renderer scopes through a recorded
   * template, which cannot see request values, so it injects after scoping;
   * that is byte-identical for every binding except id references (see
   * `rewriteIdRefs`).
   */
  injectAttrProps: "before-scope" | "after-scope";
  /**
   * With "after-scope": map a bound value through the instance's scoped id
   * names before it is injected, so the id references scoping would have
   * rewritten still point at the scoped ids. Called once per binding with
   * the target attribute's name, because the rule is per target (a fragment
   * `href`, the bare-id attributes `for`, `form`, `aria-*`, ...) and one prop
   * can be bound to an id-reference target and a plain one at once.
   */
  rewriteIdRefs?: (
    target: string,
    value: string,
    scopedIdNames: Record<string, string>,
  ) => string;
  /**
   * Append `?instance=N` to the sourceURL of the N-th instance's scripts
   * (N >= 2), as the build does so devtools can tell instances apart. A
   * request-time renderer passes false: its first-instance script hashes
   * assume identical script text across instances.
   */
  numberSourceUrls: boolean;
  /**
   * Applied to each filled instance after attribute inheritance and before it
   * is spliced into the page, never to the author's text around it. The
   * request path finishes whole top-level usages instead (request-render.ts,
   * `usageFinalizer`): an instance alone cannot tell whether a `<pre>` around
   * it keeps its whitespace.
   */
  finalizeInstance?: (html: string) => string;
  /** Merge non-bascik usage-tag attributes onto the instance root element. */
  inheritAttributes: boolean;
  instanceState: ComponentInstanceState;
  /**
   * Runaway-recursion tripwires: a component that (transitively) contains
   * itself would otherwise loop forever, doubling the HTML each pass. Either
   * limit throws a `ComponentExpansionLimitError`.
   */
  limits: { maxSubstitutions: number; maxOutputBytes: number };
  /**
   * A stage threw for one instance. When this returns, the loop strips the
   * usage tag and continues (the build logs here); a host that must abort the
   * render throws instead, and that error propagates out of the loop. `html`
   * is the page as it stands, for diagnostics that locate the instance.
   */
  onError: (
    component: BascikComponent,
    stage: ExpansionStage,
    error: unknown,
    html: string,
  ) => void;
  /**
   * Applied to the finished page. Node passes a `Buffer.byteLength` flattener
   * (component-expansion.ts) so the splice-built cons string is materialized
   * once here instead of in the first downstream consumer; byte-neutral.
   */
  flatten?: (value: string) => string;
  /**
   * Per-instance authoring diagnostics: a malformed prop or attr binding, a
   * binding conflict, an unknown `data-bascik-preserve` token. Defaults to
   * `console.warn`, which is what the build prints; a request host routes it
   * to its own once-per-key log.
   */
  warn?: (message: string) => void;
}

/** Thrown when `limits` trip. The build wraps it in a `PageProcessingError`. */
export class ComponentExpansionLimitError extends Error {
  constructor(substitutions: number, tag: string) {
    super(
      `component expansion exceeded safety limits (${substitutions} substitutions). ` +
        `This usually means a component recursively includes itself (e.g. ${tag} ` +
        `contains its own tag, directly or through another component). ` +
        "Recursive components are not supported; restructure to terminate the recursion.",
    );
    this.name = "ComponentExpansionLimitError";
  }
}

/**
 * Remove every `<opener...-->` marker comment. An indexOf walk rather than
 * `/<!--opener[\s\S]*?-->/g`, which rescans to the end from every unclosed
 * opener: quadratic on request-time output that carries visitor text. Once
 * one opener has no `-->` after it, no later one does either, so the walk
 * stops and leaves the rest as written, as the regex did.
 */
const removeMarkerComments = (html: string, opener: string): string => {
  let start = html.indexOf(opener);
  if (start === -1) return html;
  let result = "";
  let cursor = 0;
  while (start !== -1) {
    const close = html.indexOf("-->", start + opener.length);
    if (close === -1) break;
    result += html.slice(cursor, start);
    cursor = close + 3;
    start = html.indexOf(opener, cursor);
  }
  return result + html.slice(cursor);
};

/** Strip the `bascik-source-file` markers that locate diagnostics. */
export const stripSourceFileComments = (html: string): string =>
  removeMarkerComments(
    removeMarkerComments(html, "<!--bascik-source-file:"),
    "<!--bascik-source-file-end:",
  );

/**
 * Expand every component usage in `transpiledHtmlBody`, innermost-first by
 * document position, until none remains. `usedComponents` receives each
 * expanded instance in expansion order; `filePath` names the page for the
 * `bascik-source-file` markers that locate diagnostics.
 */
export const expandComponents = (
  transpiledHtmlBody: string,
  componentList: ComponentList,
  opts: ExpandOptions,
  usedComponents: BascikComponent[] = [],
  filePath?: string,
): TranspileResult => {
  if (filePath && !transpiledHtmlBody.includes("<!--bascik-source-file:")) {
    transpiledHtmlBody = `<!--bascik-source-file:${filePath}-->${transpiledHtmlBody}<!--bascik-source-file-end:${filePath}-->`;
  }

  const { ordinalMap } = opts.instanceState;
  const flatten = opts.flatten ?? ((value: string) => value);
  const warn = opts.warn ?? console.warn;

  // Iterative implementation — avoids keeping O(N) copies of the growing HTML
  // string simultaneously on the call stack (each recursive frame held its own
  // copy, leading to multi-GB heap usage on pages with many component instances).
  let substitutions = 0;
  let masked = maskRawTextContent(transpiledHtmlBody);
  // Search cursor (prompt 63). Replacement happens at the FIRST unresolved
  // component, so the prefix before its start is fully resolved and cannot
  // gain new tags; the next search resumes at that start (not its end, so
  // components nested inside the inserted template are still found first).
  // Any operation that edits text outside the known splice resets it to 0.
  let searchFrom = 0;
  // `transpiledHtmlBody.slice(0, maskClosedThrough)` is known to be closed for
  // masking, so a substitution after it can splice the template's own mask in
  // instead of re-masking the page (see spliceRawTextMask). Reset with the cursor.
  let maskClosedThrough = 0;
  // End of the last spliced-in template; the text before it is closed. -1 when unknown.
  let maskClosedEnd = -1;
  // Valid while the mask before the checkpoint is unchanged: the splice path only.
  const searchState: ComponentSearchState = {};
  let componentNames: Set<string> | undefined;
  // Whether the next search re-reads the attribute state from the start
  // (after a whole re-mask), for the request-time scan budget.
  let rescanFromStart = false;
  let lastTag = "(unknown)";
  while (true) {
    // Request time only (component-scan-budget.ts): the rescans charged
    // below are bounded per script output, before the next search.
    checkScanBudget(lastTag);
    if (
      substitutions >= opts.limits.maxSubstitutions ||
      transpiledHtmlBody.length > opts.limits.maxOutputBytes
    ) {
      const partial = getFirstComponent(
        transpiledHtmlBody,
        componentList,
        masked,
        searchFrom,
      );
      const tag = partial.name ? `<${partial.name}>` : "(unknown)";
      throw new ComponentExpansionLimitError(substitutions, tag);
    }
    const partial = getFirstComponent(
      transpiledHtmlBody,
      componentList,
      masked,
      searchFrom,
      searchState,
    );
    if (!partial.name) {
      return {
        transpiledHtmlBody: flatten(
          stripSourceFileComments(transpiledHtmlBody),
        ),
        usedComponents,
      };
    }
    // Cast: getFirstComponent merges component list data so all required fields are present
    let component = partial as BascikComponent;
    lastTag = `<${component.name}>`;
    {
      // The rescans this search made, and the instance's own reads: the
      // attribute state from the start after a re-mask; a close looked for
      // to the end for a usage without one; and for one with a close, its
      // whole span, which the close search walks and slot resolution copies
      // (each nesting level reads its slot again).
      const found = component as {
        startIndex?: number;
        endIndex?: number;
        closeIndex?: number;
        contentStart?: number;
      };
      if (rescanFromStart)
        chargeScan(found.startIndex ?? transpiledHtmlBody.length);
      rescanFromStart = false;
      if (
        found.closeIndex === -1 &&
        typeof found.contentStart === "number" &&
        !/\/\s*>$/.test(component.content ?? "")
      )
        chargeScan(transpiledHtmlBody.length - found.contentStart);
      else if (
        typeof found.startIndex === "number" &&
        typeof found.endIndex === "number"
      )
        chargeScan(found.endIndex - found.startIndex);
    }

    if (!component.fileContent) {
      return {
        transpiledHtmlBody: flatten(
          stripSourceFileComments(
            transpiledHtmlBody.replace(component.content || "", ""),
          ),
        ),
        usedComponents,
      };
    }

    let currentStage: ExpansionStage = "";
    // Prop and binding diagnostics name the component file they are about.
    const usage = component;
    const propWarn = (message: string): void =>
      warn(`<${usage.name}> (${usage.fileName || "unknown file"}): ${message}`);
    try {
      // One stable ID shared across all attribute-scoping passes for this instance.
      const props = extractProps(component.content, warn);
      if (opts.injectAttrProps === "before-scope") {
        currentStage = "prop injection";
        component.fileContent = injectPropAttributes(
          component.fileContent,
          props,
          undefined,
          propWarn,
        );
      }
      if (component.fileName) {
        // Components read by listComponents were stamped from the raw file; this
        // only fills in components supplied some other way.
        component.fileContent = stampDirectiveSources(
          component.fileContent,
          component.fileName,
        );
      }

      // Run the scoping pipeline — each step is `BascikComponent → BascikComponent`.
      const currentOrdinal = (ordinalMap.get(component.name) ?? 0) + 1;
      ordinalMap.set(component.name, currentOrdinal);
      const instanceId = opts.mintId(component.name, currentOrdinal);
      currentStage = "attribute scoping";
      const scoped = opts.scope(component, instanceId);
      if (scoped === null) {
        // Not renderable here: the usage stays as written and the search moves
        // past it. Only the scanned prefix is skipped; the mask and the
        // checkpoint still describe an unchanged page.
        const endIndex = (component as { endIndex?: number }).endIndex;
        if (typeof endIndex !== "number") {
          return {
            transpiledHtmlBody: flatten(
              stripSourceFileComments(transpiledHtmlBody),
            ),
            usedComponents,
          };
        }
        searchFrom = endIndex;
        continue;
      }
      component = scoped;
      if (opts.injectAttrProps === "after-scope") {
        // A binding that fails is a prop injection failure, not scoping's.
        currentStage = "prop injection";
        const { rewriteIdRefs } = opts;
        const scopedIdNames = component.scopedIdNames ?? {};
        component.fileContent = injectPropAttributes(
          component.fileContent,
          props,
          rewriteIdRefs &&
            ((target, value) => rewriteIdRefs(target, value, scopedIdNames)),
          propWarn,
        );
        currentStage = "attribute scoping";
      }
      // After scoping, not inside it: scoping results are reused across instances by renaming
      // instance IDs, and the ordinal is not an instance ID.
      if (opts.numberSourceUrls) {
        component.fileContent = numberInstanceSourceUrls(
          component.fileContent,
          currentOrdinal,
        );
      }
      component.fileContent = stripPreserveDirectives(
        component.fileContent,
        warn,
      );

      currentStage = "prop injection";
      // Inject props — always call so unused data-bascik-prop-* markers are stripped.
      component.fileContent = injectProps(
        component.fileContent,
        props,
        propWarn,
      );

      currentStage = "slot resolution";
      let transpiledTag: string;
      const hasTemplateSlot =
        component.fileContent.includes("data-bascik-slot");
      const hasUsageSlot = Boolean(
        component.innerContent &&
        component.innerContent.includes("data-bascik-slot"),
      );
      if (!hasTemplateSlot && !hasUsageSlot) {
        const defaultSlotContent = extractDefaultSlotContent(
          component.innerContent,
        );
        const namedSlots = extractNamedSlotContent(component.innerContent);
        const slotTemplate = replaceNamedSlots(
          component.fileContent,
          namedSlots,
        );
        transpiledTag = replaceDefaultSlots(slotTemplate, defaultSlotContent);
      } else {
        componentNames ??= new Set(Object.keys(componentList));
        const protectedChildren: Array<{
          placeholder: string;
          content: string;
        }> = [];
        let slotTemplate = component.fileContent;
        let childSearchFrom = 0;
        // The usage site's default slot content, computed once. It is also what a default slot
        // marker written inside a nested child's usage tag receives (see below).
        const defaultSlotContent = extractDefaultSlotContent(
          component.innerContent,
          componentNames,
        );
        while (childSearchFrom < slotTemplate.length) {
          const child = getFirstComponent(
            slotTemplate,
            componentList,
            undefined,
            childSearchFrom,
          ) as Partial<BascikComponent> & {
            startIndex?: number;
            endIndex?: number;
            contentStart?: number;
            closeIndex?: number;
          };
          if (
            typeof child.startIndex !== "number" ||
            typeof child.endIndex !== "number"
          )
            break;
          const placeholder = `<!--__BASCIK_NESTED_COMPONENT_${protectedChildren.length}__-->`;
          let childContent = slotTemplate.slice(
            child.startIndex,
            child.endIndex,
          );
          // Forward the default slot: a valueless `data-bascik-slot` marker written between a
          // child's usage tags is this template's own marker (named wrappers stay with the
          // child). Only the child's inner content is touched, never its opening tag.
          if (
            typeof child.contentStart === "number" &&
            typeof child.closeIndex === "number" &&
            child.closeIndex > child.contentStart
          ) {
            const innerStart = child.contentStart - child.startIndex;
            const innerEnd = child.closeIndex - child.startIndex;
            childContent =
              childContent.slice(0, innerStart) +
              replaceDefaultSlots(
                childContent.slice(innerStart, innerEnd),
                defaultSlotContent,
              ) +
              childContent.slice(innerEnd);
          }
          protectedChildren.push({ placeholder, content: childContent });
          slotTemplate =
            slotTemplate.slice(0, child.startIndex) +
            placeholder +
            slotTemplate.slice(child.endIndex);
          childSearchFrom = child.startIndex + placeholder.length;
        }
        // Resolve named slots from the usage inner HTML.
        const namedSlots = extractNamedSlotContent(
          component.innerContent,
          componentNames,
        );
        slotTemplate = replaceNamedSlots(
          slotTemplate,
          namedSlots,
          componentNames,
        );

        // Replace <element data-bascik-slot> default slot markers.
        // Named slots were already handled above by replaceNamedSlots.
        transpiledTag = replaceDefaultSlots(slotTemplate, defaultSlotContent);
        for (const { placeholder, content } of protectedChildren) {
          transpiledTag = transpiledTag.replace(placeholder, () => content);
        }
      }

      currentStage = "attribute inheritance";
      // Merge non-bascik attributes from the usage tag onto the component root element.
      if (opts.inheritAttributes) {
        const inheritableAttrs = extractInheritableAttributes(
          component.content,
        );
        transpiledTag = mergeAttributesOntoRoot(
          transpiledTag,
          inheritableAttrs,
        );
      }

      currentStage = "substitution";
      if (opts.finalizeInstance) {
        transpiledTag = opts.finalizeInstance(transpiledTag);
      }
      if (component.fileName) {
        transpiledTag = `<!--bascik-source-file:${component.fileName}-->${transpiledTag}<!--bascik-source-file-end:${component.fileName}-->`;
      }
      const { startIndex: sIdx, endIndex: eIdx } = component as {
        startIndex?: number;
        endIndex?: number;
      };
      const offsets =
        typeof sIdx === "number" && typeof eIdx === "number"
          ? { startIndex: sIdx, endIndex: eIdx }
          : undefined;
      const splicedMask = offsets
        ? spliceRawTextMask(
            transpiledHtmlBody,
            masked,
            offsets.startIndex,
            offsets.endIndex,
            transpiledTag,
            maskClosedEnd >= 0 && offsets.startIndex >= maskClosedEnd
              ? maskClosedEnd
              : maskClosedThrough,
          )
        : null;
      transpiledHtmlBody = replaceTag(
        transpiledHtmlBody,
        component.name,
        transpiledTag,
        masked,
        offsets,
      );

      // Mask the inserted template too. Without HTML minification (the dev server, or
      // `minify.html: false`) a template keeps its comments, and a component tag named in
      // one, such as a usage note, must stay text instead of being expanded. When the
      // prefix, the replaced usage, and the template are each closed, the template's own
      // mask is spliced in; otherwise a comment or raw-text element could cross the
      // splice boundary, so the whole page is re-masked.
      if (splicedMask?.masked != null && offsets) {
        masked = splicedMask.masked;
        searchFrom = offsets.startIndex;
      } else {
        masked = maskRawTextContent(transpiledHtmlBody);
        chargeScan(transpiledHtmlBody.length);
        rescanFromStart = true;
        searchState.attributeCheckpoint = undefined;
        // A comment or raw-text element opened inside the new content could
        // extend a mask region across the splice boundary only forward, never
        // into the resolved prefix, so resuming at the instance start is still
        // safe; without known indices, be conservative.
        searchFrom = offsets ? offsets.startIndex : 0;
      }
      // Without offsets the edit position is unknown, so verify from the start again.
      maskClosedThrough = splicedMask ? splicedMask.closedThrough : 0;
      maskClosedEnd = splicedMask?.closedEnd ?? -1;

      usedComponents.push(component);
      substitutions++;
    } catch (error) {
      // The limit tripwire throws before the `try`, so nothing here can be a
      // ComponentExpansionLimitError unless a host callback made one.
      opts.onError(component, currentStage, error, transpiledHtmlBody);
      if (component.content) {
        transpiledHtmlBody = replaceTag(
          transpiledHtmlBody,
          component.name,
          "",
          masked,
        );
        masked = maskRawTextContent(transpiledHtmlBody);
        chargeScan(transpiledHtmlBody.length);
        rescanFromStart = true;
        // replaceTag without offsets re-searches from the document start and
        // may have edited text before the cursor; reset conservatively.
        searchFrom = 0;
        maskClosedThrough = 0;
        maskClosedEnd = -1;
        searchState.attributeCheckpoint = undefined;
        substitutions++;
      } else {
        // No content to strip — replacing would be a no-op and the while(true)
        // loop would spin on the same tag forever.  Bail out instead.
        return {
          transpiledHtmlBody: stripSourceFileComments(transpiledHtmlBody),
          usedComponents,
        };
      }
    }
  }
};
