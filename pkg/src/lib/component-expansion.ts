import type { ComponentSearchState } from "./components.ts";
import {
  extractDefaultSlotContent,
  extractInheritableAttributes,
  extractNamedSlotContent,
  extractProps,
  getFirstComponent,
  injectPropAttributes,
  injectProps,
  maskRawTextContent,
  mergeAttributesOntoRoot,
  replaceDefaultSlots,
  replaceNamedSlots,
  replaceTag,
  spliceRawTextMask,
} from "./components.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { scopeComponentInstance } from "./scoping-template.ts";
import { numberInstanceSourceUrls } from "./script-source-lines.ts";
import { stripPreserveDirectives } from "./shielding.ts";

import { BascikConfig } from "./config.ts";
import { deriveInstanceId } from "./names.ts";
import type {
  BascikComponent,
  ComponentList,
  TranspileResult,
} from "./types.ts";

import {
  PageProcessingError,
  findActiveSourceFile,
  getDisplayPath,
  getFilePosition,
} from "./page-diagnostics.ts";

interface ComponentInstanceState {
  ordinalMap: Map<string, number>;
  issuedIds: Set<string>;
}

// Guards against infinite expansion: a component that (transitively) contains
// itself would otherwise loop forever, doubling the HTML string each pass until
// the process runs out of memory.  Two independent tripwires:
//   1. MAX_SUBSTITUTIONS — hard cap on total component substitutions per call.
//   2. MAX_OUTPUT_BYTES  — hard cap on the growing HTML string.
// Both are far beyond any legitimate page (a page with 10 000 component
// instances or 50 MB of markup), so they only fire on runaway recursion.
const MAX_SUBSTITUTIONS = 10_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Force V8 to materialize `value` as a flat (contiguous) string (prompt 85).
 *
 * Every `replaceTag` splice is `prefix + insert + suffix`, and V8 represents
 * that as a `ConsString` node rather than copying. After hundreds of splices
 * the page is a deep concatenation tree, and the first downstream consumer
 * (regex scan, minifier, `Buffer.from`) pays a synchronous flatten pause.
 *
 * `Buffer.byteLength` hands the string to V8's C++ `String::Flatten` on every
 * call, which rewrites the cons tree in place into a flat sequential string
 * and returns the same string object. Pure-JS probes such as `charCodeAt` or
 * `indexOf` are not reliable here: once TurboFan inlines them they walk the
 * cons tree without flattening it. Byte-neutral; one linear pass at most.
 */
const flattenString = (value: string): string => {
  if (value.length > 0) Buffer.byteLength(value);
  return value;
};

export const recursivelyTranspile = (
  transpiledHtmlBody: string,
  componentList: ComponentList,
  usedComponents: BascikComponent[] = [],
  filePath?: string,
  instanceState?: ComponentInstanceState,
): TranspileResult => {
  if (filePath && !transpiledHtmlBody.includes("<!--bascik-source-file:")) {
    transpiledHtmlBody = `<!--bascik-source-file:${filePath}-->${transpiledHtmlBody}<!--bascik-source-file-end:${filePath}-->`;
  }

  const ordinalMap = instanceState?.ordinalMap ?? new Map<string, number>();
  const issuedIds = instanceState?.issuedIds ?? new Set<string>();

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
  while (true) {
    if (
      substitutions >= MAX_SUBSTITUTIONS ||
      transpiledHtmlBody.length > MAX_OUTPUT_BYTES
    ) {
      const partial = getFirstComponent(
        transpiledHtmlBody,
        componentList,
        masked,
        searchFrom,
      );
      const tag = partial.name ? `<${partial.name}>` : "(unknown)";
      throw new PageProcessingError(
        filePath ?? "unknown file",
        "component expansion",
        new Error(
          `component expansion exceeded safety limits (${substitutions} substitutions). ` +
            `This usually means a component recursively includes itself (e.g. ${tag} ` +
            `contains its own tag, directly or through another component). ` +
            "Recursive components are not supported; restructure to terminate the recursion.",
        ),
      );
    }
    const partial = getFirstComponent(
      transpiledHtmlBody,
      componentList,
      masked,
      searchFrom,
      searchState,
    );
    if (!partial.name) {
      const cleanedHtml = flattenString(
        transpiledHtmlBody
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, ""),
      );
      return { transpiledHtmlBody: cleanedHtml, usedComponents };
    }
    // Cast: getFirstComponent merges component list data so all required fields are present
    let component = partial as BascikComponent;

    if (!component.fileContent) {
      const cleanedHtml = flattenString(
        transpiledHtmlBody
          .replace(component.content || "", "")
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, ""),
      );
      return {
        transpiledHtmlBody: cleanedHtml,
        usedComponents,
      };
    }

    let currentStage = "";
    try {
      // One stable ID shared across all attribute-scoping passes for this instance.
      const props = extractProps(component.content);
      component.fileContent = injectPropAttributes(
        component.fileContent,
        props,
      );
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
      const instanceId = deriveInstanceId(
        filePath || "page",
        component.name,
        currentOrdinal,
        issuedIds,
      );
      currentStage = "attribute scoping";
      component = scopeComponentInstance(component, instanceId);
      // After scoping, not inside it: scoping results are reused across instances by renaming
      // instance IDs, and the ordinal is not an instance ID.
      component.fileContent = numberInstanceSourceUrls(
        component.fileContent,
        currentOrdinal,
      );
      component.fileContent = stripPreserveDirectives(component.fileContent);

      currentStage = "prop injection";
      // Inject props — always call so unused data-bascik-prop-* markers are stripped.
      component.fileContent = injectProps(component.fileContent, props);

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
      if (BascikConfig.scoping?.inheritAttributes) {
        const inheritableAttrs = extractInheritableAttributes(
          component.content,
        );
        transpiledTag = mergeAttributesOntoRoot(
          transpiledTag,
          inheritableAttrs,
        );
      }

      currentStage = "substitution";
      if (component.fileName) {
        transpiledTag = `<!--bascik-source-file:${component.fileName}-->${transpiledTag}<!--bascik-source-file-end:${component.fileName}-->`;
      }
      const sIdx = (component as any).startIndex;
      const eIdx = (component as any).endIndex;
      const hasOffsets = typeof sIdx === "number" && typeof eIdx === "number";
      const splicedMask = hasOffsets
        ? spliceRawTextMask(
            transpiledHtmlBody,
            masked,
            sIdx,
            eIdx,
            transpiledTag,
            maskClosedEnd >= 0 && sIdx >= maskClosedEnd
              ? maskClosedEnd
              : maskClosedThrough,
          )
        : null;
      transpiledHtmlBody = replaceTag(
        transpiledHtmlBody,
        component.name,
        transpiledTag,
        masked,
        typeof sIdx === "number" && typeof eIdx === "number"
          ? { startIndex: sIdx, endIndex: eIdx }
          : undefined,
      );

      // Mask the inserted template too. Without HTML minification (the dev server, or
      // `minify.html: false`) a template keeps its comments, and a component tag named in
      // one, such as a usage note, must stay text instead of being expanded. When the
      // prefix, the replaced usage, and the template are each closed, the template's own
      // mask is spliced in; otherwise a comment or raw-text element could cross the
      // splice boundary, so the whole page is re-masked.
      if (splicedMask?.masked != null) {
        masked = splicedMask.masked;
        searchFrom = sIdx;
      } else {
        masked = maskRawTextContent(transpiledHtmlBody);
        searchState.attributeCheckpoint = undefined;
        // A comment or raw-text element opened inside the new content could
        // extend a mask region across the splice boundary only forward, never
        // into the resolved prefix, so resuming at the instance start is still
        // safe; without known indices, be conservative.
        searchFrom = hasOffsets ? sIdx : 0;
      }
      // Without offsets the edit position is unknown, so verify from the start again.
      maskClosedThrough = splicedMask ? splicedMask.closedThrough : 0;
      maskClosedEnd = splicedMask?.closedEnd ?? -1;

      usedComponents.push(component);
      substitutions++;
    } catch (error) {
      const activeSourceFile = findActiveSourceFile(
        transpiledHtmlBody,
        component.index || 0,
        filePath || "",
      );
      let errorMsg = `[bascik] Transpilation failed for component <${component.name}> during ${currentStage}`;
      if (activeSourceFile) {
        const pos = getFilePosition(
          activeSourceFile,
          component.content || "",
          component.name,
        );
        if (pos) {
          errorMsg += ` in "${getDisplayPath(activeSourceFile)}" at (line ${pos.line}, column ${pos.character})`;
        } else {
          errorMsg += ` in "${getDisplayPath(activeSourceFile)}"`;
        }
      }
      if (component.fileName) {
        errorMsg += `\n  Defined in component template: "${getDisplayPath(component.fileName)}"`;
      }
      console.error(
        `${errorMsg}\n  Error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      );
      if (component.content) {
        transpiledHtmlBody = replaceTag(
          transpiledHtmlBody,
          component.name,
          "",
          masked,
        );
        masked = maskRawTextContent(transpiledHtmlBody);
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
        const cleanedHtml = transpiledHtmlBody
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, "");
        return { transpiledHtmlBody: cleanedHtml, usedComponents };
      }
    }
  }
};
