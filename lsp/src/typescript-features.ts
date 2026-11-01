/**
 * Hover, go to definition, completion and signature help inside `type="text/typescript"` blocks, from TypeScript's
 * LanguageService over the blocks' virtual files (see `typescript-service.ts`).
 *
 * An editor with its own in-file TypeScript for these blocks (VS Code's HTML support, which cannot be turned off)
 * already answers about names the page itself declares and the library's globals, but it resolves no import. With
 * `crossFileOnly`, only what that mode cannot know is answered, so nothing is shown twice: a symbol, member, global
 * or call whose declaration lies in another file (an `@/` or relative import, a package, `@types/node`, the types
 * `@bascik/bascik` gives a directive script), import paths and the names an import's braces offer. That mode reads every block with the DOM library,
 * whatever its directive, so a name it types or resolves there itself (`console` or `URL` in a server script, which
 * Bascik's server program declares from `@types/node`) is left to it too. Other editors get every answer.
 *
 * Results are located in the HTML (offsets in the request's text) or, for another file, by line and character.
 */
import type * as TS from "typescript-6";
import type { Segment } from "./typescript-blocks.js";
import type { TypeScriptModule } from "./typescript-loader.js";

export type TypeScriptFeatureKind =
  "hover" | "definition" | "completion" | "signatureHelp";

/** A language feature asked for at an offset in an HTML file. */
export interface TypeScriptFeatureQuery<
  K extends TypeScriptFeatureKind = TypeScriptFeatureKind,
> {
  kind: K;
  /** Offset in the HTML file's text. */
  offset: number;
  /**
   * Answer only what an editor's own in-file TypeScript mode cannot (see the module comment). Default `false`:
   * every answer.
   */
  crossFileOnly?: boolean;
  /** The character that triggered a completion, when one did. */
  triggerCharacter?: string;
}

/** A position by line and character (UTF-16 code units), as the Language Server Protocol counts them. */
export interface TypeScriptPosition {
  line: number;
  character: number;
}

export interface TypeScriptHover {
  /** Markdown: the signature in a TypeScript fence, then its documentation. */
  markdown: string;
  /** The hovered range, in offsets of the HTML file's text. */
  start: number;
  end: number;
}

export interface TypeScriptLocation {
  fsPath: string;
  start: TypeScriptPosition;
  end: TypeScriptPosition;
}

export interface TypeScriptCompletionEntry {
  name: string;
  /** TypeScript's `ScriptElementKind`, such as `"const"`, `"method"`, `"directory"` or `"script"`. */
  kind: string;
  sortText: string;
  insertText?: string;
  /** `insertText` is a snippet (`$1` placeholders). */
  isSnippet?: boolean;
  /** The text the entry replaces, in offsets of the HTML file's text; otherwise the word at the cursor. */
  replacement?: { start: number; end: number };
  /** The entry's type, given when the list is short enough to describe every entry. */
  detail?: string;
  documentation?: string;
}

export interface TypeScriptSignatureHelp {
  signatures: {
    label: string;
    documentation?: string;
    /** Each parameter by its offsets in `label`. */
    parameters: { label: [number, number]; documentation?: string }[];
  }[];
  activeSignature: number;
  activeParameter: number;
}

export interface TypeScriptFeatureAnswers {
  hover: TypeScriptHover;
  definition: TypeScriptLocation[];
  completion: TypeScriptCompletionEntry[];
  signatureHelp: TypeScriptSignatureHelp;
}

/** What answering at one place in a virtual file needs from the project. */
export interface FeatureContext {
  ts: TypeScriptModule;
  service: TS.LanguageService;
  fileName: string;
  /** The offset in the virtual file. */
  generated: number;
  /** The virtual file's segments and footer, to map its offsets back to the HTML. */
  file: { segments: Segment[]; footerStart: number };
  /** Whether a declaration in this file is one the editor's in-file mode cannot see. */
  isForeign: (fileName: string) => boolean;
  /**
   * What the editor's in-file mode answers at the same place, beside it (`crossFileOnly`): a name it types or
   * resolves to its library is left to it, although Bascik's program declares it in another file (a global
   * `@types/node` shares with the DOM, such as `console`).
   */
  editor?: EditorModeAnswers;
  /** Where a span of a file is, for the editor; `undefined` for text the author did not write (a footer). */
  locate: (
    fileName: string,
    start: number,
    end: number,
  ) => TypeScriptLocation | undefined;
  /** The HTML offset of a virtual offset, or `undefined` in the footer. */
  toSource: (generated: number) => number | undefined;
}

/** What the editor's in-file TypeScript mode answers at one place (see `typescript-editor-mode.ts`). */
export interface EditorModeAnswers {
  /** It gives the name here a type that is not built from `any`, so its own hover says what Bascik's would. */
  typesName(): boolean;
  /** Its Go to Definition here reaches its library. */
  definesInLibrary(): boolean;
  /** The names it completes here. */
  completionNames(
    triggerCharacter?: TS.CompletionsTriggerCharacter,
  ): ReadonlySet<string>;
  /** It shows a signature here. */
  hasSignature(): boolean;
}

/** Names Bascik adds to the virtual files, never the author's. */
const isBascikName = (name: string): boolean => /^__bascik/i.test(name);

/**
 * Display text without the namespace Bascik's footer imports `@bascik/bascik` under, so a directive script's
 * `context` reads `ServerScriptContext`, not `__bascik.ServerScriptContext`.
 */
function display(
  ts: TypeScriptModule,
  parts: TS.SymbolDisplayPart[] | undefined,
): string {
  return ts.displayPartsToString(parts).replace(/\b__bascik\./g, "");
}

/** Completion lists up to this long get each entry's type and documentation; longer ones only names. */
const DESCRIBED_COMPLETIONS = 50;

/** The characters TypeScript's completions accept as a trigger. */
const TYPESCRIPT_TRIGGERS = new Set([
  ".",
  '"',
  "'",
  "`",
  "/",
  "@",
  "<",
  "#",
  " ",
]);

/** The innermost node of `source` that spans `position` (a token's end counts, as the cursor sits after it). */
export function nodeAt(
  ts: TypeScriptModule,
  source: TS.SourceFile,
  position: number,
): TS.Node {
  let found: TS.Node = source;
  const visit = (node: TS.Node): void => {
    if (node.getStart(source) <= position && position <= node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(source, visit);
  return found;
}

/** Whether a node is the string of an `import`/`export ... from`, an `import()` or an `import x = require()`. */
function isModuleSpecifier(ts: TypeScriptModule, node: TS.Node): boolean {
  if (!ts.isStringLiteralLike(node)) return false;
  const parent = node.parent;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  )
    return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent))
    return true;
  return (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
    parent.arguments[0] === node
  );
}

/**
 * The module specifier of the `import { ... } from` or `export { ... } from` whose braces hold a node: a completion
 * there offers the module's exports, which the editor's in-file mode cannot resolve.
 */
function importBracesModule(
  ts: TypeScriptModule,
  node: TS.Node,
): TS.Expression | undefined {
  for (let at: TS.Node | undefined = node; at; at = at.parent) {
    if (ts.isNamedImports(at)) return at.parent.parent.moduleSpecifier;
    if (ts.isNamedExports(at)) return at.parent.moduleSpecifier;
    if (ts.isStatement(at)) return undefined;
  }
  return undefined;
}

const declaredIn = (symbol: TS.Symbol | undefined): string[] =>
  (symbol?.declarations ?? []).map(
    (declaration) => declaration.getSourceFile().fileName,
  );

/**
 * Whether a type is (or is built from, a level or two down) a type declared in a foreign file: an interface from
 * an import, `Promise<Frother>`, `Frother | undefined`, or the context type `@bascik/bascik` gives a parameter.
 */
function touchesForeign(
  ts: TypeScriptModule,
  checker: TS.TypeChecker,
  type: TS.Type,
  isForeign: (fileName: string) => boolean,
  depth = 0,
): boolean {
  if (depth > 2) return false;
  const symbols = [type.aliasSymbol, type.getSymbol()];
  if (symbols.some((symbol) => declaredIn(symbol).some(isForeign))) return true;
  const parts: readonly TS.Type[] = type.isUnionOrIntersection()
    ? type.types
    : (type.getFlags() & ts.TypeFlags.Object) !== 0 &&
        ((type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
      ? checker.getTypeArguments(type as TS.TypeReference)
      : [];
  return [...parts, ...(type.aliasTypeArguments ?? [])].some((part) =>
    touchesForeign(ts, checker, part, isForeign, depth + 1),
  );
}

function hover(context: FeatureContext): TypeScriptHover | undefined {
  const { ts, service, fileName, generated } = context;
  const info = service.getQuickInfoAtPosition(fileName, generated);
  if (!info || info.textSpan.start >= context.file.footerStart)
    return undefined;
  if (
    context.isForeign !== everyFile &&
    (!isCrossFile(context) || context.editor?.typesName())
  )
    return;
  const start = context.toSource(info.textSpan.start);
  if (start === undefined) return undefined;
  const end =
    context.toSource(
      Math.min(
        info.textSpan.start + info.textSpan.length,
        context.file.footerStart,
      ),
    ) ?? start;
  const signature = display(ts, info.displayParts);
  const parts = [`\`\`\`typescript\n${signature}\n\`\`\``];
  const documentation = display(ts, info.documentation);
  if (documentation) parts.push(documentation);
  const tags = (info.tags ?? []).map((tag) => {
    const text = display(ts, tag.text);
    return `*@${tag.name}*${text ? ` ${text.replace(/\n/g, " ")}` : ""}`;
  });
  if (tags.length > 0) parts.push(tags.join("\n\n"));
  return { markdown: parts.join("\n\n"), start, end };
}

/** `isForeign` that counts every file, for an editor without an in-file mode of its own. */
export const everyFile = (): boolean => true;

/** Whether the symbol at the cursor is declared in a foreign file, or its type comes from one. */
function isCrossFile(context: FeatureContext): boolean {
  const { ts, service, fileName, generated, isForeign } = context;
  const definitions =
    service.getDefinitionAtPosition(fileName, generated) ?? [];
  if (definitions.some((definition) => isForeign(definition.fileName)))
    return true;
  const program = service.getProgram();
  const source = program?.getSourceFile(fileName);
  if (!program || !source) return false;
  const node = nodeAt(ts, source, generated);
  if (!ts.isIdentifier(node)) return false;
  const checker = program.getTypeChecker();
  return touchesForeign(
    ts,
    checker,
    checker.getTypeAtLocation(node),
    isForeign,
  );
}

function definition(context: FeatureContext): TypeScriptLocation[] {
  const { service, fileName, generated, isForeign } = context;
  const definitions =
    service.getDefinitionAtPosition(fileName, generated) ?? [];
  if (definitions.length > 0 && context.editor?.definesInLibrary()) return [];
  return definitions.flatMap((found) => {
    if (!isForeign(found.fileName)) return [];
    const location = context.locate(
      found.fileName,
      found.textSpan.start,
      found.textSpan.start + found.textSpan.length,
    );
    return location ? [location] : [];
  });
}

/**
 * The names a completion here offers that only a foreign file declares, or `undefined` when every name counts (an
 * import path, which the editor's in-file mode cannot complete at all).
 */
function foreignCompletionNames(
  context: FeatureContext,
  memberCompletion: boolean,
): Set<string> | undefined {
  const { ts, service, fileName, generated, isForeign } = context;
  const program = service.getProgram();
  const source = program?.getSourceFile(fileName);
  if (!program || !source) return new Set();
  const node = nodeAt(ts, source, generated);
  if (isModuleSpecifier(ts, node)) return undefined;
  const checker = program.getTypeChecker();
  const braces = importBracesModule(ts, node);
  if (braces) {
    // The module's exports, every one (a keyword such as `type` the editor offers itself).
    const module = checker.getSymbolAtLocation(braces);
    return new Set(
      module
        ? checker.getExportsOfModule(module).map((symbol) => symbol.name)
        : [],
    );
  }
  const names = new Set<string>();
  const add = (symbols: readonly TS.Symbol[]) => {
    for (const symbol of symbols) {
      const files = declaredIn(symbol);
      if (files.length > 0 && files.every(isForeign)) names.add(symbol.name);
    }
  };
  if (memberCompletion) {
    // The expression before the dot: `frother.` or `frother.settings.`, mid-word or not.
    let access: TS.Node | undefined = node;
    while (
      access &&
      !ts.isPropertyAccessExpression(access) &&
      !ts.isQualifiedName(access)
    )
      access = access.parent;
    if (!access) return names;
    const receiver = ts.isPropertyAccessExpression(access)
      ? access.expression
      : access.left;
    const type = checker.getNonNullableType(
      checker.getTypeAtLocation(receiver),
    );
    add(checker.getPropertiesOfType(type));
    const symbol = checker.getSymbolAtLocation(receiver);
    // A namespace import or a module's types: its exports.
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    if (
      target &&
      target.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.Namespace)
    )
      add(checker.getExportsOfModule(target));
    return names;
  }
  add(
    checker.getSymbolsInScope(
      node,
      ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
    ),
  );
  return names;
}

function completion(
  context: FeatureContext,
  query: TypeScriptFeatureQuery,
): TypeScriptCompletionEntry[] {
  const { ts, service, fileName, generated } = context;
  const trigger =
    query.triggerCharacter && TYPESCRIPT_TRIGGERS.has(query.triggerCharacter)
      ? (query.triggerCharacter as TS.CompletionsTriggerCharacter)
      : undefined;
  const info = service.getCompletionsAtPosition(fileName, generated, {
    triggerCharacter: trigger,
    includeCompletionsWithInsertText: true,
    includeCompletionsForModuleExports: false,
    includeCompletionsForImportStatements: false,
    includeAutomaticOptionalChainCompletions: true,
    // Bascik imports name the file's extension (`./lib/frother.ts`).
    importModuleSpecifierEnding: "js",
    allowIncompleteCompletions: false,
  });
  if (!info) return [];
  const crossFile =
    context.isForeign === everyFile
      ? undefined
      : foreignCompletionNames(context, info.isMemberCompletion);
  // Names the editor completes here itself: a DOM global a server script has from `@types/node` too.
  const editorNames =
    crossFile === undefined
      ? undefined
      : context.editor?.completionNames(trigger);
  const entries = info.entries.filter(
    (entry) =>
      !isBascikName(entry.name) &&
      // An auto-import or another entry that needs an extra edit: quick fixes are not offered.
      entry.source === undefined &&
      !entry.hasAction &&
      (crossFile === undefined ||
        (crossFile.has(entry.name) && !editorNames?.has(entry.name))),
  );
  const described = entries.length <= DESCRIBED_COMPLETIONS;
  return entries.flatMap((entry): TypeScriptCompletionEntry[] => {
    const result: TypeScriptCompletionEntry = {
      name: entry.name,
      kind: entry.kind,
      sortText: entry.sortText,
    };
    if (entry.insertText !== undefined) result.insertText = entry.insertText;
    if (entry.isSnippet) result.isSnippet = true;
    const span = entry.replacementSpan ?? info.optionalReplacementSpan;
    if (span) {
      const start = context.toSource(span.start);
      const end = context.toSource(span.start + span.length);
      // A replacement that reaches into Bascik's text is not the author's to replace.
      if (start === undefined || end === undefined) return [];
      result.replacement = { start, end };
    }
    if (described) {
      const details = service.getCompletionEntryDetails(
        fileName,
        generated,
        entry.name,
        undefined,
        entry.source,
        undefined,
        entry.data,
      );
      if (details) {
        const detail = display(ts, details.displayParts);
        if (detail) result.detail = detail;
        const documentation = display(ts, details.documentation);
        if (documentation) result.documentation = documentation;
      }
    }
    return [result];
  });
}

/** The innermost call or `new` whose parentheses hold `position` (to the end, while the `)` is not typed yet). */
function callAt(
  ts: TypeScriptModule,
  source: TS.SourceFile,
  position: number,
): TS.CallLikeExpression | undefined {
  for (
    let node: TS.Node | undefined = nodeAt(ts, source, position);
    node;
    node = node.parent
  ) {
    if (
      !(ts.isCallExpression(node) || ts.isNewExpression(node)) ||
      node.arguments === undefined
    )
      continue;
    const close = source.text[node.end - 1] === ")" ? node.end - 1 : node.end;
    if (node.arguments.pos <= position && position <= close) return node;
  }
  return undefined;
}

function signatureHelp(
  context: FeatureContext,
): TypeScriptSignatureHelp | undefined {
  const { ts, service, fileName, generated, isForeign } = context;
  const items = service.getSignatureHelpItems(fileName, generated, undefined);
  if (!items || items.items.length === 0) return undefined;
  if (isForeign !== everyFile) {
    const program = service.getProgram();
    const source = program?.getSourceFile(fileName);
    const call = source && callAt(ts, source, generated);
    if (!program || !call) return undefined;
    const declaration = program
      .getTypeChecker()
      .getResolvedSignature(call)?.declaration;
    if (!declaration || !isForeign(declaration.getSourceFile().fileName))
      return undefined;
    if (context.editor?.hasSignature()) return undefined;
  }
  return {
    signatures: items.items.map((item) => {
      let label = display(ts, item.prefixDisplayParts);
      const separator = display(ts, item.separatorDisplayParts);
      const parameters = item.parameters.map((parameter, index) => {
        if (index > 0) label += separator;
        const start = label.length;
        label += display(ts, parameter.displayParts);
        const documentation = display(ts, parameter.documentation);
        return {
          label: [start, label.length] as [number, number],
          ...(documentation ? { documentation } : {}),
        };
      });
      label += display(ts, item.suffixDisplayParts);
      const documentation = display(ts, item.documentation);
      return { label, parameters, ...(documentation ? { documentation } : {}) };
    }),
    activeSignature: items.selectedItemIndex,
    activeParameter: items.argumentIndex,
  };
}

/** Answers a language feature at one place in a virtual file. */
export function answerFeature<K extends TypeScriptFeatureKind>(
  context: FeatureContext,
  query: TypeScriptFeatureQuery<K>,
): TypeScriptFeatureAnswers[K] | undefined {
  const answers: {
    [Kind in TypeScriptFeatureKind]: () =>
      TypeScriptFeatureAnswers[Kind] | undefined;
  } = {
    hover: () => hover(context),
    definition: () => definition(context),
    completion: () => completion(context, query),
    signatureHelp: () => signatureHelp(context),
  };
  return answers[query.kind]() as TypeScriptFeatureAnswers[K] | undefined;
}
