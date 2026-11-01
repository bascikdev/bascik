import { join } from "node:path";

/**
 * Which documents the language server analyzes. Only files on disk have a project, so other schemes
 * (git diffs, output panels, untitled buffers) are never sent to it.
 */
export const DOCUMENT_SELECTOR = [
  "html",
  "css",
  "javascript",
  "typescript",
].map((language) => ({
  scheme: "file",
  language,
}));

/** The language server bundle, next to the extension bundle, relative to the extension folder. */
export const SERVER_MODULE = "dist/server.js";

/** The `bascik.typescript.*` settings the server is started with. */
export interface TypeScriptSettings {
  enabled: boolean;
  /** An absolute path to a `typescript` package folder; empty means VS Code's own. */
  path: string;
}

/**
 * Where VS Code keeps its own TypeScript, under the editor's application root. Bascik never bundles TypeScript; the
 * server checks `type="text/typescript"` blocks with this copy unless the `bascik.typescript.path` setting names
 * another that works. (When it is missing too, the server falls back to the project's own `typescript`.)
 */
export function bundledTypeScriptPath(appRoot: string): string {
  return join(appRoot, "extensions", "node_modules", "typescript");
}

/**
 * The server's `initializationOptions` (`BascikInitializationOptions` in the language server). The setting goes in
 * `path` and VS Code's own copy in `editorPath`, so a mistyped or broken setting falls back to VS Code's copy (and
 * the server shows a warning) instead of turning the checks off. While VS Code's HTML support runs
 * (`htmlLanguageFeatures`), it answers hover, completion, definition and signature help about a page's own names
 * inside quoted TypeScript blocks, so the server answers only what it cannot; with it disabled, the server answers
 * everything.
 */
export function initializationOptions(
  appRoot: string,
  settings: TypeScriptSettings,
  htmlLanguageFeatures: boolean,
) {
  const configured = settings.path.trim();
  return {
    typescript: {
      enabled: settings.enabled,
      // As written: the server rejects a relative path (with a warning) rather than load code from whichever
      // workspace is open.
      path: configured === "" ? undefined : configured,
      editorPath: bundledTypeScriptPath(appRoot),
    },
    editorHasEmbeddedTypeScript: htmlLanguageFeatures,
  };
}
