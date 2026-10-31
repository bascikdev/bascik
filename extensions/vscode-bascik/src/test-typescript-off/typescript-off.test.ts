import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  activateExtension,
  typeScriptDiagnostics,
  typeScriptFixture,
  waitLong,
} from "../test/typescript-fixture";

// The control for out/test/typescript.test.js: the same page with `bascik.typescript.enabled` off. Bascik's own
// diagnostics still arrive, so the editor and server are working, and no TypeScript error does, so what that suite
// sees is what the TypeScript checks add (VS Code's HTML support reports no errors in these blocks).
suite("TypeScript errors in script blocks, with the checks turned off", () => {
  const { page } = typeScriptFixture();

  suiteSetup(async () => {
    await activateExtension();
    // The extension restarts the server when the setting changes.
    await vscode.workspace
      .getConfiguration("bascik.typescript")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration("bascik.typescript")
      .update("enabled", undefined, vscode.ConfigurationTarget.Global);
  });

  test("publishes Bascik's diagnostics and no TypeScript error", async () => {
    await vscode.workspace.openTextDocument(page);
    await waitLong(
      () =>
        vscode.languages
          .getDiagnostics(page)
          .some((diagnostic) => diagnostic.code === "unknown-bascik-attribute"),
      "Bascik's own diagnostic should be published",
    );
    // Longer than TypeScript's first check takes in the main configuration.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.deepStrictEqual(typeScriptDiagnostics(page), []);
    assert.ok(
      !vscode.languages
        .getDiagnostics(page)
        .some((diagnostic) =>
          /'string' is not assignable to type 'number'/.test(
            diagnostic.message,
          ),
        ),
      "Nothing else (VS Code's HTML support included) reports the TypeScript error",
    );
  });
});
