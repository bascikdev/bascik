import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { bundledTypeScriptPath } from "../client-options";
import type { BascikExtensionApi } from "../extension";
import {
  rangeOf,
  typeScriptDiagnostics,
  typeScriptFixture,
  waitLong,
} from "../test/typescript-fixture";

// The bascik.typescript settings in a real editor (the "typescript-settings" configuration in .vscode-test.cjs):
// the path setting is the TypeScript the server loads, a path it cannot use falls back to VS Code's own, and
// settings changed close together restart the server once more rather than losing the second change.
suite("The bascik.typescript settings", () => {
  const { page } = typeScriptFixture();
  let api: BascikExtensionApi;
  let work: string;
  const settings = () => vscode.workspace.getConfiguration("bascik.typescript");

  /** A package named typescript that loads VS Code's own and leaves a mark when the server loads it. */
  function wrapperTypeScript(): { dir: string; marker: string } {
    const dir = path.join(work, "wrapper", "typescript");
    const marker = path.join(dir, "loaded.txt");
    fs.mkdirSync(dir, { recursive: true });
    const real = bundledTypeScriptPath(vscode.env.appRoot);
    const { version } = JSON.parse(
      fs.readFileSync(path.join(real, "package.json"), "utf8"),
    ) as { version: string };
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "typescript", version, main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\nmodule.exports = require(${JSON.stringify(real)});\n`,
    );
    return { dir, marker };
  }

  /** A package named typescript shaped like TypeScript 7: no language service. */
  function typeScript7(): string {
    const dir = path.join(work, "seven", "typescript");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "typescript",
        version: "7.0.2",
        main: "index.js",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      'module.exports = { version: "7.0.2" };\n',
    );
    return dir;
  }

  async function setPath(value: string | undefined): Promise<void> {
    await settings().update("path", value, vscode.ConfigurationTarget.Global);
    await api.restarts();
  }

  /** Closes the page, so the next open is checked by the restarted server from scratch. */
  async function closeAll(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }

  async function expectErrors(why: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(page);
    await vscode.window.showTextDocument(document);
    await waitLong(
      () =>
        typeScriptDiagnostics(page).some((diagnostic) =>
          diagnostic.range.isEqual(rangeOf(document, "rpm")),
        ),
      `${why}: the rpm error should be published; got ${JSON.stringify(typeScriptDiagnostics(page))}`,
      30_000,
    );
  }

  suiteSetup(async () => {
    const ext = vscode.extensions.all.find(
      (candidate) => candidate.packageJSON?.name === "bascik-vscode",
    );
    assert.ok(ext, "Extension bascik-vscode should be found");
    api = (
      ext.isActive ? ext.exports : await ext.activate()
    ) as BascikExtensionApi;
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-ts-setting-"));
  });

  suiteTeardown(async () => {
    await settings().update(
      "path",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await settings().update(
      "enabled",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await api.restarts();
    fs.rmSync(work, { recursive: true, force: true });
  });

  teardown(closeAll);

  test("the path setting is the TypeScript the server checks with", async () => {
    const wrapper = wrapperTypeScript();
    await setPath(wrapper.dir);
    await expectErrors("With the wrapper TypeScript");
    assert.ok(
      fs.existsSync(wrapper.marker),
      "The server should have loaded the TypeScript the setting names",
    );
  });

  test("misuse: a path to TypeScript 7, which has no language service, falls back to VS Code's own", async () => {
    await setPath(typeScript7());
    await expectErrors("With a TypeScript 7 path");
  });

  test("misuse: a path that does not exist falls back to VS Code's own", async () => {
    await setPath(path.join(work, "no", "such", "typescript"));
    await expectErrors("With a nonexistent path");
  });

  test("misuse: two settings changed close together both apply", async () => {
    await setPath(undefined);
    await expectErrors("Before the changes");
    await closeAll();
    // Off, then the path changed within a moment: both changes restart the server, one after the other.
    await settings().update(
      "enabled",
      false,
      vscode.ConfigurationTarget.Global,
    );
    await settings().update(
      "path",
      path.join(work, "another", "missing"),
      vscode.ConfigurationTarget.Global,
    );
    await api.restarts();
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(page),
    );
    await waitLong(
      () =>
        vscode.languages
          .getDiagnostics(page)
          .some((diagnostic) => diagnostic.code === "unknown-bascik-attribute"),
      "Bascik's own diagnostic should be published",
    );
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.deepStrictEqual(
      typeScriptDiagnostics(page),
      [],
      "The checks are off, as the last change left them",
    );
    await closeAll();
    // And back on within a moment of another change: the errors return.
    await settings().update(
      "path",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await settings().update(
      "enabled",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await api.restarts();
    await expectErrors("After turning the checks back on");
  });
});
