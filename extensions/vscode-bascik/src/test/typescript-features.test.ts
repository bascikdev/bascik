import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  activateExtension,
  completionLabels,
  countOf,
  definitionPaths,
  eventuallyAnswered,
  hoverTexts,
  positionOf,
  replaceUnsaved,
  signatureLabels,
  typeScriptFeaturesFixture,
} from "./typescript-fixture";

// Hover, definition, completion and signature help in type="text/typescript" blocks. VS Code's HTML support
// answers about the page's own names there (it resolves no import), so Bascik answers only for other files and
// import paths, and nothing is listed twice. The "typescript-off" configuration is the control: there, none of
// the cross-file answers below exist.
suite("TypeScript language features across files", () => {
  const { page, settings, speed } = typeScriptFeaturesFixture();
  let document: vscode.TextDocument;

  suiteSetup(async () => {
    await activateExtension();
    document = await vscode.workspace.openTextDocument(page);
    await vscode.window.showTextDocument(document);
  });

  teardown(async () => {
    if (document.isDirty) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });

  test("hovers a symbol imported through @/ once, with its type and documentation", async () => {
    const texts = await eventuallyAnswered(
      () =>
        hoverTexts(document, positionOf(document, "frotherSettings.rpm", 2)),
      (all) => all.some((text) => text.includes("FrotherSettings")),
      "Bascik should hover frotherSettings with its imported type",
    );
    assert.strictEqual(
      texts.filter((text) =>
        text.includes("const frotherSettings: FrotherSettings"),
      ).length,
      1,
      `One hover should give the imported type; got ${JSON.stringify(texts)}`,
    );
    const froth = await hoverTexts(
      document,
      positionOf(document, "froth(\n", 1),
    );
    assert.ok(
      froth.some((text) =>
        text.includes("Froths milk at a level from 1 to 3."),
      ),
      `The imported function's documentation should show; got ${JSON.stringify(froth)}`,
    );
  });

  test("goes to the definition in @/lib and in ../lib", async () => {
    const toSettings = await eventuallyAnswered(
      () => definitionPaths(document, positionOf(document, "froth(\n", 1)),
      (paths) => paths.includes(settings.fsPath),
      "Go to Definition on froth should open src/lib/frother-settings.ts",
    );
    assert.strictEqual(countOf(toSettings, settings.fsPath), 1);
    const toSpeed = await definitionPaths(
      document,
      positionOf(document, "frotherSpeed +", 2),
    );
    assert.ok(
      toSpeed.includes(speed.fsPath),
      `Go to Definition on frotherSpeed should open ../lib/frother-speed.ts; got ${JSON.stringify(toSpeed)}`,
    );
    const fromPath = await definitionPaths(
      document,
      positionOf(document, "@/lib/frother-settings.ts", 4),
    );
    assert.ok(
      fromPath.includes(settings.fsPath),
      `Go to Definition on the @/ import path should open the file; got ${JSON.stringify(fromPath)}`,
    );
  });

  test("completes an imported object's members once", async () => {
    const original = document.getText();
    const typed = original.replace(
      "  const jug",
      "  frotherSettings.\n  const jug",
    );
    await replaceUnsaved(document, typed);
    const labels = await eventuallyAnswered(
      () =>
        completionLabels(
          document,
          positionOf(document, "frotherSettings.\n", 16),
          ".",
        ),
      (all) => all.includes("rpm"),
      "Completion after frotherSettings. should offer rpm",
    );
    assert.strictEqual(countOf(labels, "rpm"), 1, JSON.stringify(labels));
    assert.strictEqual(countOf(labels, "foam"), 1, JSON.stringify(labels));
  });

  test("completes @/ import paths", async () => {
    const typed = document
      .getText()
      .replace('"@/lib/frother-settings.ts"', '"@/lib/"');
    await replaceUnsaved(document, typed);
    const labels = await eventuallyAnswered(
      () =>
        completionLabels(document, positionOf(document, '"@/lib/"', 7), "/"),
      (all) => all.includes("frother-settings.ts"),
      "Completion in an @/ import path should list src/lib's files",
    );
    assert.strictEqual(countOf(labels, "frother-settings.ts"), 1);
    assert.strictEqual(countOf(labels, "frother-speed.ts"), 1);
  });

  test("gives an imported function's signature once", async () => {
    const labels = await eventuallyAnswered(
      () => signatureLabels(document, positionOf(document, "froth(\n", 6)),
      (all) => all.some((label) => label.includes("froth(level: number)")),
      "Signature help in froth( should show its parameters",
    );
    assert.strictEqual(
      labels.filter((label) => label.includes("froth(level: number)")).length,
      1,
      JSON.stringify(labels),
    );
  });

  test("leaves the page's own names to VS Code's HTML support, answered once", async () => {
    // Wait until Bascik answers in this page at all, so a missing duplicate is not just a slow server.
    await eventuallyAnswered(
      () =>
        hoverTexts(document, positionOf(document, "frotherSettings.rpm", 2)),
      (all) => all.some((text) => text.includes("FrotherSettings")),
      "Bascik should be answering in the page",
    );
    const hovers = await hoverTexts(
      document,
      positionOf(document, "steamTemperature +", 2),
    );
    assert.strictEqual(
      hovers.filter((text) => text.includes("steamTemperature")).length,
      1,
      `Only VS Code's hover should describe a name the page declares; got ${JSON.stringify(hovers)}`,
    );
    const definitions = await definitionPaths(
      document,
      positionOf(document, "steamTemperature +", 2),
    );
    assert.ok(
      countOf(definitions, page.fsPath) <= 1,
      `At most VS Code's definition for a page name; got ${JSON.stringify(definitions)}`,
    );
    const original = document.getText();
    await replaceUnsaved(
      document,
      original.replace("  document.title", "  jug.\n  document.title"),
    );
    const labels = await completionLabels(
      document,
      positionOf(document, "jug.\n", 4),
      ".",
    );
    assert.ok(
      countOf(labels, "size") <= 1,
      `A page object's member should not be listed twice; got ${JSON.stringify(labels)}`,
    );
  });

  test("a plain <script> gets nothing from Bascik", async () => {
    await eventuallyAnswered(
      () =>
        hoverTexts(document, positionOf(document, "frotherSettings.rpm", 2)),
      (all) => all.some((text) => text.includes("FrotherSettings")),
      "Bascik should be answering in the page",
    );
    const hovers = await hoverTexts(
      document,
      positionOf(document, "plainFrother.size", 2),
    );
    assert.ok(
      hovers.filter((text) => text.includes("plainFrother")).length <= 1,
      `Only VS Code's JavaScript support may hover a plain script; got ${JSON.stringify(hovers)}`,
    );
    const definitions = await definitionPaths(
      document,
      positionOf(document, "plainFrother.size", 2),
    );
    assert.ok(
      countOf(definitions, page.fsPath) <= 1,
      `Only VS Code's JavaScript support may answer in a plain script; got ${JSON.stringify(definitions)}`,
    );
  });
});
