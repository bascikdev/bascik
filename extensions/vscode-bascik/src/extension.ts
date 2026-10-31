import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import {
  DOCUMENT_SELECTOR,
  initializationOptions,
  SERVER_MODULE,
} from "./client-options";
import {
  ScriptCheckPrompt,
  type ScriptCheckResult,
} from "./script-check-prompt";

/** What `activate` returns. The real-editor tests read it; nothing else depends on it. */
export interface BascikExtensionApi {
  scriptCheck: ScriptCheckPrompt;
  /** The check made at activation, which may show the "html.validate.scripts" prompt. */
  firstScriptCheck: Promise<ScriptCheckResult>;
}

let client: LanguageClient | undefined;

/**
 * Starts the Bascik language server (`@bascik/language-server`, bundled into `dist/server.js`). The server
 * owns every diagnostic, completion, hover, and definition; this extension only connects it to the editor.
 * Resolves once the server has answered `initialize`, so the first open document is analyzed.
 *
 * In a Bascik workspace it also offers, once, to add `"html.validate.scripts": false` to the workspace settings.
 * Nothing changes unless the person clicks; see `script-check-prompt.ts`.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<BascikExtensionApi> {
  const scriptCheck = new ScriptCheckPrompt(context.workspaceState);
  context.subscriptions.push(scriptCheck);
  // Runs beside the server start; a slow file search never delays the language features.
  const firstScriptCheck = scriptCheck.start();
  firstScriptCheck.catch(() => undefined);

  const module = context.asAbsolutePath(SERVER_MODULE);
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: {
      module,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENT_SELECTOR,
    diagnosticCollectionName: "bascik",
    outputChannelName: "Bascik",
    // Read again at every (re)start, so a changed setting applies on the restart below.
    initializationOptions: () => {
      const settings = vscode.workspace.getConfiguration("bascik.typescript");
      return initializationOptions(
        vscode.env.appRoot,
        {
          enabled: settings.get<boolean>("enabled", true),
          path: settings.get<string>("path", ""),
        },
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      );
    },
  };

  client = new LanguageClient("bascik", "Bascik", serverOptions, clientOptions);
  // The server reads the TypeScript settings when it starts, so a change restarts it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("bascik.typescript"))
        void client?.restart();
    }),
  );
  await client.start();
  return { scriptCheck, firstScriptCheck };
}

export async function deactivate(): Promise<void> {
  const stopping = client?.stop();
  client = undefined;
  await stopping;
}
