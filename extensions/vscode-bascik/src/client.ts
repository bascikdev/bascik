import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Try locating the bundled or workspace language server binary/module
  const serverModule = context.asAbsolutePath(
    path.join('node_modules', '@bascik', 'language-server', 'dist', 'bin.js'),
  );

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'html' },
      { scheme: 'file', language: 'css' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescript' },
    ],
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/bascik.config.{ts,js,mjs}'),
        vscode.workspace.createFileSystemWatcher('**/*.html'),
        vscode.workspace.createFileSystemWatcher('**/*.css'),
      ],
    },
  };

  client = new LanguageClient(
    'bascik-language-server',
    'Bascik Language Server',
    serverOptions,
    clientOptions,
  );

  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
