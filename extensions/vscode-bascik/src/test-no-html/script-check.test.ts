import * as assert from "node:assert";
import * as vscode from "vscode";
import type { BascikExtensionApi } from "../extension";
import { HTML_LANGUAGE_FEATURES } from "../script-check";

// Runs in its own editor, started with `--disable-extension vscode.html-language-features` (the
// "no-html-features" configuration in .vscode-test.cjs). Nothing checks inline scripts there, so the false
// "multiple default exports" error cannot appear and the prompt must not offer to switch the check off.
suite("Script check prompt without VS Code's HTML language features", () => {
  let api: BascikExtensionApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.all.find(
      (candidate) => candidate.packageJSON?.name === "bascik-vscode",
    );
    assert.ok(ext, "Extension bascik-vscode should be found");
    api = (
      ext.isActive ? ext.exports : await ext.activate()
    ) as BascikExtensionApi;
  });

  test("the built-in HTML language features are disabled in this editor", () => {
    assert.strictEqual(
      vscode.extensions.getExtension(HTML_LANGUAGE_FEATURES),
      undefined,
    );
  });

  test("activation in a Bascik workspace shows no prompt and writes no setting", async () => {
    const result = await api.firstScriptCheck;
    assert.strictEqual(result.outcome, "nothing-to-ask");
    assert.strictEqual(result.folders.primary, "no-html-check");
    assert.strictEqual(result.folders.secondary, "no-html-check");
    assert.strictEqual(result.folders.plain, "not-bascik");
    assert.strictEqual(api.scriptCheck.prompts.length, 0);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const settings = vscode.Uri.joinPath(
        folder.uri,
        ".vscode",
        "settings.json",
      );
      await assert.rejects(
        Promise.resolve(vscode.workspace.fs.stat(settings)),
        `${settings.fsPath} should not be written`,
      );
    }
  });

  test("a later check, as when a folder is added, still asks nothing", async () => {
    api.scriptCheck.forgetSession();
    const result = await api.scriptCheck.check();
    assert.strictEqual(result.outcome, "nothing-to-ask");
    assert.strictEqual(api.scriptCheck.prompts.length, 0);
  });
});
