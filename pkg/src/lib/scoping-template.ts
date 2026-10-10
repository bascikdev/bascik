/**
 * @module scoping-template
 *
 * Reuse of attribute and script scoping across repeated component instances.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A page often renders the same component many times with identical markup
 * (after props are applied). The scoping pipeline (`runScopingPipeline`) then
 * does the same work for every instance; only the instance ID differs. This
 * module runs the real pipeline for the first instances of each distinct input
 * and, once its prediction has matched the real output, derives later results
 * by renaming instead of re-running the pipeline.
 *
 * Why renaming is exact
 * ---------------------
 * The instance ID reaches the pipeline output in exactly two ways:
 *   1. raw, inside scoped names built as `bascik__<name>__<instanceId>__<value>`
 *      (and names derived from those, such as `__id__`, `__el__`, keyframe,
 *      layer, and custom property names);
 *   2. through `minifyAttributeName`, which hashes such a string into
 *      `b` + 11 Base62 characters when identifier minification is on. A hash
 *      can itself feed a later name (CSS `#id` selectors become classes named
 *      after the scoped id).
 * Every hash is produced by `minifyAttributeName` (names.ts), which reports
 * each call to the recorder below. The recorded run therefore lists every
 * instance-dependent string ("token"): the instance ID plus each hash whose
 * input contained an earlier token. A new instance's tokens are computed by
 * replaying those calls with the new ID through the real `minifyAttributeName`.
 *
 * The pipeline treats generated names as opaque tokens: every check that can
 * see one either consumes the whole name with a character class that covers
 * all name characters (`[\w-]`, `[a-zA-Z0-9_-]`, `[^"']`, `[^\s]`), compares
 * against the component's own authored text, or acts only on exact delimited
 * matches (`id="…"`, `getElementById("…")`, `#…`, `.…`). Instance IDs are
 * lowercase hex and hashes are Base62, so no name contains a quote, space,
 * `<`, `>`, `#`, `.`, `@`, `\x00`, or `__` beyond the delimiters it was built
 * with. `scoping-parametricity.test.ts` checks this property directly against
 * the real pipeline on random and adversarial components, and the full test
 * suites run with `BASCIK_VERIFY_SCOPING_TEMPLATES=1`, which recomputes every
 * reused result with the real pipeline and throws on any difference.
 *
 * Safety rules (each one falls back to the real pipeline)
 * -------------------------------------------------------
 * - The cache key is the complete pipeline input: every component field the
 *   pipeline reads (`SCOPING_INPUT_FIELDS`), the scoping and identifier
 *   minification config, and the working directory. `scoping-template.test.ts`
 *   pins these lists with recording proxies.
 * - A run that plans a CSS `@import` (file system access) or writes to the
 *   console is never reused, so warnings and file reads still happen per
 *   instance exactly as before.
 * - A token must not occur in the authored input, token occurrences must not
 *   overlap, a hash must not collide with another name, and the output must
 *   not contain an unrestored `\x00` shield marker.
 * - Reuse starts only after the prediction matched the real pipeline output
 *   for two more instances with different IDs. Any mismatch disables reuse for
 *   that input for the rest of the process.
 * - A new instance whose computed names collide with each other or occur in
 *   the authored input is scoped by the real pipeline.
 *
 * Module state touched by the pipeline is limited to content-addressed memos
 * (`scopedCssCache`, the name hash cache) and the shield token counter, whose
 * tokens are always restored within one call and never reach the output. A
 * `scopedCssCache` hit returns names without calling `minifyAttributeName`
 * and skips CSS import planning, so recording runs bypass that memo.
 */

import { BascikConfig } from "./config.ts";
import { namespaceScriptTags, prefixElementAttribute, withScopedCssCacheBypassed } from "./javascript.ts";
import { minifyAttributeName, observeAttributeNames } from "./names.ts";
import { observeCssImportPlanning } from "./styles.ts";
import type { BascikComponent } from "./types.ts";

/** Every component field the scoping pipeline reads. Pinned by tests. */
export const SCOPING_INPUT_FIELDS = [
  "name",
  "fileName",
  "fileContent",
  "cssFileContent",
  "scopedIdNames",
  "requiresPerInstanceCss",
] as const;

/** Every component field the scoping pipeline writes. Pinned by tests. */
export const SCOPING_RESULT_FIELDS = [
  "fileContent",
  "cssFileContent",
  "scopedIdNames",
  "requiresPerInstanceCss",
] as const;

/** Config the scoping pipeline reads (top-level keys). Pinned by tests. */
export const SCOPING_CONFIG_KEYS = ["scoping", "minify"] as const;

/**
 * The attribute and script scoping pipeline for one component instance, in
 * order: id, name, class, then script namespacing. Mutates and returns
 * `component`.
 */
export const runScopingPipeline = (component: BascikComponent, instanceId: string): BascikComponent => {
  const skip = BascikConfig.scoping?.preserve ?? ["code"];
  let current = component;
  if (BascikConfig.scoping?.attributes?.id) {
    current = prefixElementAttribute(current, "id", instanceId, true, skip);
  }
  if (BascikConfig.scoping?.attributes?.name) {
    current = prefixElementAttribute(current, "name", instanceId, true, skip);
  }
  if (BascikConfig.scoping?.attributes?.class) {
    current = prefixElementAttribute(current, "class", instanceId, BascikConfig.scoping?.deduplicateCss ?? true, skip);
  }
  if (BascikConfig.scoping?.scriptBlocks) {
    current = namespaceScriptTags(current);
  }
  return current;
};

interface ScopingResult {
  fileContent: string;
  cssFileContent: string | undefined;
  scopedIdNames: string | undefined;
  requiresPerInstanceCss: boolean | undefined;
}

/** Text split at token occurrences: `parts[0] + t[tokens[0]] + parts[1] + …`. */
interface Segmented {
  parts: string[];
  tokens: number[];
}

export interface ScopingTemplate {
  instanceId: string;
  tokenCount: number;
  /** Hashes to recompute, in recorded order: `token = minifyAttributeName(input)`. */
  steps: Array<{ input: Segmented; token: number }>;
  fileContent: Segmented;
  cssFileContent: Segmented | undefined;
  scopedIdNames: Segmented | undefined;
  requiresPerInstanceCss: boolean | undefined;
  size: number;
}

const snapshotResult = (component: BascikComponent): ScopingResult => ({
  fileContent: component.fileContent,
  cssFileContent: component.cssFileContent,
  scopedIdNames: component.scopedIdNames === undefined ? undefined : JSON.stringify(component.scopedIdNames),
  requiresPerInstanceCss: component.requiresPerInstanceCss,
});

/** The authored text a token must never occur in. */
const inputTexts = (component: BascikComponent): string[] => [
  component.name,
  component.fileName ?? "",
  component.fileContent ?? "",
  component.cssFileContent ?? "",
  component.scopedIdNames === undefined ? "" : JSON.stringify(component.scopedIdNames),
];

const inputKey = (component: BascikComponent): string =>
  JSON.stringify([
    BascikConfig.scoping ?? null,
    Boolean(BascikConfig.minify?.identifiers),
    process.cwd(),
    component.name,
    component.fileName ?? null,
    component.fileContent,
    component.cssFileContent ?? null,
    component.scopedIdNames ?? null,
    component.requiresPerInstanceCss ?? null,
  ]);

/** Split `text` at every occurrence of every token; null when occurrences overlap. */
const segment = (text: string, tokens: string[]): Segmented | null => {
  const hits: Array<{ start: number; end: number; token: number }> = [];
  tokens.forEach((token, index) => {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      hits.push({ start: at, end: at + token.length, token: index });
    }
  });
  hits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  const order: number[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) return null;
    parts.push(text.slice(cursor, hit.start));
    order.push(hit.token);
    cursor = hit.end;
  }
  parts.push(text.slice(cursor));
  return { parts, tokens: order };
};

const join = (segmented: Segmented, values: string[]): string => {
  let text = segmented.parts[0];
  for (let index = 0; index < segmented.tokens.length; index++) {
    text += values[segmented.tokens[index]] + segmented.parts[index + 1];
  }
  return text;
};

const segmentedSize = (segmented: Segmented | undefined): number =>
  segmented ? segmented.parts.reduce((total, part) => total + part.length, 0) : 0;

/**
 * Build a template from one recorded run of the real pipeline, or null when
 * any safety rule rejects it.
 */
export const buildScopingTemplate = (
  inputs: string[],
  instanceId: string,
  calls: Array<{ input: string; output: string }>,
  result: ScopingResult,
): ScopingTemplate | null => {
  if (!instanceId) return null;
  const tokens = [instanceId];
  const tokenIndex = new Map<string, number>([[instanceId, 0]]);
  const producedFrom = new Map<string, string>();
  const independentOutputs = new Set<string>();
  const independentInputs: string[] = [];
  const stepInputs: Array<{ input: string; token: number }> = [];

  for (const { input, output } of calls) {
    const dependent = tokens.some((token) => input.includes(token));
    if (!dependent) {
      independentInputs.push(input);
      independentOutputs.add(output);
      continue;
    }
    // Unminified names equal their input: renaming the tokens inside covers them.
    if (output === input) continue;
    const previousInput = producedFrom.get(output);
    if (previousInput !== undefined) {
      if (previousInput !== input) return null;
      continue;
    }
    if (tokenIndex.has(output)) return null;
    producedFrom.set(output, input);
    tokenIndex.set(output, tokens.length);
    stepInputs.push({ input, token: tokens.length });
    tokens.push(output);
  }

  // A token must be a generated name: never authored text, never a name that
  // does not depend on the instance, never inside an instance-independent input.
  for (const token of tokens) {
    if (inputs.some((text) => text.includes(token))) return null;
    if (independentOutputs.has(token)) return null;
    for (const output of independentOutputs) if (output.includes(token)) return null;
    for (const input of independentInputs) if (input.includes(token)) return null;
  }

  const steps: ScopingTemplate["steps"] = [];
  for (const { input, token } of stepInputs) {
    const segmented = segment(input, tokens);
    // A hash input may only contain tokens computed before it.
    if (!segmented || segmented.tokens.some((used) => used >= token)) return null;
    steps.push({ input: segmented, token });
  }

  for (const text of [result.fileContent, result.cssFileContent, result.scopedIdNames]) {
    if (text !== undefined && text.includes("\x00")) return null;
  }
  const fileContent = segment(result.fileContent, tokens);
  if (!fileContent) return null;
  const cssFileContent = result.cssFileContent === undefined ? undefined : segment(result.cssFileContent, tokens);
  if (cssFileContent === null) return null;
  const scopedIdNames = result.scopedIdNames === undefined ? undefined : segment(result.scopedIdNames, tokens);
  if (scopedIdNames === null) return null;

  return {
    instanceId,
    tokenCount: tokens.length,
    steps,
    fileContent,
    cssFileContent,
    scopedIdNames,
    requiresPerInstanceCss: result.requiresPerInstanceCss,
    size: 2 * (segmentedSize(fileContent) + segmentedSize(cssFileContent) + segmentedSize(scopedIdNames)
      + steps.reduce((total, step) => total + segmentedSize(step.input), 0)),
  };
};

/**
 * The result a template predicts for `instanceId`, or null when the computed
 * names collide with each other or occur in the authored `inputs`.
 */
export const instantiateScopingTemplate = (
  template: ScopingTemplate,
  instanceId: string,
  inputs: string[],
): ScopingResult | null => {
  const values = new Array<string>(template.tokenCount);
  values[0] = instanceId;
  for (const step of template.steps) values[step.token] = minifyAttributeName(join(step.input, values));
  if (new Set(values).size !== values.length) return null;
  for (const value of values) if (inputs.some((text) => text.includes(value))) return null;
  return {
    fileContent: join(template.fileContent, values),
    cssFileContent: template.cssFileContent === undefined ? undefined : join(template.cssFileContent, values),
    scopedIdNames: template.scopedIdNames === undefined ? undefined : join(template.scopedIdNames, values),
    requiresPerInstanceCss: template.requiresPerInstanceCss,
  };
};

/** Test-only access to the snapshot helpers. Never read on production paths. */
export const __scopingTemplateInternalsForTests = {
  inputTexts,
  snapshotResult,
  inputKey,
  entryCount: (): number => entries.size,
  /** The cached template for `component`, for tests that simulate a wrong prediction. */
  templateFor: (component: BascikComponent): ScopingTemplate | null => entries.get(inputKey(component))?.template ?? null,
};

const sameResult = (a: ScopingResult, b: ScopingResult): boolean =>
  a.fileContent === b.fileContent &&
  a.cssFileContent === b.cssFileContent &&
  a.scopedIdNames === b.scopedIdNames &&
  a.requiresPerInstanceCss === b.requiresPerInstanceCss;

const differingField = (a: ScopingResult, b: ScopingResult): string =>
  (["fileContent", "cssFileContent", "scopedIdNames", "requiresPerInstanceCss"] as const)
    .find((field) => a[field] !== b[field]) ?? "none";

const applyResult = (component: BascikComponent, result: ScopingResult): BascikComponent => {
  component.fileContent = result.fileContent;
  if (result.cssFileContent === undefined) delete component.cssFileContent;
  else component.cssFileContent = result.cssFileContent;
  if (result.scopedIdNames === undefined) delete component.scopedIdNames;
  else component.scopedIdNames = JSON.parse(result.scopedIdNames) as Record<string, string>;
  if (result.requiresPerInstanceCss === undefined) delete component.requiresPerInstanceCss;
  else component.requiresPerInstanceCss = result.requiresPerInstanceCss;
  return component;
};

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * Run the real pipeline once while recording every generated name, whether
 * CSS import planning ran, and whether anything was written to the console.
 */
export const recordScopingRun = (
  component: BascikComponent,
  instanceId: string,
): { component: BascikComponent; calls: Array<{ input: string; output: string }>; clean: boolean } => {
  const calls: Array<{ input: string; output: string }> = [];
  let clean = true;
  const originals = CONSOLE_METHODS.map((method) => console[method]);
  CONSOLE_METHODS.forEach((method, index) => {
    console[method] = (...args: unknown[]) => {
      clean = false;
      return (originals[index] as (...values: unknown[]) => void).apply(console, args);
    };
  });
  try {
    const result = observeCssImportPlanning(
      () => { clean = false; },
      () => observeAttributeNames(
        (input, output) => { calls.push({ input, output }); },
        // A memo hit would hide name generation and import planning.
        () => withScopedCssCacheBypassed(() => runScopingPipeline(component, instanceId)),
      ),
    );
    return { component: result, calls, clean };
  } finally {
    CONSOLE_METHODS.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
};

interface TemplateEntry {
  state: "verifying" | "trusted" | "never";
  template: ScopingTemplate | null;
  verifiedIds: Set<string>;
  size: number;
}

const REQUIRED_VERIFICATIONS = 2;
const MAX_TEMPLATE_ENTRIES = 512;
const MAX_TEMPLATE_BYTES = 32 * 1024 * 1024;

const entries = new Map<string, TemplateEntry>();
let totalBytes = 0;

/** Test-only counters. Never read on production paths. */
export const __scopingTemplateStatsForTests = {
  recorded: 0,
  verified: 0,
  reused: 0,
  rejected: 0,
  reset(): void {
    this.recorded = 0;
    this.verified = 0;
    this.reused = 0;
    this.rejected = 0;
  },
};

export const clearScopingTemplates = (): void => {
  entries.clear();
  totalBytes = 0;
};

const storeEntry = (key: string, entry: TemplateEntry): void => {
  entries.set(key, entry);
  totalBytes += entry.size;
  while (entries.size > MAX_TEMPLATE_ENTRIES || totalBytes > MAX_TEMPLATE_BYTES) {
    const [oldestKey, oldest] = entries.entries().next().value as [string, TemplateEntry];
    entries.delete(oldestKey);
    totalBytes -= oldest.size;
  }
};

const disable = (entry: TemplateEntry): void => {
  entry.state = "never";
  entry.template = null;
};

const verifyEveryReuse = (): boolean => process.env.BASCIK_VERIFY_SCOPING_TEMPLATES === "1";

/**
 * Scope one component instance: the same result as `runScopingPipeline`,
 * reusing a verified template for repeated inputs.
 */
export const scopeComponentInstance = (component: BascikComponent, instanceId: string): BascikComponent => {
  const key = inputKey(component);
  const entry = entries.get(key);

  if (!entry) {
    const inputs = inputTexts(component);
    const recorded = recordScopingRun(component, instanceId);
    __scopingTemplateStatsForTests.recorded++;
    const template = recorded.clean
      ? buildScopingTemplate(inputs, instanceId, recorded.calls, snapshotResult(recorded.component))
      : null;
    if (!template) __scopingTemplateStatsForTests.rejected++;
    storeEntry(key, {
      state: template ? "verifying" : "never",
      template,
      verifiedIds: new Set(),
      size: 2 * key.length + (template?.size ?? 0),
    });
    return recorded.component;
  }

  // Least recently used order.
  entries.delete(key);
  entries.set(key, entry);

  if (entry.state === "never" || !entry.template) return runScopingPipeline(component, instanceId);

  const template = entry.template;
  const predicted = instantiateScopingTemplate(template, instanceId, inputTexts(component));

  if (entry.state === "verifying") {
    const real = runScopingPipeline(component, instanceId);
    if (predicted && instanceId !== template.instanceId && !entry.verifiedIds.has(instanceId)) {
      if (sameResult(predicted, snapshotResult(real))) {
        entry.verifiedIds.add(instanceId);
        __scopingTemplateStatsForTests.verified++;
        if (entry.verifiedIds.size >= REQUIRED_VERIFICATIONS) entry.state = "trusted";
      } else {
        disable(entry);
        __scopingTemplateStatsForTests.rejected++;
      }
    }
    return real;
  }

  if (!predicted) return runScopingPipeline(component, instanceId);

  if (verifyEveryReuse()) {
    const copy: BascikComponent = {
      ...component,
      scopedIdNames: component.scopedIdNames === undefined ? undefined : { ...component.scopedIdNames },
    };
    if (component.scopedIdNames === undefined) delete copy.scopedIdNames;
    const real = snapshotResult(runScopingPipeline(copy, instanceId));
    if (!sameResult(real, predicted)) {
      throw new Error(
        `[bascik] scoping template mismatch for <${component.name}> (instance ${instanceId}, field ${differingField(real, predicted)})`,
      );
    }
  }

  __scopingTemplateStatsForTests.reused++;
  return applyResult(component, predicted);
};
