/**
 * A fake language server connection for the server's tests: the slice of the connection the server uses, with the
 * handlers it registers. The `.test.util` name keeps it out of the published package and out of Vitest's test files.
 */
import { vi } from "vitest";

type Handler = (...args: any[]) => any;

/** The slice of a language server connection that the server uses, recording the handlers it registers. */
export function createFakeConnection() {
  const handlers = new Map<string, Handler>();
  // The real connection only allows registering for folder changes once the client has said it sends them.
  const state = { clientSendsFolderChanges: false };
  const register = (name: string) =>
    vi.fn((handler: Handler) => {
      handlers.set(name, handler);
      return { dispose() {} };
    });
  const connection = {
    onInitialize: register("initialize"),
    onInitialized: register("initialized"),
    onCompletion: register("completion"),
    onHover: register("hover"),
    onDefinition: register("definition"),
    onReferences: register("references"),
    onCodeAction: register("codeAction"),
    onDidChangeWatchedFiles: register("watchedFiles"),
    onDidOpenTextDocument: register("didOpen"),
    onDidChangeTextDocument: register("didChange"),
    onDidCloseTextDocument: register("didClose"),
    onWillSaveTextDocument: register("willSave"),
    onWillSaveTextDocumentWaitUntil: register("willSaveWaitUntil"),
    onDidSaveTextDocument: register("didSave"),
    sendDiagnostics: vi.fn<Handler>(),
    listen: vi.fn<Handler>(),
    client: {
      register: vi.fn(
        async (..._args: unknown[]): Promise<{ dispose(): void }> => ({
          dispose() {},
        }),
      ),
    },
    console: {
      error: vi.fn<Handler>(),
      warn: vi.fn<Handler>(),
      info: vi.fn<Handler>(),
      log: vi.fn<Handler>(),
    },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn((handler: Handler) => {
        if (!state.clientSendsFolderChanges) {
          throw new Error(
            "Client doesn't support sending workspace folder change events.",
          );
        }
        handlers.set("workspaceFolders", handler);
        return { dispose() {} };
      }),
    },
  };
  return { connection, handlers, state };
}
