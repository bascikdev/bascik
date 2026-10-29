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
 * receives already-valid JavaScript.
 *
 * Compiler selection is `scripts.typescript` (see `TypeScriptCompilerOption`):
 * `true` (default) uses Node's `stripTypeScriptTypes` (22.18+) in strip-only
 * mode, which is line-preserving so `//# sourceURL` line numbers stay
 * accurate; `false` leaves both paths untouched for projects that compile
 * elsewhere; a function is a bring-your-own compiler (esbuild, swc, tsc).
 */

import { stripTypeScriptTypes } from "node:module";
import { BascikConfig } from "./config.ts";
import { ANY_DIRECTIVE_ATTR_NAME } from "./html-patterns.ts";
import { getScriptType } from "./script-types.ts";
import { hasStaticModuleSyntax } from "./module-specifiers.ts";
import type {
  TypeScriptCompileContext,
  TypeScriptCompilerOption,
} from "./types.ts";

export { hasStaticModuleSyntax };

export const TYPESCRIPT_SCRIPT_TYPE = "text/typescript";

const TYPESCRIPT_FILE_RE = /\.m?ts$/i;

// Whole-attribute-name match: `data-bascik-server-foo` is NOT a directive.
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(
  String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`,
  "i",
);

const TYPE_ATTR_RE = /(?:^|\s+)type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;
// A tag and its whole name, as the tokenizer reads one: up to tag whitespace,
// `/` or `>`, so `<script.x>` and `<style-guide>` are other elements, never a
// script or a raw-text element. Sticky: it is only asked about one `<`.
const TAG_START_RE = /<(\/)?([a-z][^\t\n\f\r />]*)/iy;
const SCRIPT_CLOSE_RE = /<\/script(?:[\t\n\f\r /][^>]*)?>/gi;
const RAW_TEXT_ELEMENTS = new Set([
  "textarea",
  "title",
  "noscript",
  "xmp",
  "style",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

const findTagEnd = (html: string, start: number): number => {
  let quote: string | undefined;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
};

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
    const message =
      typeof warning === "string"
        ? warning
        : ((warning as Error)?.message ?? "");
    const type =
      typeof rest[0] === "string"
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
    if (
      type === "ExperimentalWarning" &&
      /stripTypeScriptTypes/.test(message)
    ) {
      process.emitWarning = originalEmitWarning;
      return;
    }
    return (originalEmitWarning as (...args: unknown[]) => void).call(
      process,
      warning,
      ...rest,
    );
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
export const isTypeScriptFile = (filePath: string): boolean =>
  TYPESCRIPT_FILE_RE.test(filePath);

/**
 * An inline browser script explicitly opted into TypeScript via
 * `type="text/typescript"`. Directive scripts (build/server/routes/stream) run
 * in Node and are never browser TypeScript regardless of their type.
 */
export const isTypeScriptScriptTag = (openTag: string): boolean =>
  !DIRECTIVE_SCRIPT_RE.test(openTag) &&
  getScriptType(openTag) === TYPESCRIPT_SCRIPT_TYPE;

/**
 * Strip erasable TypeScript syntax from `code`, preserving line structure.
 * Throws an `Error` that names `sourceLabel` when the code uses non-erasable
 * syntax (`enum`, parameter properties, runtime namespaces) or is not valid
 * TypeScript at all.
 */
export const stripBrowserTypeScript = (
  code: string,
  sourceLabel?: string,
): string => {
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

/** Resolve `scripts.typescript`, defaulting to the built-in strip. */
const resolveCompilerOption = (): TypeScriptCompilerOption => {
  const option = BascikConfig.scripts?.typescript;
  return option === undefined ? true : option;
};

/** True when Bascik will transform browser TypeScript at all. */
export const isBrowserTypeScriptEnabled = (): boolean =>
  resolveCompilerOption() !== false;

/**
 * Parse check for compiler output. `import`/`export` are not allowed in a
 * `Function` body, so module-shaped output is accepted on the strength of the
 * compiler having returned a string at all; everything else must parse.
 */
const isParseableJavaScript = (code: string): boolean => {
  try {
    new Function(code);
    return true;
  } catch {
    return /^\s*(?:import|export)\b/m.test(code);
  }
};

/**
 * Transform browser TypeScript according to `scripts.typescript`.
 *
 * - `true`: Node strip-only mode via `stripBrowserTypeScript`.
 * - `false`: returns `code` unchanged. Callers that rewrite markup (removing
 *   the `type` attribute) must check `isBrowserTypeScriptEnabled()` first.
 * - function: called with `(code, context)`; must return a string of plain
 *   JavaScript. A throw or non-JavaScript result becomes a
 *   `TypeScriptTransformError` naming `context.sourcePath`, so a broken
 *   compiler fails the build instead of shipping bad output.
 */
export const transformBrowserTypeScript = async (
  code: string,
  context: TypeScriptCompileContext,
): Promise<string> => {
  const option = resolveCompilerOption();
  if (option === false) return code;
  if (option === true) return stripBrowserTypeScript(code, context.sourcePath);

  let output: unknown;
  try {
    output = await option(code, context);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TypeScriptTransformError(
      `[bascik] scripts.typescript compiler failed in "${context.sourcePath}": ${detail}`,
      { cause: err },
    );
  }
  if (typeof output !== "string") {
    throw new TypeScriptTransformError(
      `[bascik] scripts.typescript compiler must return a string of JavaScript for "${context.sourcePath}", ` +
        `received ${output === null ? "null" : typeof output}.`,
    );
  }
  if (!isParseableJavaScript(output)) {
    throw new TypeScriptTransformError(
      `[bascik] TypeScript transformation failed in "${context.sourcePath}": ` +
        `the scripts.typescript compiler did not return valid JavaScript. ` +
        `The function must emit plain JavaScript (for example esbuild with loader: 'ts').`,
    );
  }
  return output;
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
  return cleaned
    .replace(/<script\s+/i, "<script ")
    .replace(/<script\s*>/i, "<script>");
};

/**
 * Both browser TypeScript paths (companion `.ts`, inline `text/typescript`)
 * always land in a classic `<script>` unless the tag is explicitly
 * `type="module"`. Bascik intentionally does not bundle module graphs (that
 * is a job for esbuild, swc, or a browser-native `type="module"` script), so
 * static `import`/`export` surviving the strip is an authoring error, not
 * something to silently rewrite.
 */
const throwModuleSyntaxError = (sourcePath: string): never => {
  throw new TypeScriptTransformError(
    `[bascik] TypeScript transformation failed in "${sourcePath}": ` +
      `the script contains a static import/export declaration, which is only valid in an ES module. ` +
      `Bascik would otherwise wrap this in a classic script IIFE and it would throw a SyntaxError in the browser. ` +
      `Mark the <script> tag type="module" (native ES modules are never wrapped), or bundle this file with ` +
      `esbuild, swc, or another tool first so it has no import/export left.`,
  );
};

/**
 * Transform every inline `<script type="text/typescript">` in `html` into an
 * ordinary `<script>` containing JavaScript, using the configured compiler.
 * When `scripts.typescript` is `false` marked blocks are left exactly as
 * authored, `type` attribute included. Ordinary inline scripts are always left
 * byte-for-byte untouched; when one contains identifiable TypeScript syntax a
 * single warning names the file and the fix.
 *
 * External (`src=`), directive, module, and non-JavaScript scripts are never
 * inspected.
 */
export const transformTypeScriptScriptTags = async (
  html: string,
  sourceFile: string,
  options: { diagnose?: boolean } = {},
): Promise<string> => {
  if (!/<script\b/i.test(html)) return html;
  const diagnose = options.diagnose ?? true;
  // Strip-only passes (no diagnostics) have nothing to do unless a marked
  // TypeScript script is present; skip the per-tag work in that case.
  if (!diagnose && !/text\/typescript/i.test(html)) return html;
  const transformEnabled = isBrowserTypeScriptEnabled();
  const ops: Array<{
    index: number;
    len: number;
    open: string;
    body: string;
    close: string;
  }> = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }

    TAG_START_RE.lastIndex = start;
    const tagMatch = TAG_START_RE.exec(html);
    if (!tagMatch || tagMatch.index !== start) {
      cursor = start + 1;
      continue;
    }
    const tagEnd = findTagEnd(html, start);
    if (tagEnd < 0) break;
    const tagName = tagMatch[2].toLowerCase();
    const open = html.slice(start, tagEnd + 1);
    if (tagMatch[1]) {
      cursor = tagEnd + 1;
      continue;
    }

    if (tagName === "script") {
      SCRIPT_CLOSE_RE.lastIndex = tagEnd + 1;
      const closing = SCRIPT_CLOSE_RE.exec(html);
      if (!closing) break;
      const body = html.slice(tagEnd + 1, closing.index);
      const close = closing[0];
      const fullLength = closing.index + close.length - start;
      cursor = closing.index + close.length;
      if (DIRECTIVE_SCRIPT_RE.test(open)) continue;
      if (/(?:^|\s)src\s*=/i.test(open)) continue;

      if (isTypeScriptScriptTag(open)) {
        if (transformEnabled)
          ops.push({ index: start, len: fullLength, open, body, close });
        continue;
      }

      if (!diagnose) continue;
      const type = getScriptType(open);
      if (
        (type === undefined || type === "text/javascript") &&
        looksLikeTypeScript(body)
      ) {
        console.warn(
          `[bascik] warning: TypeScript syntax found in an ordinary <script> block in "${sourceFile}". ` +
            `Browsers do not execute TypeScript in an unmarked <script>, so this block will fail at runtime. ` +
            `Mark it <script type="text/typescript"> to have Bascik strip the types, ` +
            `or move it to a companion .ts file referenced with <script src="name.ts">.`,
        );
      }
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      if (tagName === "plaintext") {
        cursor = html.length;
        continue;
      }
      const closeTag = new RegExp(
        `</${tagName}(?:[\\t\\n\\f\\r /][^>]*)?>`,
        "ig",
      );
      closeTag.lastIndex = tagEnd + 1;
      const closing = closeTag.exec(html);
      cursor = closing ? closing.index + closing[0].length : html.length;
      continue;
    }
    cursor = tagEnd + 1;
  }
  if (!ops.length) return html;

  const compiled = await Promise.all(
    ops.map(({ body }) =>
      transformBrowserTypeScript(body, {
        sourcePath: sourceFile,
        kind: "inline",
      }),
    ),
  );
  // A `type="text/typescript"` block always comes out as a classic script
  // (the `type` attribute is removed below), so static `import`/`export`
  // syntax in the compiled output would throw a SyntaxError in the browser.
  // Fail the build with an actionable message instead of shipping that.
  for (let i = 0; i < compiled.length; i++) {
    if (hasStaticModuleSyntax(compiled[i])) throwModuleSyntaxError(sourceFile);
  }
  let result = html;
  for (let i = ops.length - 1; i >= 0; i--) {
    const { index, len, open, close } = ops[i];
    result =
      result.slice(0, index) +
      `${withoutTypeAttribute(open)}${compiled[i]}${close}` +
      result.slice(index + len);
  }
  return result;
};
