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
 * `true` (default) uses Node's `stripTypeScriptTypes` (22.22+) in strip-only
 * mode, which is line-preserving so `//# sourceURL` line numbers stay
 * accurate; `false` leaves both paths untouched for projects that compile
 * elsewhere; a function is a bring-your-own compiler (esbuild, swc, tsc).
 */

import { stripTypeScriptTypes } from "node:module";
import { BascikConfig } from "./config.ts";
import { ANY_DIRECTIVE_ATTR_NAME } from "./html-patterns.ts";
import { getScriptType } from "./script-types.ts";
import {
  classifySpecifier,
  findModuleSpecifiers,
  hasStaticModuleSyntax,
} from "./module-specifiers.ts";
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
  /** True when the message already names the file, line and column. */
  readonly located: boolean;
  constructor(
    message: string,
    options?: { cause?: unknown; located?: boolean },
  ) {
    super(message, options);
    this.name = "TypeScriptTransformError";
    this.located = options?.located ?? false;
  }
}

/** A 1-based line and column in a source file. */
export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * Where Node's strip-only parser stopped, in `code`'s own lines. Node puts
 * no position on the error object; its stack starts with `:<line>`, then the
 * source lines and a caret line under the offending token. The line is used
 * only when it exists in `code`, and the column only when the line above the
 * caret is that source line, so a change in Node's format gives no position
 * rather than a wrong one.
 */
const stripErrorPosition = (
  err: unknown,
  code: string,
): SourcePosition | undefined => {
  const stack =
    err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const head = /^[^\n]*:(\d+)\n/.exec(stack);
  if (!head) return undefined;
  const line = Number(head[1]);
  const lines = code.split("\n");
  if (!(line >= 1 && line <= lines.length)) return undefined;
  const stackLines = stack.split("\n");
  const caret = stackLines.findIndex((text, i) => i > 0 && /^\s*\^/.test(text));
  const sourceLine = lines[line - 1].replace(/\r$/, "");
  const column =
    caret > 0 && stackLines[caret - 1] === sourceLine
      ? stackLines[caret].indexOf("^") + 1
      : 1;
  return { line, column };
};

/** `line` of `code` with a caret under `column`, indented under the message. */
const codeFrame = (
  code: string,
  position: SourcePosition,
  fileLine: number,
): string => {
  const text = (code.split("\n")[position.line - 1] ?? "").replace(/\r$/, "");
  const gutter = String(fileLine);
  // Tabs stay tabs, so the caret lines up under the same character.
  const pad = text.slice(0, position.column - 1).replace(/[^\t]/g, " ");
  return `\n  ${gutter} | ${text}\n  ${" ".repeat(gutter.length)} | ${pad}^`;
};

const NON_ERASABLE_HINT =
  `\n  Bascik strips erasable TypeScript only (type annotations, interfaces, type aliases, ` +
  `\`as\` casts, \`!\` assertions, \`import type\`). Non-erasable syntax such as \`enum\`, ` +
  `parameter properties, or namespaces with runtime code need a compiler: set scripts.typescript to an esbuild, swc or tsc function.`;

export interface StripOptions {
  /**
   * Where `code`'s first character is in the file `sourceLabel` names, for
   * code cut out of a larger file (an inline block). Absent, `code`'s lines
   * and columns are the file's own (a `.ts` file, or a block padded to its
   * position).
   */
  origin?: SourcePosition;
  /**
   * `code` is an inline block whose place in the file is unknown: an error
   * names its line within the block instead of a file line.
   */
  inline?: boolean;
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
 * Throws a `TypeScriptTransformError` that names `sourceLabel` when the code
 * uses non-erasable syntax (`enum`, parameter properties, runtime
 * namespaces) or is not valid TypeScript at all; when Node reports where, the
 * message names the line and column (see `StripOptions`) with a code frame.
 * Only non-erasable syntax gets the `scripts.typescript` hint: a plain syntax
 * error is fixed in the code, not with a compiler.
 */
export const stripBrowserTypeScript = (
  code: string,
  sourceLabel?: string,
  options: StripOptions = {},
): string => {
  suppressStripExperimentalWarning();
  try {
    return stripTypeScriptTypes(code, { mode: "strip" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const where = sourceLabel ? ` in "${sourceLabel}"` : "";
    const hint =
      (err as NodeJS.ErrnoException)?.code === "ERR_INVALID_TYPESCRIPT_SYNTAX"
        ? ""
        : NON_ERASABLE_HINT;
    const position = stripErrorPosition(err, code);
    if (!position) {
      throw new TypeScriptTransformError(
        `[bascik] TypeScript transformation failed${where}: ${detail}${hint}`,
        { cause: err },
      );
    }
    const { origin } = options;
    const fileLine = origin ? origin.line + position.line - 1 : position.line;
    const fileColumn =
      origin && position.line === 1
        ? origin.column + position.column - 1
        : position.column;
    const at =
      options.inline && !origin
        ? ` at line ${position.line}, column ${position.column} of the <script> block`
        : sourceLabel
          ? ` at ${sourceLabel}:${fileLine}:${fileColumn}`
          : ` at line ${fileLine}, column ${fileColumn}`;
    throw new TypeScriptTransformError(
      `[bascik] TypeScript transformation failed${where}${at}: ${detail}` +
        codeFrame(
          code,
          position,
          options.inline && !origin ? position.line : fileLine,
        ) +
        hint,
      { cause: err, located: !(options.inline && !origin) && !!sourceLabel },
    );
  }
};

/**
 * Static and literal dynamic `import` specifiers a browser cannot load once
 * a module is inlined into a page: a relative (`./`, `../`) or `@/`
 * specifier, which would resolve against the page's URL instead of the
 * source file, and any TypeScript file, which Bascik never publishes. A
 * `/`-rooted path and a full URL to JavaScript are left alone.
 */
export const unbundledModuleImports = (code: string): string[] =>
  findModuleSpecifiers(code)
    .map(({ value }) => value)
    .filter((value) => {
      const kind = classifySpecifier(value);
      return (
        kind === "relative" ||
        kind === "root" ||
        isTypeScriptFile(value.replace(/[?#].*$/, ""))
      );
    });

/**
 * The located error for an inlined TypeScript module that still imports
 * files a browser cannot load (see `unbundledModuleImports`).
 */
export const unbundledImportError = (
  sourcePath: string,
  where: string,
  src: string,
  specifiers: string[],
): TypeScriptTransformError =>
  new TypeScriptTransformError(
    `[bascik] error: "${sourcePath}" (inlined from <script type="module" src="${src}"> at ${where}) ` +
      `imports ${specifiers.map((s) => `"${s}"`).join(", ")}. Bascik inlines the compiled module into the page ` +
      `and does not bundle its imports, so the browser would request ${specifiers.length === 1 ? "that file" : "those files"} ` +
      `from the page's URL and fail. Bundle the module with esbuild (a scripts.typescript function, or a ` +
      `pipeline.exec step that writes a .js file), or import a published JavaScript URL such as "/js/util.js".`,
  );

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
  if (option === true)
    return stripBrowserTypeScript(code, context.sourcePath, {
      inline: context.kind === "inline",
    });

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
 * A directive script (`data-bascik-build`, `-build-once`, `-routes`,
 * `-server`, `-stream`) written in TypeScript: its tag is marked
 * `type="text/typescript"`, as a browser script is, or its `src=` names a
 * `.ts` / `.mts` file. A query or fragment on `src` is ignored.
 */
export const isTypeScriptDirectiveScript = (
  openTag: string,
  srcPath?: string,
): boolean =>
  getScriptType(openTag) === TYPESCRIPT_SCRIPT_TYPE ||
  (srcPath !== undefined && isTypeScriptFile(srcPath.replace(/[?#].*$/, "")));

/**
 * JavaScript for a directive script written in TypeScript, which runs as an
 * ES module on the server. A `scripts.typescript` function compiles it (with
 * `runtime: "server"`); otherwise, `true` or `false`, Node's strip-only mode
 * does, since a directive script always runs in JavaScript and nothing else
 * compiles it. Strip-only output keeps every line and column, so errors and
 * stack traces name the TypeScript source's own positions. `sourcePath` is
 * the `.ts` file, or the HTML file of an inline block.
 *
 * A strip error names the file line and column: `code`'s own when it is a
 * `.ts` file or a block padded to its position, or counted from `origin`,
 * where an unpadded block's first character is. When no position is known
 * (a compiler function failed), the message names `tag`, where the inline
 * block's opening tag is.
 */
export const compileDirectiveTypeScript = async (
  code: string,
  sourcePath: string,
  kind: TypeScriptCompileContext["kind"],
  /** Where an inline block's opening tag is, named when compiling fails. */
  tag?: SourcePosition,
  /**
   * Where `code`'s first character is in `sourcePath`, when not padded;
   * `"unknown"` for an inline block whose place is not known, so an error
   * names the line within the block.
   */
  origin?: SourcePosition | "unknown",
): Promise<string> => {
  const option = resolveCompilerOption();
  try {
    if (typeof option === "function")
      return await transformBrowserTypeScript(code, {
        sourcePath,
        kind,
        runtime: "server",
      });
    return stripBrowserTypeScript(
      code,
      sourcePath,
      origin === "unknown" ? { inline: true } : { origin },
    );
  } catch (err) {
    if (!tag || !(err instanceof TypeScriptTransformError) || err.located)
      throw err;
    throw new TypeScriptTransformError(
      `${err.message}\n  The script starts at ${sourcePath}:${tag.line}:${tag.column}.`,
      { cause: err.cause ?? err },
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
        runtime: "browser",
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
