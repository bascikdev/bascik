import * as assert from "node:assert";
import * as path from "node:path";
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

// VS Code's HTML support reads a server-side block with the DOM library too, whatever its directive. So a global
// Node and the DOM both declare (console, setTimeout, URL) is answered there, and Bascik answers only Node's own
// (process) and what Bascik types (the default export's parameters).
suite("TypeScript language features in a server-side block", () => {
  const { serverPage } = typeScriptFeaturesFixture();
  let document: vscode.TextDocument;

  suiteSetup(async () => {
    await activateExtension();
    document = await vscode.workspace.openTextDocument(serverPage);
    await vscode.window.showTextDocument(document);
  });

  teardown(async () => {
    if (document.isDirty) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });

  /** Waits until Bascik answers in the page, so a missing duplicate is not just a slow server. */
  const bascikAnswering = () =>
    eventuallyAnswered(
      () => hoverTexts(document, positionOf(document, "context.remoteIp", 2)),
      (all) => all.some((text) => text.includes("ServerScriptContext")),
      "Bascik should hover context with the type @bascik/bascik gives it",
    );

  test("hovers a global Node and the DOM share once, and Node's own from Bascik", async () => {
    await bascikAnswering();
    for (const [needle, delta, name] of [
      ["console.log", 2, "console"],
      ["log(frother", 1, "log"],
      ["setTimeout", 2, "setTimeout"],
      ["new URL", 5, "URL"],
      ["url.pathname", 5, "pathname"],
    ] as const) {
      const hovers = await hoverTexts(
        document,
        positionOf(document, needle, delta),
      );
      assert.strictEqual(
        hovers.filter((text) => text.includes(name)).length,
        1,
        `One hover should describe ${name}; got ${JSON.stringify(hovers)}`,
      );
    }
    const process = await hoverTexts(
      document,
      positionOf(document, "process.cwd", 2),
    );
    assert.ok(
      process.some((text) => text.includes("NodeJS.Process")),
      `Bascik should hover process with Node's type; got ${JSON.stringify(process)}`,
    );
  });

  test("goes to a shared global's definition only in VS Code's library", async () => {
    await bascikAnswering();
    const definitions = await definitionPaths(
      document,
      positionOf(document, "console.log", 2),
    );
    assert.ok(
      definitions.length > 0 &&
        definitions.every(
          (fsPath) => !fsPath.includes(`${path.sep}@types${path.sep}node`),
        ),
      `Only VS Code's definitions of console; got ${JSON.stringify(definitions)}`,
    );
  });

  test("completes each global and console member once", async () => {
    await bascikAnswering();
    const original = document.getText();
    await replaceUnsaved(
      document,
      original.replace("    setTimeout(", "    con\n    setTimeout("),
    );
    const globals = await eventuallyAnswered(
      () => completionLabels(document, positionOf(document, "    con\n", 7)),
      (all) => all.includes("process"),
      "Completion should offer Node's process from Bascik",
    );
    for (const name of ["console", "setTimeout", "fetch", "URL", "process"])
      assert.strictEqual(
        countOf(globals, name),
        1,
        `${name} once; got ${JSON.stringify(globals)}`,
      );
    await replaceUnsaved(
      document,
      original.replace("    setTimeout(", "    console.\n    setTimeout("),
    );
    const members = await completionLabels(
      document,
      positionOf(document, "console.\n", 8),
      ".",
    );
    for (const name of ["log", "error"])
      assert.strictEqual(
        countOf(members, name),
        1,
        `console.${name} once; got ${JSON.stringify(members)}`,
      );
  });
});
