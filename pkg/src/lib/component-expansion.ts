/**
 * @module component-expansion
 *
 * The build-time entry to component expansion: `recursivelyTranspile` runs
 * the portable loop in component-expansion-core.ts with the build's scope
 * (scoping-template.ts), id minter (names.ts), config and page diagnostics
 * (prompt 157). Everything host-bound lives here so the loop itself can also
 * render server and stream script output at request time on a Web host.
 */
import {
  ComponentExpansionLimitError,
  expandComponents,
  type ComponentInstanceState,
} from "./component-expansion-core.ts";
import { scopeComponentInstance } from "./scoping-template.ts";
import type { BindingPolicy } from "./component-props.ts";

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

/**
 * Guards against infinite expansion: a component that (transitively) contains
 * itself would otherwise loop forever, doubling the HTML string each pass until
 * the process runs out of memory.  Two independent tripwires:
 *   1. maxSubstitutions — hard cap on total component substitutions per call.
 *   2. maxOutputBytes   — hard cap on the growing HTML string.
 * Both are far beyond any legitimate page (a page with 10 000 component
 * instances or 50 MB of markup), so they only fire on runaway recursion.
 * Exported so the loop's tests pin the limits the build passes.
 */
export const BUILD_EXPANSION_LIMITS = {
  maxSubstitutions: 10_000,
  maxOutputBytes: 50 * 1024 * 1024,
} as const;

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

/**
 * `components.expansionLimits` as the loop's tripwires; a missing field is
 * the default in `BUILD_EXPANSION_LIMITS`.
 */
const buildExpansionLimits = (): {
  maxSubstitutions: number;
  maxOutputBytes: number;
} => {
  const configured = BascikConfig.components?.expansionLimits;
  return {
    maxSubstitutions:
      configured?.maxInstances ?? BUILD_EXPANSION_LIMITS.maxSubstitutions,
    maxOutputBytes:
      configured?.maxPageLength ?? BUILD_EXPANSION_LIMITS.maxOutputBytes,
  };
};

/** `security.blockScriptUrls` / `blockCodeBindings`, on unless turned off. */
export const buildBindingPolicy = (
  security: Partial<BindingPolicy> | undefined = BascikConfig.security,
): BindingPolicy => ({
  blockScriptUrls: security?.blockScriptUrls !== false,
  blockCodeBindings: security?.blockCodeBindings !== false,
});

export const recursivelyTranspile = (
  transpiledHtmlBody: string,
  componentList: ComponentList,
  usedComponents: BascikComponent[] = [],
  filePath?: string,
  instanceState?: ComponentInstanceState,
): TranspileResult => {
  const state: ComponentInstanceState = instanceState ?? {
    ordinalMap: new Map<string, number>(),
    issuedIds: new Set<string>(),
  };
  try {
    return expandComponents(
      transpiledHtmlBody,
      componentList,
      {
        scope: scopeComponentInstance,
        mintId: (componentName, ordinal) =>
          deriveInstanceId(
            filePath || "page",
            componentName,
            ordinal,
            state.issuedIds,
          ),
        injectAttrProps: "before-scope",
        numberSourceUrls: true,
        inheritAttributes: Boolean(BascikConfig.scoping?.inheritAttributes),
        instanceState: state,
        limits: buildExpansionLimits(),
        bindings: buildBindingPolicy(),
        // Log and keep going: the failed usage is stripped and the rest of the
        // page still builds, so one broken instance is reported, not fatal.
        onError: (component, currentStage, error, html) => {
          const activeSourceFile = findActiveSourceFile(
            html,
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
        },
        flatten: flattenString,
        // The loop names the component file a prop or binding diagnostic is
        // about as it was given (absolute at build time); print it the way
        // every other build diagnostic does.
        warn: (message) =>
          console.warn(
            message.replace(
              /^(<[^>\s]+> \()([^)]+)(\): )/,
              (_match, open: string, path: string, close: string) =>
                `${open}${getDisplayPath(path)}${close}`,
            ),
          ),
      },
      usedComponents,
      filePath,
    );
  } catch (error) {
    if (error instanceof ComponentExpansionLimitError) {
      throw new PageProcessingError(
        filePath ?? "unknown file",
        "component expansion",
        error,
      );
    }
    throw error;
  }
};
