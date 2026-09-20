import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type Connection,
  type InitializeParams,
  type InitializeResult,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildSnapshot,
  type ProjectSnapshot,
  isPathInside,
} from './project.js';
import {
  createDiagnostics,
  createCompletions,
  createHover,
  createDefinition,
} from './analyzer.js';

export function uriToFsPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri.slice(7);
    }
  }
  return uri;
}

export class BascikLanguageServer {
  private readonly documents = new TextDocuments(TextDocument);
  private workspaceFolders: string[] = [];
  private readonly projectSnapshots = new Map<string, ProjectSnapshot>();
  private pendingSnapshots = new Map<string, Promise<ProjectSnapshot>>();

  constructor(private readonly connection: Connection) {
    this.documents.listen(this.connection);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.connection.onInitialize(
      (params: InitializeParams): InitializeResult => {
        if (params.workspaceFolders) {
          this.workspaceFolders = params.workspaceFolders.map((wf) =>
            uriToFsPath(wf.uri),
          );
        } else if (params.rootUri) {
          this.workspaceFolders = [uriToFsPath(params.rootUri)];
        } else if (params.rootPath) {
          this.workspaceFolders = [params.rootPath];
        }

        return {
          capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
              triggerCharacters: ['<', ' ', '"', "'", '-'],
              resolveProvider: false,
            },
            hoverProvider: true,
            definitionProvider: true,
          },
        };
      },
    );

    this.documents.onDidChangeContent((change) => {
      void this.validateDocument(change.document);
    });

    this.documents.onDidClose((event) => {
      this.connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    this.connection.onCompletion(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      if (!snapshot) return undefined;
      return createCompletions(document, params.position, snapshot);
    });

    this.connection.onHover(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      if (!snapshot) return undefined;
      return createHover(document, params.position, snapshot);
    });

    this.connection.onDefinition(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      if (!snapshot) return undefined;
      return createDefinition(document, params.position, snapshot, fsPath);
    });

    this.connection.onDidChangeWatchedFiles(() => {
      this.invalidateSnapshots();
      for (const doc of this.documents.all()) {
        void this.validateDocument(doc);
      }
    });
  }

  public invalidateSnapshots(): void {
    this.projectSnapshots.clear();
    this.pendingSnapshots.clear();
  }

  public async getSnapshotForFile(
    fsPath: string,
  ): Promise<ProjectSnapshot | undefined> {
    const projectRoot = this.findProjectRoot(fsPath);
    if (!projectRoot) return undefined;

    let snapshot = this.projectSnapshots.get(projectRoot);
    if (snapshot) return snapshot;

    let pending = this.pendingSnapshots.get(projectRoot);
    if (!pending) {
      pending = buildSnapshot(projectRoot).then((snap) => {
        this.projectSnapshots.set(projectRoot, snap);
        this.pendingSnapshots.delete(projectRoot);
        return snap;
      });
      this.pendingSnapshots.set(projectRoot, pending);
    }
    return pending;
  }

  private findProjectRoot(fsPath: string): string | undefined {
    let current = path.dirname(path.resolve(fsPath));
    const roots = this.workspaceFolders.map((r) => path.resolve(r));

    while (roots.some((r) => isPathInside(current, r))) {
      const candidates = [
        'bascik.config.ts',
        'bascik.config.js',
        'bascik.config.mjs',
      ];
      if (candidates.some((c) => fs.existsSync(path.join(current, c)))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    // Fall back to workspace folder
    return roots.find((r) => isPathInside(fsPath, r));
  }

  private async validateDocument(document: TextDocument): Promise<void> {
    const fsPath = uriToFsPath(document.uri);
    const snapshot = await this.getSnapshotForFile(fsPath);
    const openDocs = this.documents.all().map((d) => ({
      fsPath: uriToFsPath(d.uri),
      text: d.getText(),
    }));

    const diagnostics = createDiagnostics(
      document,
      fsPath,
      snapshot,
      openDocs,
    );

    this.connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics,
    });
  }

  public listen(): void {
    this.connection.listen();
  }
}
