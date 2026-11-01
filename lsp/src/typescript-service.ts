/**
 * TypeScript errors for the `type="text/typescript"` script blocks of Bascik HTML files, from TypeScript's own
 * LanguageService.
 *
 * Each block becomes a virtual `.ts` file next to its HTML file (`page.html.bascik-0.ts`), so a relative import
 * resolves from the page's folder and `@/` resolves against `scripts.importRoot` through `paths`. Client blocks and
 * server-side blocks are checked by two LanguageServices with different libraries: the browser's (DOM, no Node
 * types) and Node's (Node types when `@types/node` is installed, no DOM). The project's `tsconfig.json`, when it
 * has one, is the base; Bascik's settings go on top.
 *
 * Edits are incremental: an HTML edit replaces only the virtual files of blocks whose text changed, and an edit in
 * an imported file (an unsaved editor buffer, or a change on disk) bumps that file's version.
 *
 * This module is the engine; `typescript-engine.ts` runs it beside the language server, and `check.ts` runs it for
 * `bascik --check`.
 */
import * as fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import * as path from "node:path";
import type * as TS from "typescript-6";
import {
  extractTypeScriptBlocks,
  type FooterCheck,
  SCRIPT_TYPE_CHECK,
  type Insertion,
  type TypeScriptBlock,
  type TypeScriptProgramKind,
  sharedScriptText,
  toSourceOffset,
  virtualBlockText,
  type VirtualBlockText,
} from "./typescript-blocks.js";
import {
  type LoadedTypeScript,
  resolveTypeScript,
  type TypeScriptModule,
  type TypeScriptResolution,
} from "./typescript-loader.js";

/** One TypeScript error or warning, located by offsets in the HTML file's text. */
export interface TypeScriptDiagnostic {
  start: number;
  end: number;
  message: string;
  /** TypeScript's error number, such as 2322. */
  code: number;
  category: "error" | "warning";
}

/** What a diagnostics request returns. */
export type TypeScriptDiagnosticsResult =
  | { status: "ok"; diagnostics: TypeScriptDiagnostic[] }
  /** No usable TypeScript for the project; `message` says why, once per project. */
  | { status: "unavailable"; message: string }
  /** A newer edit made the request stale before it finished. */
  | { status: "cancelled" }
  /** TypeScript threw (a bug, or a broken install); `message` is for the log. */
  | { status: "failed"; message: string };

/** The source tag on every published TypeScript diagnostic, so they read apart from Bascik's own. */
export const TYPESCRIPT_DIAGNOSTIC_SOURCE = "ts (bascik)";

/** TypeScript's lowest `target` that allows top-level `await`, which Bascik's server-side scripts may use. */
const MINIMUM_TARGET = 9; // ts.ScriptTarget.ES2022

interface VirtualFile extends VirtualBlockText {
  fileName: string;
  htmlPath: string;
  program: TypeScriptProgramKind;
  version: number;
}

interface Page {
  text: string;
  isolatedClientBlocks: boolean;
  fileNames: string[];
}

/** How an HTML file's blocks are checked, from where it sits in the project (see `hasIsolatedClientBlocks`). */
export interface PageCheckOptions {
  /**
   * Each client block runs in its own scope (a component with `scoping.scriptBlocks` on). Otherwise, as in a
   * page, the client blocks share one scope. Default `false`.
   */
  isolatedClientBlocks?: boolean;
}

export interface TypeScriptProjectOptions {
  ts: TypeScriptModule;
  projectRoot: string;
  /** `scripts.importRoot`, resolved: where `@/` points. */
  importRoot: string;
  /** The unsaved text of a file open in an editor, or `undefined` to read it from disk. */
  readOpenFile?: (fsPath: string) => string | undefined;
  /** Polled by TypeScript while it checks; `true` stops the check with `OperationCanceledException`. */
  isCancellationRequested?: () => boolean;
  /** Shares parsed files (the large library files above all) with other projects using the same TypeScript. */
  registry?: TS.DocumentRegistry;
}

/** Library file names a program's `lib` holds for a browser, and the ones that only make sense there. */
const BROWSER_LIBS = ["lib.dom.d.ts", "lib.dom.iterable.d.ts"];
const BROWSER_ONLY_LIB = /^lib\.(dom|webworker|scripthost)\b/i;

/**
 * The web-standard globals a server-side block has without `@types/node`: `Request`, `Response`, `URL`, `fetch`,
 * `Headers`, `AbortSignal`, streams, `crypto` and `import.meta.url`, which Node and workerd both provide. A web
 * worker's library has them and, unlike the browser's, no `document` or `window`.
 */
export const SERVER_WEB_LIBS = [
  "lib.webworker.d.ts",
  "lib.webworker.iterable.d.ts",
];

/**
 * Node's globals and built-in modules, untyped, for server-side blocks in a project without `@types/node`. Code
 * that runs in Node is never reported for using them; installing `@types/node` gives them their types.
 */
export function untypedNodeDeclarations(): string {
  const modules = builtinModules
    .filter((name) => !name.startsWith("_") && !name.startsWith("node:"))
    .map((name) => `declare module ${JSON.stringify(name)};`);
  return [
    "// Node's globals and modules, untyped: the project has no @types/node.",
    "declare var process: any;",
    "declare var Buffer: any;",
    "declare var global: any;",
    "declare var require: any;",
    "declare var module: any;",
    "declare var __dirname: string;",
    "declare var __filename: string;",
    'declare module "node:*";',
    ...modules,
    "",
  ].join("\n");
}

/** Whether `@types/node` can be found from the project, so server-side blocks get Node's globals and modules. */
export function hasNodeTypes(projectRoot: string): boolean {
  try {
    createRequire(path.join(projectRoot, "package.json")).resolve(
      "@types/node/package.json",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The compiler options for one program: the project's `tsconfig.json` (when it has one), then Bascik's settings,
 * then the libraries and global types that program's scripts run with.
 */
export function compilerOptionsFor(
  ts: TypeScriptModule,
  projectRoot: string,
  importRoot: string,
  program: TypeScriptProgramKind,
  nodeTypes = hasNodeTypes(projectRoot),
): TS.CompilerOptions {
  let base: TS.CompilerOptions = {};
  const configPath = path.join(projectRoot, "tsconfig.json");
  if (fs.existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    // A tsconfig that does not parse is the editor's to report; the blocks are still checked with the defaults.
    if (read.config !== undefined) {
      base = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        projectRoot,
        undefined,
        configPath,
      ).options;
    }
  }
  const target =
    base.target === undefined || base.target < MINIMUM_TARGET
      ? (MINIMUM_TARGET as TS.ScriptTarget)
      : base.target;
  // The target's default library, without the browser parts the `.full` variant adds.
  const defaultLib = ts
    .getDefaultLibFileName({ target })
    .replace(/\.full\.d\.ts$/, ".d.ts")
    .replace(/^lib\.d\.ts$/, "lib.es5.d.ts");
  const languageLibs = (base.lib ?? [defaultLib]).filter(
    (lib) => !BROWSER_ONLY_LIB.test(lib),
  );
  const projectTypes = base.types?.filter(
    (name) => name !== "node" && name !== "@types/node",
  );
  const options: TS.CompilerOptions = {
    strict: true,
    allowJs: true,
    ...base,
    target,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowImportingTsExtensions: true,
    noEmit: true,
    // Only the blocks' own errors are reported, so errors inside declaration files are not worth the time.
    skipLibCheck: true,
    // Emit settings that conflict with noEmit, or make no sense for script blocks.
    composite: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    incremental: false,
    sourceMap: false,
    paths: {
      ...base.paths,
      // Bascik resolves `@/` against `scripts.importRoot`; the project's own `@/*` cannot point elsewhere.
      "@/*": [`${importRoot.split(path.sep).join("/")}/*`],
    },
  };
  if (program === "client") {
    options.lib = [...new Set([...languageLibs, ...BROWSER_LIBS])];
    // Explicit, so `@types/node` (picked up automatically otherwise) never gives browser code `process`.
    options.types = projectTypes ?? [];
  } else if (nodeTypes) {
    options.lib = languageLibs;
    options.types = [...(projectTypes ?? []), "node"];
  } else {
    // Without Node's types, the web globals Node shares with workerd (Node's own are declared untyped).
    options.lib = [...new Set([...languageLibs, ...SERVER_WEB_LIBS])];
    options.types = projectTypes ?? [];
  }
  return options;
}

/** How Bascik checks a directive script's default export: the text it inserts, or the name its footer checks. */
interface DefaultExportPlan {
  insertions: Insertion[];
  check?: FooterCheck;
}

/** Whether `name` appears anywhere in the block outside `declaration` (a call, an `export { }`, an overload). */
function isNameUsedOutside(
  ts: TypeScriptModule,
  source: TS.SourceFile,
  declaration: TS.Node,
  name: string,
): boolean {
  let found = false;
  const visit = (node: TS.Node): void => {
    if (found || node === declaration) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * Where Bascik passes a directive script's default export to its typed check function. Passing it as an argument
 * gives an untyped parameter its type from the call. A named function declaration stays a declaration when the
 * block uses its name anywhere else, and the footer checks it by name instead: wrapping would make it an
 * expression, whose name the rest of the module cannot see.
 */
function defaultExportPlan(
  ts: TypeScriptModule,
  content: string,
): DefaultExportPlan {
  const source = ts.createSourceFile(
    "block.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const opening = `${SCRIPT_TYPE_CHECK}(`;
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return {
        insertions: [
          { at: statement.expression.getStart(source), text: opening },
          { at: statement.expression.end, text: ")" },
        ],
      };
    }
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const modifiers = statement.modifiers ?? [];
      const defaultKeyword = modifiers.find(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (
        defaultKeyword &&
        modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        const name = statement.name;
        if (name && isNameUsedOutside(ts, source, statement, name.text)) {
          return {
            insertions: [],
            check: {
              name: name.text,
              start: name.getStart(source),
              end: name.end,
            },
          };
        }
        // `export default async function f() {}` becomes `export default __bascikScript( async function f() {})`.
        return {
          insertions: [
            { at: defaultKeyword.end, text: ` ${opening}` },
            { at: statement.end, text: ")" },
          ],
        };
      }
    }
  }
  return { insertions: [] };
}

const CLASSIC_SCRIPT_NOTE =
  'A type="text/typescript" block runs in the browser as a classic script, not a module.';

/** The `await` keywords at the top level of a client block's virtual file, before its footer. */
function topLevelAwaits(
  ts: TypeScriptModule,
  source: TS.SourceFile,
  footerStart: number,
): {
  start: number;
  end: number;
  report: Pick<TypeScriptDiagnostic, "message" | "code" | "category">;
}[] {
  const found: ReturnType<typeof topLevelAwaits> = [];
  const visit = (node: TS.Node): void => {
    // Inside a function `await` is the function's business, which TypeScript checks.
    if (ts.isFunctionLike(node) || node.pos >= footerStart) return;
    if (ts.isAwaitExpression(node)) {
      const start = node.getStart(source);
      found.push({
        start,
        end: start + "await".length,
        report: {
          // TypeScript's own message and number for `await` outside an async function and a module.
          message: `'await' expressions are only allowed within async functions and at the top levels of modules. ${CLASSIC_SCRIPT_NOTE}`,
          code: 1308,
          category: "error",
        },
      });
    } else if (ts.isForOfStatement(node) && node.awaitModifier) {
      found.push({
        start: node.awaitModifier.getStart(source),
        end: node.awaitModifier.end,
        report: {
          message: `'for await' loops are only allowed within async functions and at the top levels of modules. ${CLASSIC_SCRIPT_NOTE}`,
          code: 1103,
          category: "error",
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * The TypeScript blocks of one project: two LanguageServices (client and server), the virtual files of every
 * HTML file it was given, and the versions that tell TypeScript what changed.
 */
export class TypeScriptProject {
  readonly projectRoot: string;
  readonly importRoot: string;
  private readonly ts: TypeScriptModule;
  private readonly readOpenFile: (fsPath: string) => string | undefined;
  private readonly files = new Map<string, VirtualFile>();
  private readonly pages = new Map<string, Page>();
  /** Versions of real files reported changed (an editor buffer or a file on disk). */
  private readonly fileVersions = new Map<string, number>();
  private readonly services: Record<TypeScriptProgramKind, TS.LanguageService>;
  private projectVersion = 0;
  private nextFileVersion = 1;
  /**
   * Whether directive scripts get their types from `@bascik/bascik`. It turns false the first time the typed
   * footer fails to resolve (no `@bascik/bascik`, or one from before the types), until the project is made again.
   */
  private scriptTypes = true;
  /** Node's untyped globals and modules for the server program, when the project has no `@types/node`. */
  private readonly nodeDeclarations:
    { fileName: string; text: string } | undefined;

  constructor(options: TypeScriptProjectOptions) {
    // TypeScript keys files by absolute path; a relative root would make every relative import miss.
    this.projectRoot = path.resolve(options.projectRoot);
    this.importRoot = path.resolve(this.projectRoot, options.importRoot);
    this.ts = options.ts;
    this.readOpenFile = options.readOpenFile ?? (() => undefined);
    const registry =
      options.registry ??
      this.ts.createDocumentRegistry(
        this.ts.sys.useCaseSensitiveFileNames,
        this.projectRoot,
      );
    const cancellationToken: TS.CancellationToken = {
      isCancellationRequested: options.isCancellationRequested ?? (() => false),
      throwIfCancellationRequested: () => {
        if (options.isCancellationRequested?.())
          throw new this.ts.OperationCanceledException();
      },
    };
    const nodeTypes = hasNodeTypes(this.projectRoot);
    this.nodeDeclarations = nodeTypes
      ? undefined
      : {
          fileName: path.join(this.projectRoot, "__bascik-node-globals.d.ts"),
          text: untypedNodeDeclarations(),
        };
    const createService = (program: TypeScriptProgramKind) =>
      this.ts.createLanguageService(
        this.host(
          program,
          compilerOptionsFor(
            this.ts,
            this.projectRoot,
            this.importRoot,
            program,
            nodeTypes,
          ),
          cancellationToken,
        ),
        registry,
      );
    this.services = {
      client: createService("client"),
      server: createService("server"),
    };
  }

  private host(
    program: TypeScriptProgramKind,
    options: TS.CompilerOptions,
    cancellationToken: TS.CancellationToken,
  ): TS.LanguageServiceHost {
    const ts = this.ts;
    return {
      getProjectVersion: () => String(this.projectVersion),
      getCompilationSettings: () => options,
      getScriptFileNames: () => {
        const names = [...this.files.values()]
          .filter((file) => file.program === program)
          .map((file) => file.fileName);
        if (program === "server" && this.nodeDeclarations)
          names.push(this.nodeDeclarations.fileName);
        return names;
      },
      getScriptVersion: (fileName) =>
        String(
          this.files.get(fileName)?.version ??
            this.fileVersions.get(fileName) ??
            0,
        ),
      getScriptSnapshot: (fileName) => {
        const text = this.readFile(fileName);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.projectRoot,
      getDefaultLibFileName: (compilerOptions) =>
        ts.getDefaultLibFilePath(compilerOptions),
      fileExists: (fileName) =>
        this.files.has(fileName) ||
        fileName === this.nodeDeclarations?.fileName ||
        this.readOpenFile(fileName) !== undefined ||
        ts.sys.fileExists(fileName),
      readFile: (fileName) => this.readFile(fileName),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getCancellationToken: () => cancellationToken,
    };
  }

  private readFile(fileName: string): string | undefined {
    const virtual = this.files.get(fileName);
    if (virtual) return virtual.text;
    if (fileName === this.nodeDeclarations?.fileName)
      return this.nodeDeclarations.text;
    return this.readOpenFile(fileName) ?? this.ts.sys.readFile(fileName);
  }

  /**
   * Records an HTML file's text. Only virtual files whose text changed get a new version, so TypeScript reuses
   * what it knows about the rest.
   */
  updatePage(
    htmlPath: string,
    text: string,
    options: PageCheckOptions = {},
  ): void {
    htmlPath = path.resolve(this.projectRoot, htmlPath);
    const isolatedClientBlocks = options.isolatedClientBlocks === true;
    const previous = this.pages.get(htmlPath);
    if (
      previous?.text === text &&
      previous.isolatedClientBlocks === isolatedClientBlocks
    )
      return;
    const blocks = extractTypeScriptBlocks(text);
    const units: {
      fileName: string;
      program: TypeScriptProgramKind;
      virtual: VirtualBlockText;
    }[] = [];
    const sharedClient = isolatedClientBlocks
      ? []
      : blocks.filter((block) => block.program === "client");
    if (sharedClient.length > 0) {
      units.push({
        fileName: `${htmlPath}.bascik-client.ts`,
        program: "client",
        virtual: sharedScriptText(sharedClient),
      });
    }
    for (const block of blocks) {
      if (block.program === "client" && !isolatedClientBlocks) continue;
      units.push({
        fileName: `${htmlPath}.bascik-${block.index}.ts`,
        program: block.program,
        virtual: this.virtualFile(block),
      });
    }
    let changed = false;
    for (const { fileName, program, virtual } of units) {
      const existing = this.files.get(fileName);
      if (
        existing &&
        existing.text === virtual.text &&
        existing.program === program
      ) {
        // Same text; only the offsets moved (an edit above the block).
        existing.segments = virtual.segments;
        existing.footerStart = virtual.footerStart;
        existing.footerCheck = virtual.footerCheck;
        continue;
      }
      changed = true;
      this.files.set(fileName, {
        ...virtual,
        fileName,
        htmlPath,
        program,
        version: this.nextFileVersion++,
      });
    }
    const fileNames = units.map((unit) => unit.fileName);
    const kept = new Set(fileNames);
    for (const fileName of previous?.fileNames ?? []) {
      if (kept.has(fileName)) continue;
      this.files.delete(fileName);
      changed = true;
    }
    this.pages.set(htmlPath, { text, isolatedClientBlocks, fileNames });
    if (changed) this.projectVersion++;
  }

  private virtualFile(block: TypeScriptBlock): VirtualBlockText {
    if (block.directive === undefined)
      return virtualBlockText(block, [], this.scriptTypes);
    const plan = defaultExportPlan(this.ts, block.content);
    return virtualBlockText(
      block,
      plan.insertions,
      this.scriptTypes,
      plan.check,
    );
  }

  /** Rewrites every directive block with the untyped footer, after the typed one failed to resolve. */
  private dropScriptTypes(): void {
    this.scriptTypes = false;
    const pages = [...this.pages];
    this.pages.clear();
    for (const [htmlPath, page] of pages)
      this.updatePage(htmlPath, page.text, page);
  }

  /** Forgets an HTML file, so its blocks are no longer part of either program. */
  removePage(htmlPath: string): void {
    htmlPath = path.resolve(this.projectRoot, htmlPath);
    const page = this.pages.get(htmlPath);
    if (!page) return;
    for (const fileName of page.fileNames) this.files.delete(fileName);
    this.pages.delete(htmlPath);
    this.projectVersion++;
  }

  /** A file the blocks may import changed in an editor buffer or on disk. */
  fileChanged(fsPath: string): void {
    this.fileVersions.set(path.resolve(fsPath), this.nextFileVersion++);
    this.projectVersion++;
  }

  /** The TypeScript errors and warnings of an HTML file's blocks, located in its text. */
  diagnostics(
    htmlPath: string,
    text: string,
    options: PageCheckOptions = {},
  ): TypeScriptDiagnostic[] {
    htmlPath = path.resolve(this.projectRoot, htmlPath);
    this.updatePage(htmlPath, text, options);
    const result: TypeScriptDiagnostic[] = [];
    for (const fileName of this.pages.get(htmlPath)?.fileNames ?? []) {
      const file = this.files.get(fileName)!;
      const service = this.services[file.program];
      const syntactic = service.getSyntacticDiagnostics(fileName);
      const semantic = service.getSemanticDiagnostics(fileName);
      // A type error in Bascik's footer means @bascik/bascik's script types are not there: check without them.
      // Not while the block has a syntax error, which can swallow the footer (an unclosed brace or comment).
      const inFooterCheck = (diagnostic: TS.Diagnostic) =>
        file.footerCheck !== undefined &&
        diagnostic.start !== undefined &&
        diagnostic.start >= file.footerCheck.generatedStart &&
        diagnostic.start < file.footerCheck.generatedEnd;
      if (
        this.scriptTypes &&
        file.program === "server" &&
        syntactic.length === 0 &&
        semantic.some(
          (diagnostic) =>
            (diagnostic.start ?? 0) >= file.footerStart &&
            !inFooterCheck(diagnostic),
        )
      ) {
        this.dropScriptTypes();
        return this.diagnostics(htmlPath, text, options);
      }
      const syntacticSet = new Set<TS.Diagnostic>(syntactic);
      for (const diagnostic of [...syntactic, ...semantic]) {
        if (diagnostic.start === undefined) continue;
        if (
          diagnostic.category !== this.ts.DiagnosticCategory.Error &&
          diagnostic.category !== this.ts.DiagnosticCategory.Warning
        )
          continue;
        const message = this.ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        );
        const category =
          diagnostic.category === this.ts.DiagnosticCategory.Error
            ? "error"
            : "warning";
        // The footer's check of a named default export: the function does not fit the script's type. It is the
        // author's error, located on the function's name.
        if (file.footerCheck && inFooterCheck(diagnostic)) {
          result.push({
            start: file.footerCheck.sourceStart,
            end: file.footerCheck.sourceEnd,
            message,
            code: diagnostic.code,
            category,
          });
          continue;
        }
        // A syntax error found in the footer is the author's (an unclosed brace runs past the block's end): it is
        // reported at the end of the block. A type error there is Bascik's, not theirs to fix.
        const inFooter = diagnostic.start >= file.footerStart;
        if (inFooter && !syntacticSet.has(diagnostic)) continue;
        const start = Math.min(diagnostic.start, file.footerStart);
        const end = Math.min(
          diagnostic.start + (diagnostic.length ?? 0),
          file.footerStart,
        );
        result.push({
          start: toSourceOffset(file, start),
          end: toSourceOffset(file, Math.max(start, end)),
          message,
          code: diagnostic.code,
          category,
        });
      }
      // A client block runs as a classic script (wrapped in a function in a component), never as a module, so
      // top-level `await` fails in the browser although TypeScript accepts it in the module the block is checked as.
      if (file.program === "client" && syntactic.length === 0) {
        const source = service.getProgram()?.getSourceFile(fileName);
        if (source) {
          for (const found of topLevelAwaits(this.ts, source, file.footerStart))
            result.push({
              start: toSourceOffset(file, found.start),
              end: toSourceOffset(file, found.end),
              ...found.report,
            });
        }
      }
    }
    return result.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  dispose(): void {
    this.services.client.dispose();
    this.services.server.dispose();
  }
}

export interface TypeScriptProjectsOptions {
  /** The TypeScript the client asked for (a package folder); see `typescript-loader.ts`. */
  clientPath?: string;
  /** Where to resolve an installed peer `typescript` from after the project. */
  fallbackFrom?: string;
  /** Whether the request that is running is stale. */
  isCancellationRequested?: () => boolean;
  /** Overrides how TypeScript is found (tests). */
  resolve?: (projectRoot: string) => TypeScriptResolution;
}

/**
 * Every project's TypeScript blocks, keyed by project root: the synchronous engine behind the language server's
 * worker and `bascik --check`. TypeScript is looked up once per project, on the first request.
 */
export class TypeScriptProjects {
  private readonly projects = new Map<string, TypeScriptProject>();
  private readonly resolutions = new Map<string, TypeScriptResolution>();
  /** Unsaved editor buffers of files the blocks may import. */
  private readonly openFiles = new Map<string, string>();
  /** One per TypeScript copy, shared by its projects. */
  private readonly registries = new Map<
    TypeScriptModule,
    TS.DocumentRegistry
  >();

  constructor(private readonly options: TypeScriptProjectsOptions = {}) {}

  private resolution(projectRoot: string): TypeScriptResolution {
    let resolution = this.resolutions.get(projectRoot);
    if (!resolution) {
      resolution =
        this.options.resolve?.(projectRoot) ??
        resolveTypeScript({
          clientPath: this.options.clientPath,
          projectRoot,
          fallbackFrom: this.options.fallbackFrom,
        });
      this.resolutions.set(projectRoot, resolution);
    }
    return resolution;
  }

  /** The project for a root and import root, made again when the import root changed. */
  private project(
    projectRoot: string,
    importRoot: string,
  ): TypeScriptProject | string {
    const resolution = this.resolution(projectRoot);
    if (!resolution.ok) return resolution.message;
    let project = this.projects.get(projectRoot);
    if (
      project &&
      project.importRoot !== path.resolve(projectRoot, importRoot)
    ) {
      project.dispose();
      project = undefined;
    }
    if (!project) {
      project = new TypeScriptProject({
        ts: resolution.ts,
        projectRoot,
        importRoot,
        readOpenFile: (fsPath) => this.openFiles.get(fsPath),
        isCancellationRequested: this.options.isCancellationRequested,
        registry: this.registryFor(resolution.ts),
      });
      this.projects.set(projectRoot, project);
    }
    return project;
  }

  private registryFor(ts: TypeScriptModule): TS.DocumentRegistry {
    let registry = this.registries.get(ts);
    if (!registry) {
      registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);
      this.registries.set(ts, registry);
    }
    return registry;
  }

  /** The TypeScript the project uses, or why it has none. */
  describe(projectRoot: string): TypeScriptResolution {
    return this.resolution(path.resolve(projectRoot));
  }

  diagnostics(
    request: {
      projectRoot: string;
      importRoot: string;
      htmlPath: string;
      text: string;
    } & PageCheckOptions,
  ): TypeScriptDiagnosticsResult {
    const projectRoot = path.resolve(request.projectRoot);
    const project = this.project(projectRoot, request.importRoot);
    if (typeof project === "string")
      return { status: "unavailable", message: project };
    try {
      return {
        status: "ok",
        diagnostics: project.diagnostics(
          path.resolve(projectRoot, request.htmlPath),
          request.text,
          { isolatedClientBlocks: request.isolatedClientBlocks },
        ),
      };
    } catch (error) {
      const { ts } = this.resolution(projectRoot) as LoadedTypeScript;
      if (error instanceof ts.OperationCanceledException)
        return { status: "cancelled" };
      throw error;
    }
  }

  /** Records (or, with `undefined`, drops) the unsaved text of an editor buffer. */
  setOpenFile(fsPath: string, text: string | undefined): void {
    fsPath = path.resolve(fsPath);
    if (text === undefined) this.openFiles.delete(fsPath);
    else this.openFiles.set(fsPath, text);
    this.fileChanged(fsPath);
  }

  /**
   * A file changed. A `tsconfig.json` remakes its project (with the new options); anything else gets a new
   * version in every project, which is cheap: TypeScript re-reads it only where a program holds it.
   */
  fileChanged(fsPath: string): void {
    fsPath = path.resolve(fsPath);
    if (path.basename(fsPath) === "tsconfig.json") {
      this.forgetProject(path.dirname(fsPath));
      return;
    }
    if (path.basename(fsPath) === "package.json") {
      // A newly installed (or removed) typescript or @types/node.
      this.forgetProject(path.dirname(fsPath));
      this.resolutions.delete(path.dirname(fsPath));
      return;
    }
    for (const project of this.projects.values()) project.fileChanged(fsPath);
  }

  closePage(projectRoot: string, htmlPath: string): void {
    this.projects.get(path.resolve(projectRoot))?.removePage(htmlPath);
  }

  forgetProject(projectRoot: string): void {
    projectRoot = path.resolve(projectRoot);
    this.projects.get(projectRoot)?.dispose();
    this.projects.delete(projectRoot);
  }

  dispose(): void {
    for (const project of this.projects.values()) project.dispose();
    this.projects.clear();
  }
}
