import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { DOCUMENT_SELECTOR, SERVER_MODULE } from './client-options';

let client: LanguageClient | undefined;

/**
 * Starts the Bascik language server (`@bascik/language-server`, bundled into `dist/server.js`). The server
 * owns every diagnostic, completion, hover, and definition; this extension only connects it to the editor.
 * Resolves once the server has answered `initialize`, so the first open document is analyzed.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath(SERVER_MODULE);
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: {
      module,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENT_SELECTOR,
    diagnosticCollectionName: 'bascik',
    outputChannelName: 'Bascik',
  };

  client = new LanguageClient('bascik', 'Bascik', serverOptions, clientOptions);
  await client.start();
}

export async function deactivate(): Promise<void> {
  const stopping = client?.stop();
  client = undefined;
  await stopping;
}
