// Which build scripts depend on the page they run for. Dependency-free; Node.js 22.22+.
//
// A `data-bascik-build` script runs once per page with that page's context: BASCIK_PAGE_PATH, BASCIK_PAGE_FILE and,
// in a dynamic route, BASCIK_ROUTE. A `data-bascik-build-once` script runs once and every use shares its output, so
// those three are empty or unset there. BASCIK_SOURCE_FILE is not page context: it names the file the script is
// written in, the same on every page. Heuristic: a script reads page context when its text, or a local module it
// imports (followed transitively), names one of the three variables.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

/** The environment variables that differ from page to page. */
export const PAGE_CONTEXT_VARS = [
  "BASCIK_PAGE_PATH",
  "BASCIK_PAGE_FILE",
  "BASCIK_ROUTE",
];
const PAGE_CONTEXT = /\bBASCIK_(?:PAGE_PATH|PAGE_FILE|ROUTE)\b/;

/** The page-context variables `code` names, in the order of PAGE_CONTEXT_VARS. */
export function pageContextVars(code) {
  return PAGE_CONTEXT_VARS.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(code),
  );
}

/** True when `code` names a page-context variable. */
export const namesPageContext = (code) => PAGE_CONTEXT.test(code);

const IMPORT_SPECIFIERS =
  /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Static, re-exported and literal dynamic import specifiers in `code`. */
export function importSpecifiers(code) {
  return [...code.matchAll(IMPORT_SPECIFIERS)].map((m) => m[1] ?? m[2]);
}

const SCRIPT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cjs"];

/**
 * The file a local specifier names: `./` and `../` from `fromDir`, `@/` from `importRoot`. Undefined for a package
 * or URL specifier. `found` is false when the file does not exist under any script extension.
 */
export function resolveLocalImport(specifier, fromDir, importRoot) {
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = resolve(fromDir, specifier);
  else if (specifier.startsWith("@/"))
    base = resolve(importRoot, specifier.slice(2));
  else return undefined;
  base = base.replace(/[?#].*$/, "");
  const candidates = extname(base)
    ? [base]
    : [
        ...SCRIPT_EXTENSIONS.map((ext) => base + ext),
        ...SCRIPT_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
      ];
  for (const file of candidates)
    if (existsSync(file) && statSync(file).isFile())
      return { file, found: true };
  return { file: candidates[0], found: false };
}

/**
 * Whether a build script's code reads page context. `code` is the inline body or the `src=` file's text, `fromDir`
 * the directory its relative imports resolve from. Returns `{ reads: true, vars, via }` (`via` is the file that
 * names them, or undefined for `code` itself), `{ reads: false }`, or `{ reads: "unknown", missing }` when a local
 * import could not be read, so a caller never reports a script it could not fully see.
 */
export function pageContextOf(code, { fromDir, importRoot }) {
  const seen = new Set();
  const visit = (text, dir, via) => {
    const vars = pageContextVars(text);
    if (vars.length) return { reads: true, vars, via };
    let unknown;
    for (const specifier of importSpecifiers(text)) {
      const target = resolveLocalImport(specifier, dir, importRoot);
      if (!target) continue;
      if (!target.found) {
        unknown ??= { reads: "unknown", missing: specifier };
        continue;
      }
      if (seen.has(target.file)) continue;
      seen.add(target.file);
      let source;
      try {
        source = readFileSync(target.file, "utf8");
      } catch {
        unknown ??= { reads: "unknown", missing: specifier };
        continue;
      }
      const result = visit(source, dirname(target.file), target.file);
      if (result.reads === true) return result;
      if (result.reads === "unknown") unknown ??= result;
    }
    return unknown ?? { reads: false };
  };
  return visit(code, fromDir, undefined);
}
