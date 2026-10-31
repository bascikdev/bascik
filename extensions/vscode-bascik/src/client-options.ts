import { join, resolve } from "node:path";

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
  /** A `typescript` package folder; empty means VS Code's own. */
  path: string;
}

/**
 * Where VS Code keeps its own TypeScript, under the editor's application root. Bascik never bundles TypeScript; the
 * server checks `type="text/typescript"` blocks with this copy unless the `bascik.typescript.path` setting names
 * another. (When it is missing, the server falls back to the project's own `typescript`.)
 */
export function bundledTypeScriptPath(appRoot: string): string {
  return join(appRoot, "extensions", "node_modules", "typescript");
}

/**
 * The server's `initializationOptions` (`BascikInitializationOptions` in the language server). VS Code's HTML
 * support already answers hover and completion inside quoted TypeScript blocks, so the server is told it need not.
 */
export function initializationOptions(
  appRoot: string,
  settings: TypeScriptSettings,
  workspaceFolder: string | undefined,
) {
  const configured = settings.path.trim();
  return {
    typescript: {
      enabled: settings.enabled,
      path:
        configured === ""
          ? bundledTypeScriptPath(appRoot)
          : // A relative setting is read from the (first) workspace folder, as typescript.tsdk is.
            resolve(workspaceFolder ?? appRoot, configured),
    },
    editorHasEmbeddedTypeScript: true,
  };
}
