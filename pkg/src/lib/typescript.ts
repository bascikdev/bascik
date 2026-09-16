/**
 * @module typescript
 * Browser TypeScript transformation for Bascik.
 *
 * Bascik never ships raw TypeScript to browsers on the two supported paths:
 *
 *  1. Referenced component scripts with a `.ts` / `.mts` extension
 *     (`<script src="counter.ts"></script>`), stripped when the companion file
 *     is inlined by `listComponents`.
 *  2. Inline scripts explicitly marked `<script type="text/typescript">`, in
 *     pages and components, stripped and rewritten to an ordinary `<script>`.
 *
 * Ordinary unmarked `<script>` blocks stay on the JavaScript path. Browsers do
 * not execute TypeScript there, so Bascik never changes their meaning; it only
 * emits a diagnostic when it can positively identify erasable TypeScript
 * syntax in one (`looksLikeTypeScript`).
 *
 * This transformation is a separate concern from `minify.js`. It runs first,
 * so the optional JavaScript minifier (built-in or BYOMinifier) always
 * receives already-valid JavaScript. Node's `stripTypeScriptTypes` (22.18+)
 * is used in strip-only mode, which is line-preserving, so `//# sourceURL`
 * line numbers stay accurate.
 */

import { stripTypeScriptTypes } from "node:module";
import { ANY_DIRECTIVE_ATTR_NAME } from "./html-patterns.ts";
import { getScriptType } from "./script-types.ts";

export const TYPESCRIPT_SCRIPT_TYPE = "text/typescript";

const TYPESCRIPT_FILE_RE = /\.m?ts$/i;

// Whole-attribute-name match: `data-bascik-server-foo` is NOT a directive.
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`, "i");

const SCRIPT_TAG_RE = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi;

const TYPE_ATTR_RE = /\s*\btype\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;

/**
 * Node emits a one-time `ExperimentalWarning` the first time
 * `stripTypeScriptTypes` runs in a thread. Bascik owns this call, so the
 * warning would point users at framework internals they cannot act on.
 * Suppress exactly that warning, once, and leave every other warning alone.
 */
let experimentalWarningSuppressed = false;
const suppressStripExperimentalWarning = (): void => {
  if (experimentalWarningSuppressed) return;
  experimentalWarningSuppressed = true;
  // Node calls `process.emitWarning` synchronously inside the first
  // `stripTypeScriptTypes` call. Intercept that single call and restore the
  // original immediately so no other warning is ever affected.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /stripTypeScriptTypes/.test(message)) {
      process.emitWarning = originalEmitWarning;
      return;
    }
    return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
};

/**
 * Thrown when a supported browser TypeScript path (referenced `.ts` file or
 * `type="text/typescript"` block) cannot be transformed. This is an authoring
 * error: callers that normally downgrade component failures to warnings must
 * let it propagate so a page never ships with a silently missing script.
 */
export class TypeScriptTransformError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TypeScriptTransformError";
  }
}

/** `.ts` or `.mts` browser script file (not `.tsx`, not `.js`). */
export const isTypeScriptFile = (filePath: string): boolean => TYPESCRIPT_FILE_RE.test(filePath);

/**
 * An inline browser script explicitly opted into TypeScript via
 * `type="text/typescript"`. Directive scripts (build/server/routes/stream) run
 * in Node and are never browser TypeScript regardless of their type.
 */
export const isTypeScriptScriptTag = (openTag: string): boolean =>
  !DIRECTIVE_SCRIPT_RE.test(openTag) && getScriptType(openTag) === TYPESCRIPT_SCRIPT_TYPE;

/**
 * Strip erasable TypeScript syntax from `code`, preserving line structure.
 * Throws an `Error` that names `sourceLabel` when the code uses non-erasable
 * syntax (`enum`, parameter properties, runtime namespaces) or is not valid
 * TypeScript at all.
 */
export const stripBrowserTypeScript = (code: string, sourceLabel?: string): string => {
  suppressStripExperimentalWarning();
  try {
    return stripTypeScriptTypes(code, { mode: "strip" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const where = sourceLabel ? ` in "${sourceLabel}"` : "";
    throw new TypeScriptTransformError(
      `[bascik] TypeScript transformation failed${where}: ${detail}\n` +
      `  Bascik strips erasable TypeScript only (type annotations, interfaces, type aliases, ` +
      `\`as\` casts, \`!\` assertions, \`import type\`). Non-erasable syntax such as \`enum\`, ` +
      `parameter properties, or namespaces with runtime code must be compiled with tsc or esbuild first.`,
      { cause: err },
    );
  }
};

/**
 * Positive identification of erasable TypeScript syntax in a script body that
 * was NOT marked as TypeScript. Returns true only when the code is not valid
 * JavaScript but becomes different (and therefore was TypeScript) after
 * stripping. Valid JavaScript, code that is invalid in both languages, and
 * non-erasable TypeScript all return false, so this never produces a false
 * positive that would mask the browser's own SyntaxError.
 */
export const looksLikeTypeScript = (code: string): boolean => {
  if (!code.trim()) return false;
  suppressStripExperimentalWarning();
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(code, { mode: "strip" });
  } catch {
    return false;
  }
  if (stripped === code) return false;
  // Node's stripper rewrites nothing in valid JavaScript, so a difference
  // means type syntax was present. Confirm the result is parseable so a
  // stripper quirk on invalid input cannot masquerade as a TypeScript hit.
  try {
    new Function(stripped);
  } catch {
    // `import`/`export` are not allowed in a Function body; treat the strip
    // difference alone as sufficient evidence for module-shaped code.
    return /^\s*(?:import|export)\b/m.test(stripped);
  }
  return true;
};

/** Remove the `type="..."` attribute from a script open tag. */
const withoutTypeAttribute = (openTag: string): string => {
  const cleaned = openTag.replace(TYPE_ATTR_RE, "");
  // `<script  defer>` -> `<script defer>`; `<script>` stays `<script>`.
  return cleaned.replace(/<script\s+/i, "<script ").replace(/<script\s*>/i, "<script>");
};

/**
 * Transform every inline `<script type="text/typescript">` in `html` into an
 * ordinary `<script>` containing JavaScript. Ordinary inline scripts are left
 * byte-for-byte untouched; when one contains identifiable TypeScript syntax a
 * single warning names the file and the fix.
 *
 * External (`src=`), directive, module, and non-JavaScript scripts are never
 * inspected.
 */
export const transformTypeScriptScriptTags = (
  html: string,
  sourceFile: string,
  options: { diagnose?: boolean } = {},
): string => {
  if (!/<script\b/i.test(html)) return html;
  const diagnose = options.diagnose ?? true;
  // Strip-only passes (no diagnostics) have nothing to do unless a marked
  // TypeScript script is present; skip the per-tag work in that case.
  if (!diagnose && !/text\/typescript/i.test(html)) return html;
  return html.replace(SCRIPT_TAG_RE, (match, open: string, body: string, close: string) => {
    if (DIRECTIVE_SCRIPT_RE.test(open)) return match;
    if (/\bsrc\s*=/i.test(open)) return match;

    if (isTypeScriptScriptTag(open)) {
      const stripped = stripBrowserTypeScript(body, sourceFile);
      return `${withoutTypeAttribute(open)}${stripped}${close}`;
    }

    if (!diagnose) return match;
    const type = getScriptType(open);
    if (type === undefined || type === "text/javascript") {
      if (looksLikeTypeScript(body)) {
        console.warn(
          `[bascik] warning: TypeScript syntax found in an ordinary <script> block in "${sourceFile}". ` +
          `Browsers do not execute TypeScript in an unmarked <script>, so this block will fail at runtime. ` +
          `Mark it <script type="text/typescript"> to have Bascik strip the types, ` +
          `or move it to a companion .ts file referenced with <script src="name.ts">.`,
        );
      }
    }
    return match;
  });
};
