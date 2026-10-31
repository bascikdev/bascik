import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { BascikLanguageServer } from "./server.js";
import {
  createInProcessTypeScriptEngine,
  createWorkerTypeScriptEngine,
} from "./typescript-engine.js";

export interface StartLanguageServerOptions {
  /**
   * The file a worker thread runs to check TypeScript blocks: `typescript-worker.js` beside this file, or a bundle
   * holding it. Left out, TypeScript runs on the main thread, after the server's own work.
   */
  typeScriptWorker?: string | URL;
  /** Where to resolve an installed peer `typescript` after the project (this package's location). */
  typeScriptFallbackFrom?: string;
}

/**
 * Starts the language server on the process's own transport (`--stdio`, `--node-ipc`, or `--socket=<port>`,
 * as the editor passes them). The `bascik-language-server` command and the VS Code extension both start here.
 */
export function startLanguageServer(
  options: StartLanguageServerOptions = {},
): BascikLanguageServer {
  const { typeScriptWorker, typeScriptFallbackFrom } = options;
  const server = new BascikLanguageServer(
    createConnection(ProposedFeatures.all),
    {
      createTypeScriptEngine: (settings) => {
        const engineSettings = {
          ...settings,
          fallbackFrom: typeScriptFallbackFrom,
        };
        return typeScriptWorker === undefined
          ? createInProcessTypeScriptEngine(engineSettings)
          : createWorkerTypeScriptEngine(typeScriptWorker, engineSettings);
      },
    },
  );
  server.listen();
  return server;
}
