import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  activateExtension,
  completionLabels,
  definitionPaths,
  hoverTexts,
  positionOf,
  replaceUnsaved,
  signatureLabels,
  typeScriptDiagnostics,
  typeScriptFeaturesFixture,
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

  test("answers nothing across files: no imported type, definition, member or signature", async () => {
    const { page: featuresPage, settings } = typeScriptFeaturesFixture();
    const document = await vscode.workspace.openTextDocument(featuresPage);
    await vscode.window.showTextDocument(document);
    // The server is running: its own diagnostics for another page arrived in the test above.
    const hovers = await hoverTexts(
      document,
      positionOf(document, "frotherSettings.rpm", 2),
    );
    assert.ok(
      !hovers.some((text) => text.includes("FrotherSettings")),
      `Nothing else knows the imported type; got ${JSON.stringify(hovers)}`,
    );
    const definitions = await definitionPaths(
      document,
      positionOf(document, "froth(\n", 1),
    );
    assert.ok(
      !definitions.includes(settings.fsPath),
      `Nothing else goes to the imported file; got ${JSON.stringify(definitions)}`,
    );
    const signatures = await signatureLabels(
      document,
      positionOf(document, "froth(\n", 6),
    );
    assert.ok(
      !signatures.some((label) => label.includes("froth(level: number)")),
      `Nothing else knows the imported signature; got ${JSON.stringify(signatures)}`,
    );
    const original = document.getText();
    try {
      await replaceUnsaved(
        document,
        original.replace("  const jug", "  frotherSettings.\n  const jug"),
      );
      const labels = await completionLabels(
        document,
        positionOf(document, "frotherSettings.\n", 16),
        ".",
      );
      assert.ok(
        !labels.includes("rpm"),
        `Nothing else completes the imported members; got ${JSON.stringify(labels)}`,
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });
});
