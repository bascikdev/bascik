import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";

/** The source tag the language server puts on TypeScript's diagnostics. */
export const TYPESCRIPT_SOURCE = "ts (bascik)";

/** Activates the extension (and so starts the language server) before a suite opens its documents. */
export async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON?.name === "bascik-vscode",
  );
  assert.ok(ext, "Extension bascik-vscode should be found");
  if (!ext.isActive) await ext.activate();
}

/** The fixture page: a TypeScript block with two errors, and a plain script that is never checked. */
export function typeScriptFixture(): {
  page: vscode.Uri;
  helper: vscode.Uri;
} {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.name === "primary",
  );
  assert.ok(folder, "Workspace folder primary should be open");
  return {
    page: vscode.Uri.file(
      path.join(folder.uri.fsPath, "src", "typescript-check.html"),
    ),
    helper: vscode.Uri.file(
      path.join(folder.uri.fsPath, "src", "lib", "frother-speed.ts"),
    ),
  };
}

export const typeScriptDiagnostics = (uri: vscode.Uri): vscode.Diagnostic[] =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.source === TYPESCRIPT_SOURCE);

/**
 * Waits for `predicate`. TypeScript's first check starts a worker and loads VS Code's TypeScript and the DOM
 * library, which takes a few seconds, so this waits longer than the suite's other helpers.
 */
export async function waitLong(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

/** The range of `needle` in the document, for an exact-range assertion. */
export function rangeOf(
  document: vscode.TextDocument,
  needle: string,
): vscode.Range {
  const start = document.getText().indexOf(needle);
  assert.ok(start >= 0, `${needle} should be in ${document.uri.fsPath}`);
  return new vscode.Range(
    document.positionAt(start),
    document.positionAt(start + needle.length),
  );
}

/** Replaces the whole text of an open document without saving it. */
export async function replaceUnsaved(
  document: vscode.TextDocument,
  text: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert.ok(await vscode.workspace.applyEdit(edit), "The edit should apply");
}

/** The cross-file fixture: a page importing `@/lib/frother-settings.ts` and `../lib/frother-speed.ts`. */
export function typeScriptFeaturesFixture(): {
  page: vscode.Uri;
  settings: vscode.Uri;
  speed: vscode.Uri;
} {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.name === "primary",
  );
  assert.ok(folder, "Workspace folder primary should be open");
  const at = (...parts: string[]) =>
    vscode.Uri.file(path.join(folder.uri.fsPath, ...parts));
  return {
    page: at("src", "features", "typescript-features.html"),
    settings: at("src", "lib", "frother-settings.ts"),
    speed: at("src", "lib", "frother-speed.ts"),
  };
}

/** The position of `needle` (plus `delta`) in the document. */
export function positionOf(
  document: vscode.TextDocument,
  needle: string,
  delta = 0,
): vscode.Position {
  const start = document.getText().indexOf(needle);
  assert.ok(start >= 0, `${needle} should be in ${document.uri.fsPath}`);
  return document.positionAt(start + delta);
}

/** Every hover's text at a position, from every provider (VS Code's HTML support and Bascik). */
export async function hoverTexts(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<string[]> {
  const hovers =
    (await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      position,
    )) ?? [];
  return hovers.map((hover) =>
    hover.contents
      .map((content) =>
        typeof content === "string"
          ? content
          : "value" in content
            ? content.value
            : String(content),
      )
      .join("\n"),
  );
}

/** The files every definition provider points to from a position. */
export async function definitionPaths(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<string[]> {
  const found =
    (await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >("vscode.executeDefinitionProvider", document.uri, position)) ?? [];
  return found.map(
    (location) =>
      ("targetUri" in location ? location.targetUri : location.uri).fsPath,
  );
}

/**
 * Every completion label at a position, from every language provider, duplicates kept. VS Code's word-based
 * suggestions (kind Text: any word in an open document) are left out; they know nothing of types.
 */
export async function completionLabels(
  document: vscode.TextDocument,
  position: vscode.Position,
  triggerCharacter?: string,
): Promise<string[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    position,
    triggerCharacter,
  );
  return (list?.items ?? [])
    .filter((item) => item.kind !== vscode.CompletionItemKind.Text)
    .map((item) =>
      typeof item.label === "string" ? item.label : item.label.label,
    );
}

/** The signatures every provider gives at a position. */
export async function signatureLabels(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<string[]> {
  const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    document.uri,
    position,
  );
  return (help?.signatures ?? []).map((signature) => signature.label);
}

/** Retries `read` until `accept` passes: the server answers once its worker has built TypeScript's program. */
export async function eventuallyAnswered<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() > deadline)
      assert.fail(`${message}; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

/** How many entries of `list` equal `value`. */
export const countOf = (list: string[], value: string): number =>
  list.filter((entry) => entry === value).length;
