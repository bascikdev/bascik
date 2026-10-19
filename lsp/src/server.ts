import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  type Connection,
  DidChangeWatchedFilesNotification,
  type Disposable,
  FileChangeType,
  type FileSystemWatcher,
  type InitializeParams,
  type InitializeResult,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  buildSnapshot,
  CONFIG_FILE_CANDIDATES,
  type ProjectSnapshot,
  isConfigFile,
  isExcludedProjectPath,
  isInsideComponentRoots,
  isPathInside,
} from "./project.js";
import {
  createDiagnostics,
  createCompletions,
  createHover,
  createDefinition,
  createCodeActions,
} from "./analyzer.js";

/** Files whose changes can alter a diagnostic: project config, and the HTML that defines or uses components. */
const WATCHED_FILE_PATTERNS = ["**/bascik.config.{ts,js,mjs}", "**/*.html"];

/** Quiet period before open documents are checked again after a change elsewhere in the project. */
const REVALIDATION_DELAY_MS = 50;

export interface WatchedFileChange {
  fsPath: string;
  type: FileChangeType;
}

export function uriToFsPath(uri: string): string {
  if (uri.startsWith("file://")) {
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
  private readonly revalidationTimers = new Map<
    string,
    { timer: NodeJS.Timeout; htmlOnly: boolean }
  >();
  private clientWatchesFiles = false;
  private clientWatchesFolders = false;
  private clientSendsFolderChanges = false;
  private watcherRegistration: Disposable | undefined;

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
        this.clientWatchesFiles =
          params.capabilities.workspace?.didChangeWatchedFiles
            ?.dynamicRegistration === true;
        this.clientWatchesFolders =
          params.capabilities.workspace?.didChangeWatchedFiles
            ?.relativePatternSupport === true;
        this.clientSendsFolderChanges =
          params.capabilities.workspace?.workspaceFolders === true;

        return {
          capabilities: {
            workspace: {
              workspaceFolders: { supported: true, changeNotifications: true },
            },
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
              triggerCharacters: ["<", " ", '"', "'", "-"],
              resolveProvider: false,
            },
            hoverProvider: true,
            definitionProvider: true,
            codeActionProvider: true,
          },
        };
      },
    );

    // Ask the editor to report changes to project config and HTML files. A component edited on disk, or a new
    // config file, changes what the open documents should say, and the server cannot see either on its own.
    this.connection.onInitialized(() => {
      void this.registerFileWatchers();
      // The connection throws if this is asked of a client that cannot send these changes, so it waits for the
      // client's answer to `initialize`.
      if (this.clientSendsFolderChanges) {
        this.connection.workspace.onDidChangeWorkspaceFolders((event) => {
          this.changeWorkspaceFolders(
            event.removed.map((folder) => uriToFsPath(folder.uri)),
            event.added.map((folder) => uriToFsPath(folder.uri)),
          );
        });
      }
    });

    this.documents.onDidChangeContent((change) => {
      void this.validateDocument(change.document);
      // Open HTML buffers feed prop usage into other documents' diagnostics.
      if (change.document.languageId === "html") {
        this.scheduleRevalidation(change.document, true);
      }
    });

    this.documents.onDidClose((event) => {
      this.connection.sendDiagnostics({
        uri: event.document.uri,
        diagnostics: [],
      });
      // Closing an open HTML buffer changes which usages supply component props.
      if (event.document.languageId === "html") {
        this.scheduleRevalidation(event.document, true);
      }
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

    this.connection.onCodeAction(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      return createCodeActions(
        document,
        params.range,
        params.context.diagnostics,
        snapshot,
        fsPath,
      );
    });

    this.connection.onDidChangeWatchedFiles((params) => {
      void this.handleWatchedFileChanges(
        params.changes.map((change) => ({
          fsPath: uriToFsPath(change.uri),
          type: change.type,
        })),
      );
    });
  }

  /**
   * Follows the editor adding or removing workspace folders. A removed folder's projects are forgotten and its
   * open documents stop having diagnostics; a re-added folder starts again from disk.
   */
  public changeWorkspaceFolders(removed: string[], added: string[]): void {
    const removedRoots = removed.map((root) => path.resolve(root));
    this.workspaceFolders = [
      ...this.workspaceFolders.filter(
        (root) => !removedRoots.includes(path.resolve(root)),
      ),
      ...added,
    ];
    for (const projectRoot of [
      ...this.projectSnapshots.keys(),
      ...this.pendingSnapshots.keys(),
    ]) {
      if (removedRoots.some((root) => isPathInside(projectRoot, root))) {
        this.invalidateProject(projectRoot);
      }
    }
    void this.registerFileWatchers();
    this.scheduleRevalidation(undefined, false);
  }

  /**
   * Asks the editor to report changes to config and HTML files, replacing any earlier request. Each workspace
   * folder is watched with a pattern relative to it when the editor supports that, because an editor watches a
   * folder named that way directly and promptly. A bare `**` pattern is matched against whatever events the
   * editor happens to see, which can arrive seconds late.
   */
  private async registerFileWatchers(): Promise<void> {
    if (!this.clientWatchesFiles) return;
    this.watcherRegistration?.dispose();
    this.watcherRegistration = undefined;
    const watchers: FileSystemWatcher[] = this.clientWatchesFolders
      ? this.workspaceFolders.flatMap((folder) =>
          WATCHED_FILE_PATTERNS.map((pattern) => ({
            globPattern: { baseUri: pathToFileURL(folder).toString(), pattern },
          })),
        )
      : WATCHED_FILE_PATTERNS.map((globPattern) => ({ globPattern }));
    if (watchers.length === 0) return;
    this.watcherRegistration = await this.connection.client.register(
      DidChangeWatchedFilesNotification.type,
      { watchers },
    );
  }

  /** Forgets every project snapshot, so the next request rebuilds them from disk. */
  public invalidateSnapshots(): void {
    this.projectSnapshots.clear();
    this.pendingSnapshots.clear();
  }

  private invalidateProject(projectRoot: string): void {
    this.projectSnapshots.delete(projectRoot);
    this.pendingSnapshots.delete(projectRoot);
  }

  /**
   * Applies file changes the editor reported. A changed config or component file rebuilds that project's
   * snapshot. A changed page or other HTML file only updates the stored usage text, so saving a page does not
   * re-read the whole project. Open documents are then checked again, since either can change a diagnostic.
   */
  public async handleWatchedFileChanges(
    changes: WatchedFileChange[],
  ): Promise<void> {
    let everything = false;
    const affectedRoots = new Set<string>();

    for (const { fsPath, type } of changes) {
      const workspaceRoot = this.workspaceFolders.find((root) =>
        isPathInside(fsPath, root),
      );
      if (workspaceRoot && isExcludedProjectPath(fsPath, workspaceRoot))
        continue;

      if (isConfigFile(fsPath)) {
        // A config file appearing or disappearing also changes which project the files below it belong to.
        this.invalidateProject(path.dirname(path.resolve(fsPath)));
        everything = true;
        continue;
      }
      if (!fsPath.toLowerCase().endsWith(".html")) continue;

      const projectRoot = this.findProjectRoot(fsPath);
      if (!projectRoot) continue;
      affectedRoots.add(projectRoot);
      const snapshot = this.projectSnapshots.get(projectRoot);
      if (!snapshot) {
        // Not built yet, or still building from files that may already be stale.
        this.invalidateProject(projectRoot);
        continue;
      }
      const normalized = fsPath.replace(/\\/g, "/");
      if (isInsideComponentRoots(normalized, snapshot.componentRoots)) {
        this.invalidateProject(projectRoot);
        continue;
      }
      if (!isPathInside(fsPath, path.join(projectRoot, "src"))) continue;

      let html: string | undefined;
      if (type !== FileChangeType.Deleted) {
        try {
          html = await fsPromises.readFile(fsPath, "utf8");
        } catch {
          html = undefined;
        }
      }
      // A newer change rebuilt the snapshot while the file was being read: that rebuild already has it.
      if (this.projectSnapshots.get(projectRoot) !== snapshot) continue;
      if (html === undefined) snapshot.htmlUsageByFile.delete(fsPath);
      else snapshot.htmlUsageByFile.set(fsPath, html);
    }

    if (everything) {
      this.scheduleRevalidation(undefined, false);
    } else {
      for (const projectRoot of affectedRoots) {
        this.scheduleRevalidation(projectRoot, false);
      }
    }
  }

  public async getSnapshotForFile(
    fsPath: string,
  ): Promise<ProjectSnapshot | undefined> {
    const projectRoot = this.findProjectRoot(fsPath);
    if (!projectRoot) return undefined;

    const snapshot = this.projectSnapshots.get(projectRoot);
    if (snapshot) return snapshot;

    let pending = this.pendingSnapshots.get(projectRoot);
    if (!pending) {
      const building: Promise<ProjectSnapshot> = buildSnapshot(
        projectRoot,
      ).then((snap) => {
        // Dropped from the pending list means a change invalidated this build while it ran. Hand the result
        // to this caller only: it may already be out of date, and the next caller builds a fresh one.
        if (this.pendingSnapshots.get(projectRoot) === building) {
          this.projectSnapshots.set(projectRoot, snap);
          this.pendingSnapshots.delete(projectRoot);
        }
        return snap;
      });
      pending = building;
      this.pendingSnapshots.set(projectRoot, pending);
    }
    return pending;
  }

  private findProjectRoot(fsPath: string): string | undefined {
    let current = path.dirname(path.resolve(fsPath));
    const roots = this.workspaceFolders.map((r) => path.resolve(r));

    while (roots.some((r) => isPathInside(current, r))) {
      const workspaceRoot = roots.find((r) => isPathInside(current, r))!;
      if (
        !isExcludedProjectPath(current, workspaceRoot) &&
        CONFIG_FILE_CANDIDATES.some((c) => fs.existsSync(path.join(current, c)))
      ) {
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
    // Only files on disk have a project. Other schemes (git, output, untitled) must not get diagnostics.
    if (!document.uri.startsWith("file:")) return;
    const version = document.version;
    const fsPath = uriToFsPath(document.uri);
    // A file outside every workspace folder belongs to no project, so there is nothing to check it against.
    if (!this.workspaceFolders.some((root) => isPathInside(fsPath, root))) {
      this.connection.sendDiagnostics({
        uri: document.uri,
        version,
        diagnostics: [],
      });
      return;
    }
    const snapshot = await this.getSnapshotForFile(fsPath);
    // The document was edited or closed while the project was read; a newer check follows or the file is gone.
    if (this.documents.get(document.uri)?.version !== version) return;
    const openDocs = this.documents.all().map((d) => ({
      fsPath: uriToFsPath(d.uri),
      text: d.getText(),
    }));

    const diagnostics = createDiagnostics(document, fsPath, snapshot, openDocs);

    this.connection.sendDiagnostics({
      uri: document.uri,
      version,
      diagnostics,
    });
  }

  /**
   * Checks open documents again shortly, so a burst of changes costs one pass. With a document or a project
   * root, only that project is checked; without one, every open document is. `htmlOnly` limits the pass to
   * HTML documents.
   */
  private scheduleRevalidation(
    scope: TextDocument | string | undefined,
    htmlOnly: boolean,
  ): void {
    const projectRoot =
      typeof scope === "string"
        ? scope
        : scope
          ? this.findProjectRoot(uriToFsPath(scope.uri))
          : undefined;
    const key = projectRoot ?? "*";
    const previous = this.revalidationTimers.get(key);
    if (previous) clearTimeout(previous.timer);
    const onlyHtml = previous ? previous.htmlOnly && htmlOnly : htmlOnly;
    const timer = setTimeout(() => {
      this.revalidationTimers.delete(key);
      for (const document of this.documents.all()) {
        if (onlyHtml && document.languageId !== "html") continue;
        if (
          projectRoot &&
          this.findProjectRoot(uriToFsPath(document.uri)) !== projectRoot
        ) {
          continue;
        }
        void this.validateDocument(document);
      }
    }, REVALIDATION_DELAY_MS);
    this.revalidationTimers.set(key, { timer, htmlOnly: onlyHtml });
  }

  public listen(): void {
    this.connection.listen();
  }

  /** Cancels pending checks. For tests and shutdown. */
  public dispose(): void {
    for (const { timer } of this.revalidationTimers.values())
      clearTimeout(timer);
    this.revalidationTimers.clear();
    this.watcherRegistration?.dispose();
    this.watcherRegistration = undefined;
  }
}
