/**
 * TypeScript's language feature answers (see `typescript-features.ts`) as the Language Server Protocol's types.
 */
import { pathToFileURL } from "node:url";
import {
  type CompletionItem,
  CompletionItemKind,
  type Hover,
  InsertTextFormat,
  type Location,
  MarkupKind,
  type SignatureHelp,
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  TypeScriptCompletionEntry,
  TypeScriptHover,
  TypeScriptLocation,
  TypeScriptSignatureHelp,
} from "./typescript-features.js";

/** TypeScript's `ScriptElementKind` values, as the editor's completion icons, the way VS Code's TypeScript maps them. */
const COMPLETION_KINDS: Record<string, CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  "primitive type": CompletionItemKind.Keyword,
  const: CompletionItemKind.Constant,
  let: CompletionItemKind.Variable,
  var: CompletionItemKind.Variable,
  "local var": CompletionItemKind.Variable,
  alias: CompletionItemKind.Variable,
  parameter: CompletionItemKind.Variable,
  property: CompletionItemKind.Field,
  getter: CompletionItemKind.Field,
  setter: CompletionItemKind.Field,
  accessor: CompletionItemKind.Field,
  function: CompletionItemKind.Function,
  "local function": CompletionItemKind.Function,
  method: CompletionItemKind.Method,
  construct: CompletionItemKind.Method,
  call: CompletionItemKind.Method,
  index: CompletionItemKind.Method,
  constructor: CompletionItemKind.Constructor,
  enum: CompletionItemKind.Enum,
  "enum member": CompletionItemKind.EnumMember,
  module: CompletionItemKind.Module,
  "external module name": CompletionItemKind.Module,
  class: CompletionItemKind.Class,
  "local class": CompletionItemKind.Class,
  type: CompletionItemKind.Class,
  interface: CompletionItemKind.Interface,
  "type parameter": CompletionItemKind.TypeParameter,
  string: CompletionItemKind.Constant,
  script: CompletionItemKind.File,
  directory: CompletionItemKind.Folder,
};

export function toLspCompletionItem(
  document: TextDocument,
  entry: TypeScriptCompletionEntry,
): CompletionItem {
  const newText = entry.insertText ?? entry.name;
  const item: CompletionItem = {
    label: entry.name,
    kind: COMPLETION_KINDS[entry.kind] ?? CompletionItemKind.Property,
    sortText: entry.sortText,
    insertTextFormat: entry.isSnippet
      ? InsertTextFormat.Snippet
      : InsertTextFormat.PlainText,
  };
  if (entry.replacement) {
    const range = {
      start: document.positionAt(entry.replacement.start),
      end: document.positionAt(entry.replacement.end),
    };
    item.textEdit = { range, newText };
    // The editor filters by the text in the replaced range; `?.speed` replacing `.sp` filters by what it inserts.
    if (newText !== entry.name) item.filterText = newText;
  } else if (newText !== entry.name) {
    item.insertText = newText;
  }
  if (entry.detail) item.detail = entry.detail;
  if (entry.documentation)
    item.documentation = {
      kind: MarkupKind.Markdown,
      value: entry.documentation,
    };
  return item;
}

export function toLspHover(
  document: TextDocument,
  hover: TypeScriptHover,
): Hover {
  return {
    contents: { kind: MarkupKind.Markdown, value: hover.markdown },
    range: {
      start: document.positionAt(hover.start),
      end: document.positionAt(hover.end),
    },
  };
}

export function toLspLocation(location: TypeScriptLocation): Location {
  return {
    uri: pathToFileURL(location.fsPath).toString(),
    range: { start: location.start, end: location.end },
  };
}

export function toLspSignatureHelp(
  help: TypeScriptSignatureHelp,
): SignatureHelp {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      ...(signature.documentation
        ? {
            documentation: {
              kind: MarkupKind.Markdown,
              value: signature.documentation,
            },
          }
        : {}),
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label,
        ...(parameter.documentation
          ? {
              documentation: {
                kind: MarkupKind.Markdown,
                value: parameter.documentation,
              },
            }
          : {}),
      })),
    })),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  };
}
