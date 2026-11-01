import * as assert from "node:assert";
import * as vscode from "vscode";
import { HTML_LANGUAGE_FEATURES } from "../script-check";
import {
  activateExtension,
  rangeOf,
  typeScriptDiagnostics,
  typeScriptFixture,
  waitLong,
} from "../test/typescript-fixture";

// With VS Code's HTML language features disabled (the "no-html-features" configuration), nothing else knows the
// blocks are TypeScript, and Bascik's server still reports their errors at their exact ranges.
suite("TypeScript errors without VS Code's HTML language features", () => {
  const { page } = typeScriptFixture();

  suiteSetup(activateExtension);

  test("reports the block's errors at their exact ranges", async () => {
    assert.strictEqual(
      vscode.extensions.getExtension(HTML_LANGUAGE_FEATURES),
      undefined,
    );
    const document = await vscode.workspace.openTextDocument(page);
    await waitLong(
      () => typeScriptDiagnostics(page).length === 2,
      `Two TypeScript errors should be published; got ${JSON.stringify(typeScriptDiagnostics(page))}`,
      30_000,
    );
    const ranges = typeScriptDiagnostics(page)
      .map((diagnostic) => diagnostic.range)
      .sort((a, b) => a.start.compareTo(b.start));
    assert.ok(ranges[0].isEqual(rangeOf(document, "label")));
    assert.ok(ranges[1].isEqual(rangeOf(document, "rpm")));
  });
});
