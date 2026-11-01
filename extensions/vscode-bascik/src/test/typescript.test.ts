import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  activateExtension,
  rangeOf,
  replaceUnsaved,
  typeScriptDiagnostics,
  typeScriptFixture,
  waitLong,
} from "./typescript-fixture";

// TypeScript errors in type="text/typescript" blocks, checked by the language server with VS Code's own
// TypeScript (the extension passes its path). The "typescript-off" configuration runs the same page with the
// checks turned off and sees none of these, so they come from Bascik, not from VS Code's HTML support.
suite("TypeScript errors in script blocks", () => {
  const { page, helper } = typeScriptFixture();

  suiteSetup(activateExtension);

  suiteTeardown(async () => {
    // Leave both files as committed: revert the unsaved edits.
    for (const uri of [page, helper]) {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri.toString(),
      );
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
  });

  test("reports TS2322 at the exact range of the variable", async () => {
    const document = await vscode.workspace.openTextDocument(page);
    await waitLong(
      () => typeScriptDiagnostics(page).length === 2,
      `Two TypeScript errors should be published for ${page.fsPath}; got ${JSON.stringify(typeScriptDiagnostics(page))}`,
    );
    const rpm = typeScriptDiagnostics(page).find((diagnostic) =>
      diagnostic.range.isEqual(rangeOf(document, "rpm")),
    );
    assert.ok(rpm, "The rpm error should cover exactly `rpm`");
    assert.strictEqual(
      typeof rpm.code === "object" ? rpm.code.value : rpm.code,
      2322,
    );
    assert.strictEqual(rpm.severity, vscode.DiagnosticSeverity.Error);
    assert.match(rpm.message, /'string' is not assignable to type 'number'/);
    // Bascik's own diagnostics are published beside them.
    assert.ok(
      vscode.languages
        .getDiagnostics(page)
        .some((diagnostic) => diagnostic.code === "unknown-bascik-attribute"),
      "Bascik's diagnostic should still be there",
    );
  });

  test("a plain <script> gets no TypeScript diagnostics", async () => {
    const document = await vscode.workspace.openTextDocument(page);
    await waitLong(
      () => typeScriptDiagnostics(page).length > 0,
      "TypeScript should have checked the page",
    );
    const plainStart = document.getText().indexOf("<script>");
    assert.ok(
      typeScriptDiagnostics(page).every(
        (diagnostic) => document.offsetAt(diagnostic.range.start) < plainStart,
      ),
      "No TypeScript diagnostic may point into the plain script",
    );
  });

  test("an unsaved page edit clears the error", async () => {
    const document = await vscode.workspace.openTextDocument(page);
    const original = document.getText();
    await waitLong(
      () =>
        typeScriptDiagnostics(page).some((diagnostic) =>
          diagnostic.range.isEqual(rangeOf(document, "rpm")),
        ),
      "The rpm error should be published first",
    );
    await replaceUnsaved(document, original.replace('"fast"', "1200"));
    try {
      await waitLong(
        () =>
          typeScriptDiagnostics(page).length === 1 &&
          !typeScriptDiagnostics(page).some((diagnostic) =>
            diagnostic.message.includes(
              "'string' is not assignable to type 'number'",
            ),
          ),
        `The rpm error should clear; got ${JSON.stringify(typeScriptDiagnostics(page))}`,
      );
      assert.ok(document.isDirty, "The page edit stays unsaved");
    } finally {
      await replaceUnsaved(document, original);
    }
  });

  test("lines added above the block never show its errors on the wrong code", async () => {
    const document = await vscode.workspace.openTextDocument(page);
    const original = document.getText();
    await waitLong(
      () =>
        typeScriptDiagnostics(page).some((diagnostic) =>
          diagnostic.range.isEqual(rangeOf(document, "rpm")),
        ),
      "The rpm error should be published first",
    );
    // Every TypeScript range VS Code holds after the edit, with the text it covered at that moment.
    const seen: string[] = [];
    let edited = false;
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!edited) return;
      if (!event.uris.some((uri) => uri.toString() === page.toString())) return;
      for (const diagnostic of typeScriptDiagnostics(page))
        seen.push(document.getText(diagnostic.range));
    });
    try {
      edited = true;
      await replaceUnsaved(
        document,
        `<p>Steam wand</p>\n<p>Milk jug</p>\n${original}`,
      );
      // Bascik's own check publishes for the new text first; TypeScript's check follows.
      await waitLong(
        () =>
          seen.length > 0 &&
          typeScriptDiagnostics(page).some((diagnostic) =>
            diagnostic.range.isEqual(rangeOf(document, "rpm")),
          ),
        "The rpm error should be at its new place",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.deepStrictEqual(
        [...new Set(seen)].sort(),
        ["label", "rpm"],
        `Every published TypeScript range should cover rpm or label; saw ${JSON.stringify(seen)}`,
      );
    } finally {
      listener.dispose();
      await replaceUnsaved(document, original);
    }
  });

  test("an unsaved edit to an imported .ts file checks the page again", async () => {
    const pageDocument = await vscode.workspace.openTextDocument(page);
    await waitLong(
      () =>
        typeScriptDiagnostics(page).some((diagnostic) =>
          diagnostic.range.isEqual(rangeOf(pageDocument, "label")),
        ),
      "The label error (number is not string) should be published first",
    );
    const helperDocument = await vscode.workspace.openTextDocument(helper);
    const original = helperDocument.getText();
    await replaceUnsaved(
      helperDocument,
      'export const frotherSpeed: string = "1200";\n',
    );
    try {
      await waitLong(
        () =>
          !typeScriptDiagnostics(page).some((diagnostic) =>
            diagnostic.range.isEqual(rangeOf(pageDocument, "label")),
          ),
        `The label error should clear once the helper exports a string; got ${JSON.stringify(typeScriptDiagnostics(page))}`,
      );
      assert.ok(helperDocument.isDirty, "The helper edit stays unsaved");
    } finally {
      await replaceUnsaved(helperDocument, original);
    }
    await waitLong(
      () =>
        typeScriptDiagnostics(page).some((diagnostic) =>
          diagnostic.range.isEqual(rangeOf(pageDocument, "label")),
        ),
      "Restoring the helper brings the label error back",
    );
  });
});

// A component's script runs on the pages that use it, so what its TypeScript block adds to Window holds there.
suite(
  "TypeScript sees a component's additions to Window on the page that uses it",
  () => {
    const folder = () => {
      const found = vscode.workspace.workspaceFolders?.find(
        (candidate) => candidate.name === "primary",
      );
      assert.ok(found, "Workspace folder primary should be open");
      return found.uri.fsPath;
    };
    const page = () =>
      vscode.Uri.file(
        path.join(folder(), "src", "features", "typescript-globals.html"),
      );
    const component = () =>
      vscode.Uri.file(
        path.join(folder(), "src", "components", "frother-analytics.html"),
      );

    suiteSetup(activateExtension);

    suiteTeardown(async () => {
      for (const uri of [page(), component()]) {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString() === uri.toString(),
        );
        if (document?.isDirty) {
          await vscode.window.showTextDocument(document);
          await vscode.commands.executeCommand("workbench.action.files.revert");
        }
      }
    });

    test("reports only the typo, and the page follows an unsaved edit to the component", async () => {
      const document = await vscode.workspace.openTextDocument(page());
      const codes = () =>
        typeScriptDiagnostics(page()).map((diagnostic) => [
          typeof diagnostic.code === "object"
            ? diagnostic.code.value
            : diagnostic.code,
          document.getText(diagnostic.range),
        ]);
      await waitLong(
        () => typeScriptDiagnostics(page()).length > 0,
        "TypeScript should have checked the page",
      );
      assert.deepStrictEqual(codes(), [[2551, "frotherEvent"]]);

      const card = await vscode.workspace.openTextDocument(component());
      await replaceUnsaved(
        card,
        card.getText().replace("frotherEvents:", "frotherLog:"),
      );
      await waitLong(
        () =>
          JSON.stringify(codes()) ===
          JSON.stringify([
            [2339, "frotherEvents"],
            [2339, "frotherEvent"],
          ]),
        `The page should lose the component's addition; got ${JSON.stringify(codes())}`,
      );
    });
  },
);
