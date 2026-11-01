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
import { editorEmbeddedScripts } from "./typescript-blocks.js";
import {
  type EditorModeAnswers,
  involvesAny,
  memberReceiver,
  nodeAt,
} from "./typescript-features.js";
import { tsPath, type TypeScriptModule } from "./typescript-loader.js";

/** The library VS Code's HTML support gives its in-file TypeScript mode. */
export const EDITOR_MODE_LIB = "lib.es2020.full.d.ts";

/**
 * The page as VS Code's mode for `language` reads it: the scripts it embeds as that language in place, every other
 * character a space. Its TypeScript mode reads the blocks whose `type` it recognizes as TypeScript (see
 * `editorScriptLanguage`); its JavaScript mode reads the page's plain scripts and a block with an uppercase `TYPE`.
 */
export function editorModeText(
  html: string,
  language: EditorLanguage = "typescript",
): string {
  const chars = html.replace(/[^\r\n]/g, " ").split("");
  for (const script of editorEmbeddedScripts(html, language))
    for (let i = 0; i < script.content.length; i++)
      chars[script.contentStart + i] = script.content[i];
  return chars.join("");
}

/** The languages VS Code's HTML support has an in-file mode for. */
export type EditorLanguage = "typescript" | "javascript";

/** One mirror per loaded TypeScript and language, shared by every project: its library is parsed once. */
const mirrors = new WeakMap<
  TypeScriptModule,
  Partial<Record<EditorLanguage, EditorModeMirror>>
>();

export function editorModeMirror(
  ts: TypeScriptModule,
  language: EditorLanguage = "typescript",
): EditorModeMirror {
  let byLanguage = mirrors.get(ts);
  if (!byLanguage) {
    byLanguage = {};
    mirrors.set(ts, byLanguage);
  }
  return (byLanguage[language] ??= new EditorModeMirror(ts, language));
}

export class EditorModeMirror {
  private readonly ts: TypeScriptModule;
  private readonly libDir: string;
  private readonly fileName: string;
  private readonly language: EditorLanguage;
  private readonly service: TS.LanguageService | undefined;
  private text = "";
  private version = 0;

  constructor(ts: TypeScriptModule, language: EditorLanguage = "typescript") {
    this.ts = ts;
    this.language = language;
    // Spelled TypeScript's way (forward slashes), as TypeScript asks for the file by that name.
    this.libDir = tsPath(path.dirname(ts.getDefaultLibFilePath({})));
    this.fileName = `${this.libDir}/__bascik-editor-mode.${language === "typescript" ? "ts" : "js"}`;
    const libFile = `${this.libDir}/${EDITOR_MODE_LIB}`;
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
      getScriptKind: (fileName) =>
        fileName === this.fileName && language === "javascript"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
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
      tsPath(path.dirname(fileName)) === this.libDir &&
      path.basename(fileName).startsWith("lib.")
    );
  }

  /** What the editor's mode answers at `offset` of `html`. Each answer is worked out only when asked. */
  at(html: string, offset: number): EditorModeAnswers {
    const service = this.service;
    if (!service) return NOTHING_KNOWN;
    const text = editorModeText(html, this.language);
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
