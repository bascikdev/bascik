/**
 * @module browser-imports
 * Bundle the local imports of a TypeScript browser script at build time.
 *
 * A browser script written in TypeScript (a component's `.ts` companion, an
 * inline `<script type="text/typescript">` block, or a page's own
 * `<script src="app.ts">`) is inlined into the page, so the browser would
 * resolve `import { parse } from "./parse.ts"` against the page's URL and
 * fail. When such a script imports a relative (`./`, `../`) or `@/` path,
 * Bascik bundles those files into the script with esbuild, so the large
 * script's pure logic can live in small modules that unit tests import
 * directly. Each imported `.ts` file goes through the same
 * `scripts.typescript` compiler as the script itself, so the erasable-only
 * rule and a custom compiler apply to it too.
 *
 * Only local files are bundled. A full URL, a `/`-rooted path and a bare
 * package name stay as written (a module script may import them; a classic
 * script then fails the existing "static import in a classic script" check).
 * A script with no local import is returned byte for byte, so its output and
 * its CSP hash do not change.
 *
 * esbuild is an optional peer dependency: it is loaded the first time a
 * script needs it, and a build that needs it without it fails naming the
 * script and the install command.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getImportRoot } from "./import-root.ts";
import {
  classifySpecifier,
  findModuleSpecifiers,
  hasStaticModuleSyntax,
} from "./module-specifiers.ts";
import {
  TypeScriptTransformError,
  isTypeScriptFile,
  transformBrowserTypeScript,
} from "./typescript.ts";

type Esbuild = Pick<typeof import("esbuild"), "build">;

/** A script's code with its local imports bundled, and the files it read. */
export interface BundledBrowserScript {
  code: string;
  /** Project-relative, `/`-separated paths of every bundled file. */
  dependencies: string[];
}

export interface BundleBrowserImportsOptions {
  /** The script's own file (a `.ts` companion or page script), or the HTML file holding an inline block. */
  sourceFile: string;
  /** True for an inline `<script type="text/typescript">` block, whose lines are the block's own. */
  inline?: boolean;
  /**
   * Wrap the bundle in a function, for a classic script Bascik does not wrap
   * itself (a page's own), so the bundled modules' names stay out of the
   * page's global scope. A bundle that still imports something is left
   * unwrapped, for the caller's classic-script check to refuse.
   */
  wrap?: boolean;
}

/** The relative and `@/` specifiers `code` imports, static or literal dynamic. */
export const localModuleImports = (code: string): string[] =>
  /\bimport\b/.test(code)
    ? findModuleSpecifiers(code)
        .map(({ value }) => value)
        .filter((value) => {
          const kind = classifySpecifier(value);
          return kind === "relative" || kind === "root";
        })
    : [];

const SCRIPT_FILE_RE = /\.m?[jt]s$/i;

const toProjectPath = (absolute: string): string =>
  relative(process.cwd(), absolute).replace(/\\/g, "/");

let loadEsbuildOverride: (() => Promise<Esbuild | undefined>) | undefined;
let esbuildPromise: Promise<Esbuild | undefined> | undefined;

/** esbuild's `build`, from Bascik's own dependencies or the project's. */
const loadEsbuild = (): Promise<Esbuild | undefined> => {
  if (loadEsbuildOverride) return loadEsbuildOverride();
  esbuildPromise ??= (async () => {
    const pick = (mod: unknown): Esbuild | undefined => {
      const m = mod as Partial<Esbuild> & { default?: Partial<Esbuild> };
      const build = m.build ?? m.default?.build;
      return typeof build === "function" ? { build } : undefined;
    };
    try {
      return pick(await import("esbuild"));
    } catch {
      // Not beside Bascik (a linked or globally installed Bascik): try the project.
    }
    try {
      const fromProject = createRequire(join(process.cwd(), "package.json"));
      return pick(
        await import(pathToFileURL(fromProject.resolve("esbuild")).href),
      );
    } catch {
      return undefined;
    }
  })();
  return esbuildPromise;
};

/** Replace how esbuild is loaded; `undefined` restores the real loader. */
export const __setEsbuildLoaderForTests = (
  loader: (() => Promise<Esbuild | undefined>) | undefined,
): void => {
  loadEsbuildOverride = loader;
  esbuildPromise = undefined;
};

interface EsbuildMessage {
  text: string;
  detail?: unknown;
  location?: { file: string; line: number; column: number } | null;
}

/** The first error thrown by Bascik's own compile step, if esbuild wrapped one. */
const wrappedTransformError = (
  errors: readonly EsbuildMessage[],
): TypeScriptTransformError | undefined =>
  errors
    .map(({ detail }) => detail)
    .find(
      (detail): detail is TypeScriptTransformError =>
        detail instanceof TypeScriptTransformError,
    );

/**
 * Bundle the relative and `@/` imports of the compiled browser script `code`
 * into it. Returns `code` unchanged, with no dependencies, when it imports no
 * local file.
 */
export const bundleBrowserImports = async (
  code: string,
  options: BundleBrowserImportsOptions,
): Promise<BundledBrowserScript> => {
  const specifiers = localModuleImports(code);
  if (specifiers.length === 0) return { code, dependencies: [] };
  const sourceFile = resolve(process.cwd(), options.sourceFile);
  const label = toProjectPath(sourceFile);
  const scriptName = options.inline
    ? `the <script type="text/typescript"> in "${label}"`
    : `"${label}"`;
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    throw new TypeScriptTransformError(
      `[bascik] error: ${scriptName} imports ${specifiers.map((s) => `"${s}"`).join(", ")}. ` +
        `Bascik bundles a TypeScript script's local imports with esbuild, which is not installed. ` +
        `Install it in the project (npm install --save-dev esbuild), or import a published JavaScript URL such as "/js/util.js".`,
    );
  }
  const importRoot = getImportRoot();
  // esbuild reads a relative `sourcefile` against `resolveDir`, so the entry
  // is named by its absolute path; an inline block gets a suffix of its own.
  const entryName = options.inline
    ? `${sourceFile} (inline script)`
    : sourceFile;
  const isEntry = (file: string): boolean =>
    resolve(process.cwd(), file) === entryName;
  try {
    const result = await esbuild.build({
      stdin: {
        contents: code,
        resolveDir: dirname(sourceFile),
        sourcefile: entryName,
        loader: "js",
      },
      absWorkingDir: process.cwd(),
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      target: "esnext",
      charset: "utf8",
      logLevel: "silent",
      plugins: [
        {
          name: "bascik-browser-imports",
          setup(build) {
            build.onResolve({ filter: /^@\// }, (args) =>
              build
                .resolve(`./${args.path.slice(2)}`, {
                  kind: args.kind,
                  resolveDir: importRoot,
                })
                .then((resolved) =>
                  resolved.errors.length
                    ? {
                        errors: [
                          {
                            text: `Could not resolve "${args.path}" (scripts.importRoot is "${toProjectPath(importRoot) || "."}")`,
                          },
                        ],
                      }
                    : { path: resolved.path },
                ),
            );
            // Only local files are bundled: a URL, a `/`-rooted site path or
            // a package name is the browser's to load.
            build.onResolve({ filter: /.*/ }, (args) =>
              args.kind === "entry-point" ||
              classifySpecifier(args.path) === "relative"
                ? undefined
                : { path: args.path, external: true },
            );
            build.onLoad({ filter: /.*/ }, async (args) => {
              const path = toProjectPath(args.path);
              if (!SCRIPT_FILE_RE.test(args.path)) {
                return {
                  errors: [
                    {
                      text: `"${path}" is not a JavaScript or TypeScript file (${extname(args.path) || "no extension"}). Bascik bundles only .ts, .mts, .js and .mjs imports into a browser script`,
                    },
                  ],
                };
              }
              const source = await readFile(args.path, "utf8");
              const contents = isTypeScriptFile(args.path)
                ? await transformBrowserTypeScript(source, {
                    sourcePath: path,
                    kind: "companion",
                    runtime: "browser",
                  })
                : source;
              return { contents, loader: "js" };
            });
          },
        },
      ],
    });
    const dependencies = Object.keys(result.metafile?.inputs ?? {})
      .filter((input) => !isEntry(input))
      .map((input) => toProjectPath(resolve(process.cwd(), input)));
    const text = result.outputFiles?.[0]?.text ?? "";
    const wrapped =
      options.wrap && !hasStaticModuleSyntax(text)
        ? `(() => {\n${text}})();\n`
        : text;
    return { code: wrapped, dependencies };
  } catch (err) {
    const errors = ((err as { errors?: EsbuildMessage[] }).errors ??
      []) as EsbuildMessage[];
    const own = wrappedTransformError(errors);
    if (own) throw own;
    if (errors.length === 0) throw err;
    const lines = errors.map(({ text, location }) => {
      if (!location) return `  ${text}`;
      const where = isEntry(location.file)
        ? options.inline
          ? `line ${location.line} of the script`
          : `${label}:${location.line}:${location.column + 1}`
        : `${toProjectPath(resolve(process.cwd(), location.file))}:${location.line}:${location.column + 1}`;
      return `  ${where}: ${text}`;
    });
    throw new TypeScriptTransformError(
      `[bascik] error: Bascik could not bundle the local imports of ${scriptName}:\n${lines.join("\n")}`,
      { cause: err },
    );
  }
};
