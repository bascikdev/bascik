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
