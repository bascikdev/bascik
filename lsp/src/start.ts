import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { BascikLanguageServer } from "./server.js";

/**
 * Starts the language server on the process's own transport (`--stdio`, `--node-ipc`, or `--socket=<port>`,
 * as the editor passes them). The `bascik-language-server` command and the VS Code extension both start here.
 */
export function startLanguageServer(): BascikLanguageServer {
  const server = new BascikLanguageServer(
    createConnection(ProposedFeatures.all),
  );
  server.listen();
  return server;
}
