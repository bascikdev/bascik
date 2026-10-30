/**
 * @module scoping-instantiate
 *
 * Replay of a recorded `ScopingTemplate` for a fresh instance id (prompt 157).
 * scoping-template.ts records the real scoping pipeline once per distinct
 * component input and derives later instances by renaming; the renaming half
 * lives here, parameterized on the name hash, so a request-time renderer can
 * instantiate the same templates on a host without `node:*` (the manifest
 * ships them as JSON and the host supplies its own sha256).
 *
 * This module must stay portable: no `node:*` imports, no `process`, no
 * config module. `serverless-contract.test.ts` bundles it for a Web platform.
 */
import type { BascikComponent } from "./types.ts";

/** Text split at token occurrences: `parts[0] + t[tokens[0]] + parts[1] + …`. */
export interface Segmented {
  parts: string[];
  tokens: number[];
}

export interface ScopingTemplate {
  instanceId: string;
  tokenCount: number;
  /** Hashes to recompute, in recorded order: `token = hashName(input)`. */
  steps: Array<{ input: Segmented; token: number }>;
  fileContent: Segmented;
  cssFileContent: Segmented | undefined;
  scopedIdNames: Segmented | undefined;
  requiresPerInstanceCss: boolean | undefined;
  size: number;
}

/** The scoping pipeline's output fields, with `scopedIdNames` as JSON text. */
export interface ScopingResult {
  fileContent: string;
  cssFileContent: string | undefined;
  scopedIdNames: string | undefined;
  requiresPerInstanceCss: boolean | undefined;
}

export const join = (segmented: Segmented, values: string[]): string => {
  let text = segmented.parts[0];
  for (let index = 0; index < segmented.tokens.length; index++) {
    text += values[segmented.tokens[index]] + segmented.parts[index + 1];
  }
  return text;
};

/**
 * The token values for `instanceId`: the id itself, then every recorded hash
 * replayed through `hashName` in order. Null when two computed names coincide,
 * which the template's renaming cannot represent.
 */
export const replayTemplateTokens = (
  template: ScopingTemplate,
  instanceId: string,
  hashName: (input: string) => string,
): string[] | null => {
  const values = new Array<string>(template.tokenCount);
  values[0] = instanceId;
  for (const step of template.steps)
    values[step.token] = hashName(join(step.input, values));
  if (new Set(values).size !== values.length) return null;
  return values;
};

/** The template's output with every token replaced by its value. */
export const realizeTemplate = (
  template: ScopingTemplate,
  values: string[],
): ScopingResult => ({
  fileContent: join(template.fileContent, values),
  cssFileContent:
    template.cssFileContent === undefined
      ? undefined
      : join(template.cssFileContent, values),
  scopedIdNames:
    template.scopedIdNames === undefined
      ? undefined
      : join(template.scopedIdNames, values),
  requiresPerInstanceCss: template.requiresPerInstanceCss,
});

/**
 * The result a template predicts for `instanceId`, or null when the computed
 * names collide with each other.
 *
 * Unlike `instantiateScopingTemplate` (scoping-template.ts), this does not
 * check the computed names against the component's authored text: a request
 * host does not have that text. Every computed name embeds the request id
 * (`r` + 7 hex, a shape no build id takes), either verbatim or as the input
 * of a 12-character hash, so a name can only coincide with authored text
 * that spells out that request id or its hash, which is not checked.
 */
export const instantiateTemplate = (
  template: ScopingTemplate,
  instanceId: string,
  hashName: (input: string) => string,
): ScopingResult | null => {
  const values = replayTemplateTokens(template, instanceId, hashName);
  return values && realizeTemplate(template, values);
};

/**
 * Copy a `ScopingResult` onto `component` the way `scopeComponentInstance`
 * applies a reused template: `scopedIdNames` is parsed from its JSON text and
 * an absent field is deleted rather than set to undefined, so the object
 * matches what the real pipeline leaves behind. Mutates and returns
 * `component`; a request host applies it to a copy of the usage.
 */
export const applyScopingResult = (
  component: BascikComponent,
  result: ScopingResult,
): BascikComponent => {
  component.fileContent = result.fileContent;
  if (result.cssFileContent === undefined) delete component.cssFileContent;
  else component.cssFileContent = result.cssFileContent;
  if (result.scopedIdNames === undefined) delete component.scopedIdNames;
  else
    component.scopedIdNames = JSON.parse(result.scopedIdNames) as Record<
      string,
      string
    >;
  if (result.requiresPerInstanceCss === undefined)
    delete component.requiresPerInstanceCss;
  else component.requiresPerInstanceCss = result.requiresPerInstanceCss;
  return component;
};
