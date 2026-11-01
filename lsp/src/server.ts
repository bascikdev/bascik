import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  type Connection,
  type Diagnostic,
  DiagnosticSeverity,
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
  hasIsolatedClientBlocks,
  pageScopeComponentHtml,
  isInsideComponentRoots,
  isPathInside,
  isUsageSourcePath,
} from "./project.js";
import {
  createDiagnostics,
  createCompletions,
  createHover,
  createDefinition,
  createCodeActions,
} from "./analyzer.js";
import { createReferences } from "./references.js";
import { EXTENSION_CONFIG_FILES } from "./config-reader.js";
import {
  hasTypeScriptBlocks,
  relocateBlockRanges,
  typeScriptBlockAt,
} from "./typescript-blocks.js";
import type {
  TypeScriptCheckRequest,
  TypeScriptEngine,
  TypeScriptEngineSettings,
  TypeScriptFeatureAnswers,
  TypeScriptFeatureKind,
} from "./typescript-engine.js";
import {
  toLspCompletionItem,
  toLspHover,
  toLspLocation,
  toLspSignatureHelp,
} from "./typescript-lsp.js";
import {
  TYPESCRIPT_DIAGNOSTIC_SOURCE,
  type TypeScriptDiagnostic,
} from "./typescript-service.js";

/** Files whose changes can alter a diagnostic: project config, and the HTML that defines or uses components. */
const WATCHED_FILE_PATTERNS = ["**/bascik.config.{ts,js,mjs}", "**/*.html"];

/**
 * With TypeScript checks on, also the files a `type="text/typescript"` block can import and the files that decide
 * how it is checked.
 */
const TYPESCRIPT_WATCHED_FILE_PATTERNS = [
  "**/*.{ts,mts,cts,js,mjs,cjs}",
  "**/{tsconfig,package}.json",
];

/** A page about to be checked with TypeScript: the text it is checked at, and the engine's request, if any. */
interface TypeScriptPageCheck {
  document: TextDocument;
  version: number;
  text: string;
  request?: TypeScriptCheckRequest;
}

/** Files an edit to which can change a TypeScript block's errors. */
const TYPESCRIPT_INPUT_FILE =
  /\.(?:[mc]?ts|[mc]?js)$|(?:^|[\\/])(?:tsconfig|package)\.json$/i;

/**
 * Completion trigger characters only TypeScript blocks use (a member after `.`, an import path after `/`). Bascik's
 * own completions are for markup, so a request these trigger asks TypeScript alone.
 */
const TYPESCRIPT_TRIGGER_CHARACTERS = [".", "/"];

/** Quiet period after an edit before TypeScript checks the open pages again. Bascik's diagnostics do not wait. */
const TYPESCRIPT_DELAY_MS = 150;

/**
 * How long no open page may have TypeScript blocks before the TypeScript engine is released. Its programs hold
 * the DOM library and Node's types (a few hundred megabytes); a page closed and opened again soon should not pay
 * for building them twice.
 */
export const TYPESCRIPT_RELEASE_DELAY_MS = 30_000;

/** What the client may pass in `initializationOptions`. */
export interface BascikInitializationOptions {
  typescript?: {
    /** `false` turns TypeScript checks of `type="text/typescript"` blocks off. Default `true`. */
    enabled?: boolean;
    /** A `typescript` package folder to use first (VS Code passes the `bascik.typescript.path` setting). */
    path?: string;
    /**
     * The editor's own `typescript` package folder, used when `path` is not given or cannot be used, before the
     * project's own (VS Code passes its bundled copy).
     */
    editorPath?: string;
    /**
     * Milliseconds TypeScript stays loaded once no open page has TypeScript blocks, before its memory is given
     * back. Default 30000.
     */
    releaseDelayMs?: number;
  };
  /**
   * The editor answers hover, completion, definition and signature help inside quoted `type="text/typescript"`
   * blocks itself, for what the page declares (VS Code's HTML support does, and cannot be turned off), so the
   * server answers only what the editor cannot: symbols, members and calls from other files, and import paths.
   * TypeScript errors are sent either way. Default `false`: the server answers everything.
   */
  editorHasEmbeddedTypeScript?: boolean;
}

/** The client's options with every field checked, since any client can send anything. */
export function readInitializationOptions(value: unknown): {
  typescriptEnabled: boolean;
  typescriptPath: string | undefined;
  typescriptEditorPath: string | undefined;
  typescriptReleaseDelayMs: number | undefined;
  editorHasEmbeddedTypeScript: boolean;
} {
  const options =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const typescript =
    typeof options.typescript === "object" && options.typescript !== null
      ? (options.typescript as Record<string, unknown>)
      : {};
  const pathOption = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  return {
    typescriptEnabled: typescript.enabled !== false,
    typescriptPath: pathOption(typescript.path),
    typescriptEditorPath: pathOption(typescript.editorPath),
    typescriptReleaseDelayMs:
      typeof typescript.releaseDelayMs === "number" &&
      Number.isFinite(typescript.releaseDelayMs) &&
      typescript.releaseDelayMs >= 0
        ? typescript.releaseDelayMs
        : undefined,
    editorHasEmbeddedTypeScript: options.editorHasEmbeddedTypeScript === true,
  };
}

export interface BascikLanguageServerOptions {
  /**
   * Starts the engine that checks `type="text/typescript"` blocks, with the client's TypeScript settings. Left
   * out, TypeScript checks are off.
   */
  createTypeScriptEngine?: (
    settings: TypeScriptEngineSettings,
  ) => TypeScriptEngine;
  /**
   * How long no open page may have TypeScript blocks before the engine is released, giving TypeScript's memory
   * back. Default `TYPESCRIPT_RELEASE_DELAY_MS`.
   */
  typeScriptReleaseDelayMs?: number;
}

/**
 * The packages whose presence in a package.json makes a folder without a config a Bascik project: Bascik itself
 * (a zero-config site), or the language server on its own (a linter-only component library).
 */
const BASCIK_PACKAGES = ["@bascik/bascik", "@bascik/language-server"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Quiet period before open documents are checked again after a change elsewhere in the project. */
const REVALIDATION_DELAY_MS = 50;

export interface WatchedFileChange {
  fsPath: string;
  type: FileChangeType;
}

/**
 * The real path of `fsPath`, resolving symlinks in the part of it that exists, so a deleted file still
 * resolves through its folder.
 */
function realPathOfExisting(fsPath: string): string {
  let existing = path.resolve(fsPath);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(fsPath);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
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
  /**
   * Open buffers whose file the editor reported deleted, by URI, with the buffer's version at that moment.
   * VS Code keeps a model for every file it previewed (Peek, the References panel) after the file is deleted,
   * so such a buffer stops counting as a usage source until it is edited (its version moves on), closed, or
   * the file comes back.
   */
  private readonly deletedBuffers = new Map<string, number>();
  /** What each project root's package.json said about @bascik/bascik, keyed by its path, until the file changes. */
  private readonly packageJsonChecks = new Map<
    string,
    { mtimeMs: number; size: number; dependsOnBascik: boolean }
  >();
  /** Project roots already named in the output panel as not Bascik projects, so the note is written once. */
  private readonly reportedNonBascikRoots = new Set<string>();
  /** The TypeScript engine, when the client left TypeScript checks on and the host can start one. */
  private typeScript: TypeScriptEngine | undefined;
  /** Whether the editor answers language features about a page's own names inside TypeScript blocks itself. */
  public editorHasEmbeddedTypeScript = false;
  /** The last diagnostics of each kind per open document; a publish sends both, since it replaces the list. */
  private readonly bascikDiagnostics = new Map<string, Diagnostic[]>();
  /**
   * TypeScript's last result per open document, in offsets of the text it was checked against. A publish for a
   * newer text moves the ranges with their blocks (see `currentTypeScriptDiagnostics`).
   */
  private readonly typeScriptResults = new Map<
    string,
    { text: string; diagnostics: TypeScriptDiagnostic[] }
  >();
  /** The diagnostics last sent per document, so a TypeScript result that changes nothing is not sent again. */
  private readonly lastSentDiagnostics = new Map<string, string>();
  /**
   * The TypeScript checks owed per project: the pages edited since the last check, or every open page after a
   * change that can affect them all (an imported file, a tsconfig, the Bascik config).
   */
  private readonly typeScriptPending = new Map<
    string,
    { timer?: NodeJS.Timeout; all: boolean; pages: Set<string> }
  >();
  /** Bumped per project on every TypeScript input change, so a check of several pages stops once it is stale. */
  private readonly typeScriptGenerations = new Map<string, number>();
  /** Releases the TypeScript engine once no open page has TypeScript blocks (see `scheduleTypeScriptRelease`). */
  private typeScriptReleaseTimer: NodeJS.Timeout | undefined;
  private typeScriptReleaseDelayMs = TYPESCRIPT_RELEASE_DELAY_MS;
  /** Project roots whose missing TypeScript has been noted in the output panel. */
  private readonly reportedTypeScriptRoots = new Set<string>();
  /** Whether the client's unusable TypeScript path has been shown, which happens once: it is one setting. */
  private reportedClientPathProblem = false;

  constructor(
    private readonly connection: Connection,
    private readonly options: BascikLanguageServerOptions = {},
  ) {
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
        const clientOptions = readInitializationOptions(
          params.initializationOptions,
        );
        this.editorHasEmbeddedTypeScript =
          clientOptions.editorHasEmbeddedTypeScript;
        this.typeScriptReleaseDelayMs =
          clientOptions.typescriptReleaseDelayMs ??
          this.options.typeScriptReleaseDelayMs ??
          TYPESCRIPT_RELEASE_DELAY_MS;
        if (clientOptions.typescriptEnabled) {
          this.typeScript = this.options.createTypeScriptEngine?.({
            clientPath: clientOptions.typescriptPath,
            editorPath: clientOptions.typescriptEditorPath,
          });
        }

        return {
          capabilities: {
            workspace: {
              workspaceFolders: { supported: true, changeNotifications: true },
            },
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
              triggerCharacters: [
                "<",
                " ",
                '"',
                "'",
                "-",
                ...TYPESCRIPT_TRIGGER_CHARACTERS,
              ],
              resolveProvider: false,
            },
            signatureHelpProvider: {
              triggerCharacters: ["(", ","],
              retriggerCharacters: [")"],
            },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
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
      this.typeScriptInputChanged(change.document, false);
    });

    this.documents.onDidClose((event) => {
      this.deletedBuffers.delete(event.document.uri);
      this.bascikDiagnostics.delete(event.document.uri);
      this.typeScriptResults.delete(event.document.uri);
      this.lastSentDiagnostics.delete(event.document.uri);
      this.connection.sendDiagnostics({
        uri: event.document.uri,
        diagnostics: [],
      });
      this.typeScriptInputChanged(event.document, true);
      // Closing an open HTML buffer changes which usages supply component props.
      if (event.document.languageId === "html") {
        this.scheduleRevalidation(event.document, true);
      }
    });

    // Bascik's own answers first; inside a TypeScript block, TypeScript's (see `typeScriptFeature`).
    this.connection.onCompletion(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const trigger = params.context?.triggerCharacter;
      const typeScriptOnly =
        trigger !== undefined &&
        TYPESCRIPT_TRIGGER_CHARACTERS.includes(trigger);
      const snapshot = typeScriptOnly
        ? undefined
        : await this.getSnapshotForFile(fsPath);
      const bascik = snapshot
        ? createCompletions(document, params.position, snapshot)
        : undefined;
      const typeScript = await this.typeScriptFeature(
        document,
        params.position,
        "completion",
        trigger,
      );
      if (!typeScript?.length) return bascik;
      return [
        ...(bascik ?? []),
        ...typeScript.map((entry) => toLspCompletionItem(document, entry)),
      ];
    });

    this.connection.onHover(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      const bascik = snapshot
        ? createHover(document, params.position, snapshot)
        : undefined;
      if (bascik) return bascik;
      const typeScript = await this.typeScriptFeature(
        document,
        params.position,
        "hover",
      );
      return typeScript ? toLspHover(document, typeScript) : undefined;
    });

    this.connection.onDefinition(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const fsPath = uriToFsPath(document.uri);
      const snapshot = await this.getSnapshotForFile(fsPath);
      const bascik = snapshot
        ? createDefinition(document, params.position, snapshot, fsPath)
        : undefined;
      // Bascik's own (an import path in a directive script, a component) is the one answer: never both.
      if (bascik?.length) return bascik;
      const typeScript = await this.typeScriptFeature(
        document,
        params.position,
        "definition",
      );
      return typeScript?.length ? typeScript.map(toLspLocation) : bascik;
    });

    this.connection.onSignatureHelp(async (params) => {
      const document = this.documents.get(params.textDocument.uri);
      if (!document) return undefined;
      const typeScript = await this.typeScriptFeature(
        document,
        params.position,
        "signatureHelp",
      );
      return typeScript ? toLspSignatureHelp(typeScript) : undefined;
    });

    // Find All References for a component. Every failure is an empty list, never an error.
    this.connection.onReferences(async (params) => {
      const uri = params.textDocument.uri;
      if (!uri.startsWith("file:")) return [];
      const fsPath = uriToFsPath(uri);
      // A request can name a file that is not open, such as one listed in the References panel.
      let document = this.documents.get(uri);
      if (!document && fsPath.toLowerCase().endsWith(".html")) {
        try {
          const text = await fsPromises.readFile(fsPath, "utf8");
          document = TextDocument.create(uri, "html", 0, text);
        } catch {
          return [];
        }
      }
      if (!document) return [];
      const snapshot = await this.getSnapshotForFile(fsPath);
      if (!snapshot) return [];
      return createReferences({
        document,
        fsPath,
        position: params.position,
        includeDeclaration: params.context?.includeDeclaration === true,
        snapshot,
        sources: this.referenceSources(snapshot),
      });
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
   * A buffer the editor keeps open for a file deleted on disk (VS Code keeps the model of a file it showed
   * in Peek or References), unedited since. It is not a source of usages for references or diagnostics.
   */
  private isOrphanedBuffer(document: TextDocument): boolean {
    return this.deletedBuffers.get(document.uri) === document.version;
  }

  /** Open documents that still stand for a file or unsaved work, so their usages count. */
  private liveOpenDocuments(): TextDocument[] {
    return this.documents
      .all()
      .filter((document) => !this.isOrphanedBuffer(document));
  }

  /**
   * The text of every HTML file in a project that can use a component: pages and other HTML under `src` and
   * the pages folder, and every component file, with open buffers' unsaved text in place of what is on disk.
   * A buffer left open for a deleted file is not a source.
   */
  private referenceSources(snapshot: ProjectSnapshot): Map<string, string> {
    const sources = new Map<string, string>(snapshot.componentSourceByFile);
    for (const [file, text] of snapshot.htmlUsageByFile)
      sources.set(file, text);
    for (const document of this.documents.all()) {
      if (document.languageId !== "html" || !document.uri.startsWith("file:"))
        continue;
      const fsPath = uriToFsPath(document.uri);
      if (!fsPath.toLowerCase().endsWith(".html")) continue;
      if (this.isOrphanedBuffer(document)) continue;
      if (this.findProjectRoot(fsPath) !== snapshot.projectRoot) continue;
      if (isExcludedProjectPath(fsPath, snapshot.projectRoot)) continue;
      if (
        !isUsageSourcePath(fsPath, snapshot) &&
        !isInsideComponentRoots(
          fsPath.replace(/\\/g, "/"),
          snapshot.componentRoots,
        )
      )
        continue;
      sources.set(fsPath, document.getText());
    }
    return sources;
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
    const patterns = this.typeScript
      ? [...WATCHED_FILE_PATTERNS, ...TYPESCRIPT_WATCHED_FILE_PATTERNS]
      : WATCHED_FILE_PATTERNS;
    const watchers: FileSystemWatcher[] = this.clientWatchesFolders
      ? this.workspaceFolders.flatMap((folder) =>
          patterns.map((pattern) => ({
            globPattern: { baseUri: pathToFileURL(folder).toString(), pattern },
          })),
        )
      : patterns.map((globPattern) => ({ globPattern }));
    if (watchers.length === 0) return;
    // Called with `void`, so a rejection here (an editor refusing the registration, or a connection
    // closing mid-request) would be unhandled and end the process. Without watchers the server still
    // works; it only misses changes made outside open documents.
    try {
      this.watcherRegistration = await this.connection.client.register(
        DidChangeWatchedFilesNotification.type,
        { watchers },
      );
    } catch (error) {
      this.connection.console.error(
        `Bascik could not ask the editor to watch config and HTML files, so changes made outside open documents are not picked up until a reload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

    for (const change of changes) {
      const { type } = change;
      const fsPath = this.toWorkspaceSpelling(change.fsPath);
      this.trackDeletedBuffers(fsPath, type);
      const workspaceRoot = this.workspaceFolders.find((root) =>
        isPathInside(fsPath, root),
      );
      if (workspaceRoot && isExcludedProjectPath(fsPath, workspaceRoot))
        continue;

      if (isConfigFile(fsPath)) {
        // A config file appearing or disappearing also changes which project the files below it belong to.
        const configRoot = path.dirname(path.resolve(fsPath));
        this.invalidateProject(configRoot);
        if (this.typeScript) {
          // Its import root and script scoping decide what TypeScript reports.
          this.typeScript.forgetProject(configRoot);
          this.scheduleTypeScriptCheck(configRoot, undefined);
        }
        everything = true;
        continue;
      }
      if (this.typeScript && TYPESCRIPT_INPUT_FILE.test(fsPath)) {
        // An open buffer is the newer text; the engine already has it.
        if (!this.documents.get(pathToFileURL(fsPath).toString()))
          this.typeScript.fileChanged(fsPath);
        const projectRoot = this.findProjectRoot(fsPath);
        if (projectRoot) this.scheduleTypeScriptCheck(projectRoot, undefined);
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
      if (!isUsageSourcePath(fsPath, snapshot)) continue;

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

  /**
   * A watcher can report a path through a symlink's target (`/private/tmp/site/...` for a `/tmp/site`
   * workspace, or a symlinked home folder) while the workspace folder, the snapshot and open documents use
   * the folder's own spelling. Returns the path in that spelling when it lies in a workspace folder only
   * once symlinks are resolved; otherwise as given.
   */
  private toWorkspaceSpelling(fsPath: string): string {
    if (this.workspaceFolders.some((root) => isPathInside(fsPath, root)))
      return fsPath;
    const real = realPathOfExisting(fsPath);
    for (const root of this.workspaceFolders) {
      const realRoot = realPathOfExisting(root);
      if (isPathInside(real, realRoot))
        return path.join(path.resolve(root), path.relative(realRoot, real));
    }
    return fsPath;
  }

  /** Notes open buffers left behind by a deleted file or folder, and forgets them when the file is back. */
  private trackDeletedBuffers(fsPath: string, type: FileChangeType): void {
    if (type !== FileChangeType.Deleted && this.deletedBuffers.size === 0)
      return;
    const target = realPathOfExisting(fsPath);
    for (const document of this.documents.all()) {
      if (!document.uri.startsWith("file:")) continue;
      const documentPath = uriToFsPath(document.uri);
      if (
        !isPathInside(documentPath, fsPath) &&
        !isPathInside(realPathOfExisting(documentPath), target)
      )
        continue;
      if (type === FileChangeType.Deleted)
        this.deletedBuffers.set(document.uri, document.version);
      else this.deletedBuffers.delete(document.uri);
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

  /**
   * Does Bascik check this project? A folder with a `bascik.config.*` does. A workspace folder without one (the
   * fallback in `findProjectRoot`) is a Bascik project only when its root has a language server config
   * (`bascik.ext.json` and the rest of {@link EXTENSION_CONFIG_FILES}, which a global install of the linter
   * relies on) or its package.json lists one of {@link BASCIK_PACKAGES}. Otherwise it is some other project, and
   * the output panel says so once. Navigation, hover and completion still work there; only diagnostics are
   * withheld.
   */
  private isBascikProject(projectRoot: string): boolean {
    if (
      [...CONFIG_FILE_CANDIDATES, ...EXTENSION_CONFIG_FILES].some((candidate) =>
        fs.existsSync(path.join(projectRoot, candidate)),
      )
    ) {
      this.reportedNonBascikRoots.delete(projectRoot);
      return true;
    }
    const isBascik = this.packageJsonDependsOnBascik(projectRoot);
    if (isBascik) {
      this.reportedNonBascikRoots.delete(projectRoot);
    } else if (!this.reportedNonBascikRoots.has(projectRoot)) {
      this.reportedNonBascikRoots.add(projectRoot);
      this.connection.console.info(
        `${projectRoot} is not a Bascik project: it has no ${CONFIG_FILE_CANDIDATES.join(", ")} or ${EXTENSION_CONFIG_FILES.join(", ")}, and its package.json does not list ${BASCIK_PACKAGES.join(" or ")}, so it gets no Bascik diagnostics. Add any one of them to check it.`,
      );
    }
    return isBascik;
  }

  /** Reads `<projectRoot>/package.json` again only when its size or modification time changed. */
  private packageJsonDependsOnBascik(projectRoot: string): boolean {
    const file = path.join(projectRoot, "package.json");
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      this.packageJsonChecks.delete(file);
      return false;
    }
    const cached = this.packageJsonChecks.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.dependsOnBascik;
    }
    let dependsOnBascik = false;
    try {
      const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      dependsOnBascik = DEPENDENCY_FIELDS.some((field) => {
        const dependencies =
          typeof manifest === "object" && manifest !== null
            ? (manifest as Record<string, unknown>)[field]
            : undefined;
        return (
          typeof dependencies === "object" &&
          dependencies !== null &&
          BASCIK_PACKAGES.some((name) => Object.hasOwn(dependencies, name))
        );
      });
    } catch (error) {
      this.connection.console.info(
        `${file} could not be read (${error instanceof Error ? error.message : String(error)}), so it does not make ${projectRoot} a Bascik project.`,
      );
    }
    this.packageJsonChecks.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      dependsOnBascik,
    });
    return dependsOnBascik;
  }

  private async validateDocument(document: TextDocument): Promise<void> {
    // Only files on disk have a project. Other schemes (git, output, untitled) must not get diagnostics.
    if (!document.uri.startsWith("file:")) return;
    const version = document.version;
    const fsPath = uriToFsPath(document.uri);
    // A file outside every workspace folder belongs to no project, so there is nothing to check it against.
    if (!this.workspaceFolders.some((root) => isPathInside(fsPath, root))) {
      this.typeScriptResults.delete(document.uri);
      this.publish(document.uri, version, []);
      return;
    }
    // A React or Vue app has its own src/components and src/api; Bascik's rules do not apply there.
    const projectRoot = this.findProjectRoot(fsPath);
    if (projectRoot && !this.isBascikProject(projectRoot)) {
      this.typeScriptResults.delete(document.uri);
      this.publish(document.uri, version, []);
      return;
    }
    const snapshot = await this.getSnapshotForFile(fsPath);
    // The document was edited or closed while the project was read; a newer check follows or the file is gone.
    if (this.documents.get(document.uri)?.version !== version) return;
    const openDocs = this.liveOpenDocuments().map((d) => ({
      fsPath: uriToFsPath(d.uri),
      text: d.getText(),
    }));

    const diagnostics = createDiagnostics(document, fsPath, snapshot, openDocs);

    this.publish(document.uri, version, diagnostics);
  }

  /**
   * Sends a document's Bascik diagnostics with its latest TypeScript diagnostics. A publish replaces the
   * document's whole list, so each kind is sent with the other's last result. TypeScript's may be from an older
   * text until its next check: they are moved with their blocks, and dropped from a block whose text changed.
   */
  private publish(uri: string, version: number, bascik: Diagnostic[]): void {
    this.bascikDiagnostics.set(uri, bascik);
    this.send(uri, version, [
      ...bascik,
      ...this.currentTypeScriptDiagnostics(uri),
    ]);
  }

  private send(uri: string, version: number, diagnostics: Diagnostic[]): void {
    this.lastSentDiagnostics.set(uri, JSON.stringify(diagnostics));
    this.connection.sendDiagnostics({ uri, version, diagnostics });
  }

  /**
   * The document's last TypeScript diagnostics, located in its current text. Ranges checked against an older
   * text move with their block when only the text around it changed, and are left out when the block itself
   * changed, until TypeScript checks it again: an editor would otherwise show them on the wrong code.
   */
  private currentTypeScriptDiagnostics(uri: string): Diagnostic[] {
    const result = this.typeScriptResults.get(uri);
    const document = this.documents.get(uri);
    if (!result || !document) return [];
    const text = document.getText();
    if (result.text !== text) {
      result.diagnostics = relocateBlockRanges(
        result.text,
        text,
        result.diagnostics,
      );
      result.text = text;
    }
    return result.diagnostics.map((diagnostic) =>
      toLspDiagnostic(document, diagnostic),
    );
  }

  /**
   * An edit to an open document that TypeScript blocks depend on: a page's own text, or a file a block may import
   * (whose unsaved text the engine reads instead of the file on disk).
   */
  private typeScriptInputChanged(
    document: TextDocument,
    closed: boolean,
  ): void {
    if (!this.typeScript || !document.uri.startsWith("file:")) return;
    const fsPath = uriToFsPath(document.uri);
    const projectRoot = this.findProjectRoot(fsPath);
    if (document.languageId === "html") {
      if (closed && projectRoot) this.typeScript.closePage(projectRoot, fsPath);
      if (closed) this.scheduleTypeScriptRelease();
      if (!closed && projectRoot) {
        // A page edit only changes that page's blocks, unless it is a component whose scripts run in the scope
        // of the pages that use it (`scoping.scriptBlocks` off): their names are those pages' globals.
        const snapshot = this.projectSnapshots.get(projectRoot);
        const sharesPageScope =
          snapshot?.scopesScriptBlocks === false &&
          isInsideComponentRoots(fsPath, snapshot.componentRoots);
        this.scheduleTypeScriptCheck(
          projectRoot,
          sharesPageScope ? undefined : document.uri,
        );
      }
      return;
    }
    if (!TYPESCRIPT_INPUT_FILE.test(fsPath)) return;
    this.typeScript.setOpenFile(
      fsPath,
      closed ? undefined : document.getText(),
    );
    if (projectRoot) this.scheduleTypeScriptCheck(projectRoot, undefined);
  }

  /**
   * Checks a page with TypeScript after a quiet period, or (with no page) every open page of the project, when a
   * file they may all import changed. A page's blocks import nothing from other pages, so a page edit checks that
   * page only. Earlier requests for the project go stale at once, so a running check stops instead of finishing
   * work nobody reads; the pages it had yet to check stay owed.
   */
  private scheduleTypeScriptCheck(
    projectRoot: string,
    pageUri: string | undefined,
  ): void {
    const engine = this.typeScript;
    if (!engine) return;
    engine.cancel(projectRoot);
    this.typeScriptGenerations.set(
      projectRoot,
      (this.typeScriptGenerations.get(projectRoot) ?? 0) + 1,
    );
    this.oweTypeScriptCheck(
      projectRoot,
      pageUri === undefined ? "all" : [pageUri],
      true,
    );
  }

  /** Records pages (or every page) the project's next TypeScript check must cover, and starts its timer. */
  private oweTypeScriptCheck(
    projectRoot: string,
    pages: string[] | "all",
    restartTimer: boolean,
  ): void {
    const engine = this.typeScript;
    if (!engine) return;
    let pending = this.typeScriptPending.get(projectRoot);
    if (!pending) {
      pending = { all: false, pages: new Set() };
      this.typeScriptPending.set(projectRoot, pending);
    }
    if (pages === "all") pending.all = true;
    else for (const page of pages) pending.pages.add(page);
    if (pending.timer && !restartTimer) return;
    if (pending.timer) clearTimeout(pending.timer);
    const owed = pending;
    owed.timer = setTimeout(() => {
      if (this.typeScriptPending.get(projectRoot) === owed)
        this.typeScriptPending.delete(projectRoot);
      void this.checkTypeScriptProject(engine, projectRoot, owed);
    }, TYPESCRIPT_DELAY_MS);
  }

  private async checkTypeScriptProject(
    engine: TypeScriptEngine,
    projectRoot: string,
    owed: { all: boolean; pages: Set<string> },
  ): Promise<void> {
    const open = this.documents
      .all()
      .filter(
        (document) =>
          document.languageId === "html" &&
          document.uri.startsWith("file:") &&
          this.findProjectRoot(uriToFsPath(document.uri)) === projectRoot,
      );
    // The edited pages first, then (after a change every page may see) the rest.
    const pages = [
      ...open.filter((document) => owed.pages.has(document.uri)),
      ...(owed.all
        ? open.filter((document) => !owed.pages.has(document.uri))
        : []),
    ];
    const generation = this.typeScriptGenerations.get(projectRoot);
    const checks: TypeScriptPageCheck[] = [];
    for (const document of pages)
      checks.push(await this.typeScriptPageCheck(projectRoot, document));
    // Every page the engine will check, given together, so TypeScript builds its programs once rather than once
    // per page (opening many pages at once otherwise rebuilt them for each).
    const requests = checks.flatMap((check) =>
      check.request === undefined ? [] : [check.request],
    );
    if (
      requests.length > 1 &&
      this.typeScriptGenerations.get(projectRoot) === generation
    )
      engine.preparePages({
        projectRoot,
        importRoot: requests[0].importRoot,
        pages: requests.map((request) => ({
          htmlPath: request.htmlPath,
          text: request.text,
          isolatedClientBlocks: request.isolatedClientBlocks,
          pageScopeHtml: request.pageScopeHtml,
        })),
      });
    for (let index = 0; index < checks.length; index++) {
      // A newer change scheduled a check; the pages this one had yet to check go to it.
      const stale =
        this.typeScriptGenerations.get(projectRoot) !== generation ||
        !(await this.checkTypeScriptPage(engine, projectRoot, checks[index]));
      if (stale) {
        this.oweTypeScriptCheck(
          projectRoot,
          checks.slice(index).map((check) => check.document.uri),
          false,
        );
        return;
      }
    }
  }

  /** What checking a page with TypeScript takes: the engine's request, or none for a page it has nothing to say on. */
  private async typeScriptPageCheck(
    projectRoot: string,
    document: TextDocument,
  ): Promise<TypeScriptPageCheck> {
    const { version } = document;
    const text = document.getText();
    const check: TypeScriptPageCheck = { document, version, text };
    // A page without a TypeScript block costs nothing: TypeScript is not even loaded for it.
    if (!hasTypeScriptBlocks(text)) return check;
    const fsPath = uriToFsPath(document.uri);
    if (!this.workspaceFolders.some((root) => isPathInside(fsPath, root)))
      return check;
    if (!this.isBascikProject(projectRoot)) return check;
    const snapshot = await this.getSnapshotForFile(fsPath);
    check.request = {
      projectRoot,
      importRoot: snapshot?.importRoot ?? path.join(projectRoot, "src"),
      htmlPath: fsPath,
      text,
      isolatedClientBlocks:
        snapshot !== undefined && hasIsolatedClientBlocks(fsPath, snapshot),
      pageScopeHtml:
        snapshot === undefined
          ? undefined
          : pageScopeComponentHtml(fsPath, text, snapshot, (componentPath) =>
              this.documents
                .get(pathToFileURL(componentPath).toString())
                ?.getText(),
            ),
    };
    return check;
  }

  /**
   * Checks one page with TypeScript and publishes the result. False when the check went stale (cancelled by a
   * newer change, or the page was edited meanwhile), so the caller owes it again.
   */
  private async checkTypeScriptPage(
    engine: TypeScriptEngine,
    projectRoot: string,
    check: TypeScriptPageCheck,
  ): Promise<boolean> {
    const { document, version, text, request } = check;
    const { uri } = document;
    const previous = this.typeScriptResults.get(uri)?.diagnostics;
    if (!request) {
      const hasBlocks = hasTypeScriptBlocks(text);
      if (!hasBlocks && previous?.length)
        this.publishTypeScript(document, text, []);
      if (!hasBlocks) this.scheduleTypeScriptRelease();
      return true;
    }
    // Edited meanwhile: it is checked again.
    if (this.documents.get(uri)?.version !== version) return false;
    this.cancelTypeScriptRelease();
    const result = await engine.diagnostics(request);
    const fsPath = request.htmlPath;
    // Closed meanwhile: there is nothing to show.
    const current = this.documents.get(uri);
    if (!current) return true;
    // Edited meanwhile, or cancelled by a newer change: it is checked again.
    if (current.version !== version || result.status === "cancelled")
      return false;
    if (result.status === "failed") {
      this.connection.console.error(
        `Bascik could not check the TypeScript in ${fsPath}: ${result.message}`,
      );
      return true;
    }
    if (result.clientPathProblem && !this.reportedClientPathProblem) {
      // A path the user set that is mistyped or broken: said where they will see it, not only in a log.
      this.reportedClientPathProblem = true;
      const instead =
        result.status === "ok"
          ? "TypeScript blocks are checked with another TypeScript instead."
          : "TypeScript checks are off.";
      const message = `Bascik cannot use its TypeScript path setting: ${result.clientPathProblem}. ${instead}`;
      this.connection.console.warn(message);
      // Typed void, but sent as a request: a client that refuses it must not leave a rejected promise behind.
      const shown: unknown = this.connection.window.showWarningMessage(message);
      if (shown instanceof Promise) shown.catch(() => undefined);
    }
    if (result.status === "unavailable") {
      // Off without TypeScript, quietly: one line in the output panel per project, nothing in the editor.
      if (!this.reportedTypeScriptRoots.has(projectRoot)) {
        this.reportedTypeScriptRoots.add(projectRoot);
        this.connection.console.info(`${projectRoot}: ${result.message}`);
      }
      if (previous?.length) this.publishTypeScript(document, text, []);
      return true;
    }
    this.reportedTypeScriptRoots.delete(projectRoot);
    this.publishTypeScript(document, text, result.diagnostics);
    return true;
  }

  /**
   * A language feature from TypeScript at a position inside one of a page's `type="text/typescript"` blocks, or
   * `undefined` (TypeScript off, outside a block, nothing to say, or the page edited meanwhile). With an editor
   * that answers about the page's own names itself, only what it cannot answer is asked for.
   */
  private async typeScriptFeature<K extends TypeScriptFeatureKind>(
    document: TextDocument,
    position: { line: number; character: number },
    kind: K,
    triggerCharacter?: string,
  ): Promise<TypeScriptFeatureAnswers[K] | undefined> {
    const engine = this.typeScript;
    if (!engine || document.languageId !== "html") return undefined;
    if (!document.uri.startsWith("file:")) return undefined;
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (!typeScriptBlockAt(text, offset)) return undefined;
    const projectRoot = this.findProjectRoot(uriToFsPath(document.uri));
    if (!projectRoot) return undefined;
    const { version } = document;
    const { request } = await this.typeScriptPageCheck(projectRoot, document);
    if (!request || this.documents.get(document.uri)?.version !== version)
      return undefined;
    const result = await engine.feature({
      ...request,
      query: {
        kind,
        offset,
        crossFileOnly: this.editorHasEmbeddedTypeScript,
        triggerCharacter,
      },
    });
    // Edited meanwhile: the answer is for a text the editor no longer shows.
    if (this.documents.get(document.uri)?.version !== version) return undefined;
    if (result.status === "failed")
      this.connection.console.error(
        `Bascik could not answer a TypeScript ${kind} request in ${request.htmlPath}: ${result.message}`,
      );
    return result.status === "ok" ? result.answer : undefined;
  }

  /**
   * Releases the TypeScript engine after `typeScriptReleaseDelayMs` if, by then, no open page has TypeScript
   * blocks: it holds a few hundred megabytes, which nothing needs then. The next page with blocks starts it again.
   */
  private scheduleTypeScriptRelease(): void {
    if (!this.typeScript || this.typeScriptReleaseTimer) return;
    this.typeScriptReleaseTimer = setTimeout(() => {
      this.typeScriptReleaseTimer = undefined;
      const engine = this.typeScript;
      if (!engine) return;
      const needed = this.documents
        .all()
        .some(
          (document) =>
            document.languageId === "html" &&
            document.uri.startsWith("file:") &&
            hasTypeScriptBlocks(document.getText()),
        );
      if (needed) return;
      void engine
        .release()
        .then(() =>
          this.connection.console.info(
            "TypeScript checks gave their memory back: no open page has TypeScript blocks. They start again with the next one.",
          ),
        );
    }, this.typeScriptReleaseDelayMs);
    this.typeScriptReleaseTimer.unref?.();
  }

  private cancelTypeScriptRelease(): void {
    clearTimeout(this.typeScriptReleaseTimer);
    this.typeScriptReleaseTimer = undefined;
  }

  /** Records a page's TypeScript result for `text` and sends it with Bascik's, unless that changes nothing. */
  private publishTypeScript(
    document: TextDocument,
    text: string,
    diagnostics: TypeScriptDiagnostic[],
  ): void {
    const { uri } = document;
    this.typeScriptResults.set(uri, { text, diagnostics });
    // Bascik's own check has not published yet (it waits on the project snapshot); it sends these with its own.
    const bascik = this.bascikDiagnostics.get(uri);
    if (!bascik) return;
    const all = [...bascik, ...this.currentTypeScriptDiagnostics(uri)];
    if (this.lastSentDiagnostics.get(uri) === JSON.stringify(all)) return;
    this.send(uri, document.version, all);
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
    for (const { timer } of this.typeScriptPending.values())
      clearTimeout(timer);
    this.typeScriptPending.clear();
    this.cancelTypeScriptRelease();
    void this.typeScript?.dispose();
    this.typeScript = undefined;
    this.watcherRegistration?.dispose();
    this.watcherRegistration = undefined;
  }
}

/** A TypeScript diagnostic as the editor shows it: its range in the HTML, TypeScript's code, and Bascik's source tag. */
function toLspDiagnostic(
  document: TextDocument,
  diagnostic: TypeScriptDiagnostic,
): Diagnostic {
  return {
    range: {
      start: document.positionAt(diagnostic.start),
      end: document.positionAt(diagnostic.end),
    },
    message: diagnostic.message,
    severity:
      diagnostic.category === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
    source: TYPESCRIPT_DIAGNOSTIC_SOURCE,
    code: diagnostic.code,
  };
}
