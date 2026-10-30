/**
 * @module page-typescript
 *
 * A page's own `<script src="name.ts">` (or `.mts`). A browser cannot run
 * TypeScript and Bascik never publishes `.ts` files, so the reference would
 * ship raw TypeScript or a 404. The file is compiled with
 * `scripts.typescript`, as a component's `.ts` companion is, and inlined in
 * place of the reference: the tag keeps its other attributes, and the code
 * names its file in a `//# sourceURL` comment so DevTools shows the file.
 *
 * An inline classic script ignores `defer` and `async`, so a classic tag
 * with either is refused with a located message instead of quietly running
 * at a different time. A `type="module"` script is deferred inline as well,
 * so it keeps its timing. With `scripts.typescript: false` the reference is
 * left as written, for a project that compiles its TypeScript elsewhere.
 */
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  scanAlternatives,
  type ScanAlternative,
} from "./element-content-scan.ts";
import {
  ANY_DIRECTIVE_ATTR_NAME,
  getHtmlAttributeValue,
} from "./html-patterns.ts";
import { getImportRoot } from "./import-root.ts";
import {
  classifySpecifier,
  resolveScriptSrcPath,
} from "./module-specifiers.ts";
import { getScriptType } from "./script-types.ts";
import type { ServerScriptEntry } from "./server-sidecar.ts";
import {
  TypeScriptTransformError,
  compileDirectiveTypeScript,
  hasStaticModuleSyntax,
  isBrowserTypeScriptEnabled,
  isTypeScriptFile,
  transformBrowserTypeScript,
  unbundledImportError,
  unbundledModuleImports,
} from "./typescript.ts";

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const DIRECTIVE_SCRIPT_RE = new RegExp(
  String.raw`\s${ANY_DIRECTIVE_ATTR_NAME}`,
  "i",
);
const SRC_ATTR_RE = /\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;
const TIMING_ATTR_RE = /\s(defer|async)(?=[\s/>=])/i;

/** A comment, `<style>`, `<textarea>`, or a whole script element. */
const SKIPPED_OR_SCRIPT: readonly ScanAlternative[] = [
  { kind: "comment" },
  {
    kind: "element",
    name: "style",
    options: { opener: "tag-space", closer: "regex-space" },
  },
  {
    kind: "element",
    name: "textarea",
    options: { opener: "tag-space", closer: "regex-space" },
  },
  {
    kind: "element",
    name: "script",
    options: { opener: "tag-space", closer: "attributes" },
  },
];
const SCRIPT_ALTERNATIVE = 3;

const toProjectPath = (path: string): string =>
  relative(process.cwd(), path).replace(/\\/g, "/");

/** 1-based line and column of `offset` in `text`. */
const lineAndColumn = (
  text: string,
  offset: number,
): { line: number; column: number } => {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    line: before.split("\n").length,
    column: offset - lineStart + 1,
  };
};

/** A `src` that names a URL, not a file in the project. */
const isUrl = (src: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");

export interface PageTypeScriptResult {
  html: string;
  /** The `.ts` files inlined, as project paths, for the page's dependencies. */
  dependencies: string[];
}

/**
 * Compile and inline every page-level `<script src>` that names a `.ts` or
 * `.mts` file. `pageFile` is the page's path; `authoredHtml`, when given, is
 * the page as read from disk, used to name the line of a refused tag.
 */
export const inlinePageTypeScriptScripts = async (
  html: string,
  pageFile: string,
  authoredHtml?: string,
): Promise<PageTypeScriptResult> => {
  if (!/\.m?ts\b/i.test(html) || !isBrowserTypeScriptEnabled())
    return { html, dependencies: [] };
  const pagePath = toProjectPath(resolve(process.cwd(), pageFile));
  const pageDir = dirname(resolve(process.cwd(), pageFile));
  const edits: Array<{
    start: number;
    end: number;
    open: string;
    src: string;
  }> = [];
  for (const match of scanAlternatives(html, SKIPPED_OR_SCRIPT)) {
    if (match.alternative !== SCRIPT_ALTERNATIVE) continue;
    const open = html.slice(match.start, match.contentStart);
    if (DIRECTIVE_SCRIPT_RE.test(open)) continue;
    const src = getHtmlAttributeValue(open, "src")?.trim();
    if (!src || isUrl(src)) continue;
    if (!isTypeScriptFile(src.replace(/[?#].*$/, ""))) continue;
    edits.push({ start: match.start, end: match.end, open, src });
  }
  if (!edits.length) return { html, dependencies: [] };

  /** Where `open` is in the page as written, for an error. */
  const at = (open: string, index: number): string => {
    const source = authoredHtml ?? html;
    const found = authoredHtml ? source.indexOf(open) : index;
    if (found < 0) return pagePath;
    const { line, column } = lineAndColumn(source, found);
    return `${pagePath}:${line}:${column}`;
  };

  const importRoot = getImportRoot();
  const dependencies: string[] = [];
  const replacements: string[] = [];
  for (const { start, open, src } of edits) {
    const where = at(open, start);
    if (classifySpecifier(src) === "root-slash") {
      throw new TypeScriptTransformError(
        `[bascik] error: <script src="${src}"> at ${where} names a TypeScript file by its site path. ` +
          `Bascik compiles a page's TypeScript script from its source file and inlines it, so name the file ` +
          `relative to the page ("./${src.replace(/^\/+/, "")}") or from scripts.importRoot ("@/${src.replace(/^\/+/, "")}").`,
      );
    }
    const filePath = resolveScriptSrcPath(
      src.replace(/[?#].*$/, ""),
      pageDir,
      importRoot,
    );
    const relPath = toProjectPath(filePath);
    let code: string;
    try {
      code = await readFile(filePath, "utf8");
    } catch (err) {
      throw new TypeScriptTransformError(
        `[bascik] error: <script src="${src}"> at ${where}: "${relPath}" could not be read ` +
          `(${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
          `Bascik compiles a page's .ts script and inlines it; check the path.`,
        { cause: err },
      );
    }
    const isModule = getScriptType(open) === "module";
    if (!isModule && TIMING_ATTR_RE.test(open)) {
      const attribute = TIMING_ATTR_RE.exec(open)![1].toLowerCase();
      throw new TypeScriptTransformError(
        `[bascik] error: <script ${attribute} src="${src}"> at ${where}: Bascik inlines a page's compiled ` +
          `TypeScript, and an inline script ignores ${attribute}, so it would run at a different time. ` +
          `Remove ${attribute} and place the tag at the end of <body>, or mark it type="module" ` +
          `(a module script is deferred inline too).`,
      );
    }
    const compiled = await transformBrowserTypeScript(code, {
      sourcePath: relPath,
      kind: "companion",
      runtime: "browser",
    });
    if (isModule) {
      const unbundled = unbundledModuleImports(compiled);
      if (unbundled.length)
        throw unbundledImportError(relPath, where, src, unbundled);
    }
    if (!isModule && hasStaticModuleSyntax(compiled)) {
      throw new TypeScriptTransformError(
        `[bascik] TypeScript transformation failed in "${relPath}" (referenced at ${where}): ` +
          `the script contains a static import/export declaration, which is only valid in an ES module. ` +
          `Mark the <script src="${src}"> tag type="module", or bundle this file with esbuild first ` +
          `(scripts.typescript) so it has no import/export left.`,
      );
    }
    dependencies.push(relPath);
    const tag = open.replace(SRC_ATTR_RE, "");
    // `</script` inside the code would end the element early; `<\/script`
    // means the same in a string, template, regex or comment.
    const escaped = compiled.replace(/<\/(script)/gi, "<\\/$1");
    const body = escaped.endsWith("\n") ? escaped : `${escaped}\n`;
    replacements.push(`${tag}${body}//# sourceURL=${relPath}\n</script>`);
  }

  let result = "";
  let cursor = 0;
  edits.forEach(({ start, end }, i) => {
    result += html.slice(cursor, start) + replacements[i];
    cursor = end;
  });
  return { html: result + html.slice(cursor), dependencies };
};

/**
 * Compile-check a page's TypeScript server and stream scripts when the page
 * is built (and when dev builds it), so a mistake fails the build with a
 * located message instead of a 500 on the first request: an inline block
 * marked `type="text/typescript"`, and a `src=` module with a `.ts` / `.mts`
 * extension. The same compile runs again when the script runs; this one
 * only reports. `pageFile` is the page's path and `authoredHtml` the page as
 * read from disk, to place an inline block whose line was not recorded.
 */
export const checkServerScriptTypeScript = async (
  entries: Iterable<ServerScriptEntry>,
  pageFile: string,
  authoredHtml: string,
): Promise<void> => {
  const pagePath = toProjectPath(resolve(process.cwd(), pageFile));
  for (const entry of entries) {
    const owner = toProjectPath(
      resolve(process.cwd(), entry.sourceFile ?? pageFile),
    );
    if (entry.modulePath) {
      const src = entry.modulePath.trim().replace(/[?#].*$/, "");
      if (!isTypeScriptFile(src) || isUrl(src)) continue;
      if (classifySpecifier(src) === "root-slash") continue;
      const filePath = resolveScriptSrcPath(
        src,
        dirname(resolve(process.cwd(), owner)),
        getImportRoot(),
      );
      let code: string;
      try {
        code = await readFile(filePath, "utf8");
      } catch {
        // A missing file is reported when the script runs, as before.
        continue;
      }
      await compileDirectiveTypeScript(
        code,
        toProjectPath(filePath),
        "companion",
      );
      continue;
    }
    if (!entry.typescript) continue;
    let origin =
      entry.sourceLine !== undefined
        ? { line: entry.sourceLine, column: entry.sourceColumn ?? 1 }
        : undefined;
    if (!origin && owner === pagePath && entry.source.trim()) {
      const at = authoredHtml.indexOf(entry.source);
      if (at >= 0) origin = lineAndColumn(authoredHtml, at);
    }
    await compileDirectiveTypeScript(
      entry.source,
      owner,
      "inline",
      undefined,
      origin ?? "unknown",
    );
  }
};
