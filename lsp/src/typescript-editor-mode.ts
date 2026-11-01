/**
 * A stand-in for the in-file TypeScript mode of VS Code's HTML support, so the Bascik server can leave to it what
 * it answers already (see `crossFileOnly` in `typescript-features.ts`).
 *
 * That mode cannot be turned off. It reads every `type="text/typescript"` block of a page as one TypeScript file
 * (the rest of the page blanked, so offsets match the HTML), with `lib.es2020.full` (the DOM) for every block,
 * Bascik's directives ignored, and no imports resolved. So in a server-side block it answers `console`,
 * `setTimeout`, `URL` and `fetch` from the DOM although Bascik's server program declares them from `@types/node`.
 * This mirror runs the same setup with the resolved TypeScript, and is asked whether the editor knows the name at
 * an offset. (VS Code's mode also loads a jQuery declaration file, which is not mirrored.)
 */
import * as path from "node:path";
import type * as TS from "typescript-6";
import { extractTypeScriptBlocks } from "./typescript-blocks.js";
import {
  type EditorModeAnswers,
  involvesAny,
  memberReceiver,
  nodeAt,
} from "./typescript-features.js";
import type { TypeScriptModule } from "./typescript-loader.js";

/** The library VS Code's HTML support gives its in-file TypeScript mode. */
export const EDITOR_MODE_LIB = "lib.es2020.full.d.ts";

/**
 * The page as VS Code's mode reads it: the text of the blocks it embeds as TypeScript in place (not a block whose
 * `type` it does not recognize, see `editorEmbedsTypeScript`), every other character a space.
 */
export function editorModeText(html: string): string {
  const chars = html.replace(/[^\r\n]/g, " ").split("");
  for (const block of extractTypeScriptBlocks(html))
    if (block.editorEmbedded)
      for (let i = 0; i < block.content.length; i++)
        chars[block.contentStart + i] = block.content[i];
  return chars.join("");
}

/** One mirror per loaded TypeScript, shared by every project: its library is parsed once. */
const mirrors = new WeakMap<TypeScriptModule, EditorModeMirror>();

export function editorModeMirror(ts: TypeScriptModule): EditorModeMirror {
  let mirror = mirrors.get(ts);
  if (!mirror) {
    mirror = new EditorModeMirror(ts);
    mirrors.set(ts, mirror);
  }
  return mirror;
}

export class EditorModeMirror {
  private readonly ts: TypeScriptModule;
  private readonly libDir: string;
  private readonly fileName: string;
  private readonly service: TS.LanguageService | undefined;
  private text = "";
  private version = 0;

  constructor(ts: TypeScriptModule) {
    this.ts = ts;
    this.libDir = path.dirname(ts.getDefaultLibFilePath({}));
    this.fileName = path.join(this.libDir, "__bascik-editor-mode.ts");
    const libFile = path.join(this.libDir, EDITOR_MODE_LIB);
    // A TypeScript without the library cannot mirror the editor: every question then gets "it does not know".
    if (!ts.sys.fileExists(libFile)) return;
    const options: TS.CompilerOptions = {
      allowNonTsExtensions: true,
      allowJs: true,
      lib: [EDITOR_MODE_LIB],
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Classic,
      experimentalDecorators: false,
      types: [],
      noEmit: true,
    };
    this.service = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => [this.fileName],
      getScriptKind: () => ts.ScriptKind.TS,
      getScriptVersion: (fileName) =>
        fileName === this.fileName ? String(this.version) : "1",
      getScriptSnapshot: (fileName) => {
        if (fileName === this.fileName)
          return ts.ScriptSnapshot.fromString(this.text);
        const text = this.isLib(fileName)
          ? ts.sys.readFile(fileName)
          : undefined;
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.libDir,
      getDefaultLibFileName: () => libFile,
      fileExists: (fileName) =>
        fileName === this.fileName ||
        (this.isLib(fileName) && ts.sys.fileExists(fileName)),
      readFile: (fileName) =>
        fileName === this.fileName
          ? this.text
          : this.isLib(fileName)
            ? ts.sys.readFile(fileName)
            : undefined,
      // Like VS Code's mode, no import resolves: it sees the page alone.
      directoryExists: () => false,
      resolveModuleNameLiterals: (literals) =>
        literals.map(() => ({ resolvedModule: undefined })),
    });
  }

  /** A library file of the resolved TypeScript (not the mirror's own page, which sits beside them). */
  private isLib(fileName: string): boolean {
    return (
      path.dirname(fileName) === this.libDir &&
      path.basename(fileName).startsWith("lib.")
    );
  }

  /** What the editor's mode answers at `offset` of `html`. Each answer is worked out only when asked. */
  at(html: string, offset: number): EditorModeAnswers {
    const service = this.service;
    if (!service) return NOTHING_KNOWN;
    const text = editorModeText(html);
    // Another page may have used the mirror since: each answer puts this page's text back first.
    const use = () => {
      if (text !== this.text) {
        this.text = text;
        this.version++;
      }
      return service;
    };
    const { ts, fileName } = this;
    return {
      typesName: () => {
        const program = use().getProgram();
        const source = program?.getSourceFile(fileName);
        if (!program || !source) return false;
        const node = nodeAt(ts, source, offset);
        if (!ts.isIdentifier(node)) return false;
        const checker = program.getTypeChecker();
        return !involvesAny(ts, checker, checker.getTypeAtLocation(node));
      },
      typesReceiver: () => {
        const program = use().getProgram();
        const source = program?.getSourceFile(fileName);
        if (!program || !source) return false;
        const receiver = memberReceiver(ts, nodeAt(ts, source, offset));
        if (!receiver) return false;
        const checker = program.getTypeChecker();
        return !involvesAny(ts, checker, checker.getTypeAtLocation(receiver));
      },
      definesInLibrary: () =>
        (use().getDefinitionAtPosition(fileName, offset) ?? []).some(
          (definition) => this.isLib(definition.fileName),
        ),
      completionNames: (triggerCharacter) =>
        new Set(
          (
            use().getCompletionsAtPosition(fileName, offset, {
              triggerCharacter,
              includeCompletionsForModuleExports: false,
              includeCompletionsWithInsertText: false,
            })?.entries ?? []
          ).map((entry) => entry.name),
        ),
      hasSignature: () =>
        (use().getSignatureHelpItems(fileName, offset, undefined)?.items
          .length ?? 0) > 0,
    };
  }
}

const NOTHING_KNOWN: EditorModeAnswers = {
  typesName: () => false,
  typesReceiver: () => false,
  definesInLibrary: () => false,
  completionNames: () => new Set(),
  hasSignature: () => false,
};
