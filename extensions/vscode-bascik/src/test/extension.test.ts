import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

function getBascikExtension(): vscode.Extension<unknown> | undefined {
  return (
    vscode.extensions.getExtension('bascik.bascik-vscode') ??
    vscode.extensions.all.find((ext) => ext.packageJSON?.name === 'bascik-vscode')
  );
}

function getWorkspaceFolder(name: string): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === name);
  assert.ok(folder, `Workspace folder ${name} should be open`);
  return folder;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function definitionsInFile(
  folderName: string,
  relativePath: string,
  needle: string,
): Promise<vscode.Location[]> {
  const folder = getWorkspaceFolder(folderName);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(folder.uri.fsPath, relativePath)),
  );
  const index = document.getText().indexOf(needle);
  assert.ok(index >= 0, `${relativePath} should contain ${needle}`);
  return vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    document.uri,
    document.positionAt(index + Math.max(1, Math.floor(needle.length / 2))),
  );
}

suite('Extension Integration Suite', () => {
  suiteSetup(async () => {
    const ext = getBascikExtension();
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  });

  test('Extension is registered and active', () => {
    const ext = getBascikExtension();
    assert.ok(ext, 'Extension bascik-vscode should be found');
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  suite('ComponentDefinitionProvider', () => {
    test('provides definition for top-level component tag', async () => {
      const locations = await definitionsInFile('primary', 'src/component-nav.html', 'my-button');

      assert.ok(locations && locations.length > 0, 'Definition should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/components/my-button.html'),
        `Expected location to end with src/components/my-button.html, got ${targetPath}`,
      );
    });

    test('provides definition for nested component tag', async () => {
      const locations = await definitionsInFile('primary', 'src/component-nav.html', 'my-card');

      assert.ok(locations && locations.length > 0, 'Definition for nested component should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/components/card/my-card.html'),
        `Expected location to end with src/components/card/my-card.html, got ${targetPath}`,
      );
    });

    test('provides definition for a component in a second configured components root', async () => {
      // bascik.config.ts in the fixture lists ['src/components', 'shared-components'].
      const locations = await definitionsInFile('primary', 'src/component-nav.html', 'shared-pill');

      assert.ok(locations && locations.length > 0, 'Definition in the second root should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('shared-components/shared-pill.html'),
        `Expected location to end with shared-components/shared-pill.html, got ${targetPath}`,
      );
    });

    test('returns undefined for built-in HTML element', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<div><span>Hello</span></div>',
      });
      const pos = new vscode.Position(0, 2); // position inside 'div'
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos,
      );

      assert.ok(!locations || locations.length === 0, 'No definition should be provided for built-in element');
    });

    test('returns undefined for unknown component tag', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<unknown-widget></unknown-widget>',
      });
      const pos = new vscode.Position(0, 3); // position inside 'unknown-widget'
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos,
      );

      assert.ok(!locations || locations.length === 0, 'No definition should be provided for unknown component');
    });

    for (const language of ['javascript', 'typescript', 'css']) {
      test(`does not provide component definitions in ${language}`, async () => {
        const doc = await vscode.workspace.openTextDocument({ language, content: 'my-button' });
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          doc.uri,
          new vscode.Position(0, 3),
        );
        assert.ok(!locations || locations.length === 0);
      });
    }

    test('isolates conflicting component names between workspace folders', async () => {
      const primary = await definitionsInFile('primary', 'src/component-nav.html', 'conflict-card');
      const secondary = await definitionsInFile('secondary', 'src/component-nav.html', 'conflict-card');
      assert.ok(primary?.[0].uri.fsPath.endsWith(path.join('sample-workspace', 'src', 'components', 'conflict-card.html')));
      assert.ok(secondary?.[0].uri.fsPath.endsWith(path.join('secondary-workspace', 'ui', 'components', 'conflict-card.html')));
    });
  });

  suite('Script Import Definitions', () => {
    const fixtureUri = vscode.Uri.file(
      path.join(getWorkspaceFolder('primary').uri.fsPath, 'src', 'script-import-nav.html'),
    );

    const definitionInside = async (needle: string): Promise<vscode.Location[]> => {
      assert.ok(fixtureUri, 'Workspace folder should be open');
      const doc = await vscode.workspace.openTextDocument(fixtureUri);
      const text = doc.getText();
      const index = text.indexOf(needle);
      assert.ok(index >= 0, `Fixture should contain ${needle}`);
      // Position the cursor a few characters before the end of the needle so it
      // lands inside the specifier string or attribute value.
      const position = doc.positionAt(index + needle.length - 3);
      return vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        position,
      );
    };

    const assertNavHelper = (locations: vscode.Location[] | undefined) => {
      assert.ok(locations && locations.length > 0, 'Definition should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/lib/nav-helper.ts'),
        `Expected location to end with src/lib/nav-helper.ts, got ${targetPath}`,
      );
    };

    test('provides definition for relative import in data-bascik-build script', async () => {
      const locations = await definitionInside("helperFn } from './lib/nav-helper.ts'");
      assertNavHelper(locations);
    });

    test('provides definition for relative import in data-bascik-server script', async () => {
      const locations = await definitionInside("serverHelper } from './lib/nav-helper.ts'");
      assertNavHelper(locations);
    });

    test('provides definition for src attribute on data-bascik-build script', async () => {
      const locations = await definitionInside('<script data-bascik-build src="./lib/nav-helper.ts">');
      assertNavHelper(locations);
    });

    test('provides definition for src attribute on data-bascik-server script', async () => {
      const locations = await definitionInside('<script data-bascik-server src="./lib/nav-helper.ts">');
      assertNavHelper(locations);
    });

    test('provides definition for dynamic import in data-bascik-build script', async () => {
      const locations = await definitionInside("await import('./lib/nav-helper.ts')");
      assertNavHelper(locations);
    });

    test('provides definition for export-from in data-bascik-routes with closing-tag whitespace', async () => {
      const locations = await definitionInside("routeHelper } from './lib/nav-helper.ts'");
      assertNavHelper(locations);
    });

    test('provides definition for unquoted relative src', async () => {
      const locations = await definitionInside('<script data-bascik-build src=./lib/nav-helper.ts>');
      assertNavHelper(locations);
    });

    test('provides definition for a bare path src resolved relative to the document', async () => {
      const locations = await definitionInside('<script data-bascik-routes src=lib/nav-helper.ts>');
      assertNavHelper(locations);
    });

    test('provides definition for parent-relative src', async () => {
      const locations = await definitionInside('<script data-bascik-server src=../src/lib/nav-helper.ts>');
      assertNavHelper(locations);
    });

    test('returns no definition for a missing relative target', async () => {
      const locations = await definitionInside('./lib/missing-helper.ts');
      assert.ok(!locations || locations.length === 0, 'No definition for missing target');
    });

    for (const nonCodeImport of [
      "// import './lib/nav-helper.ts'",
      `\"import('./lib/nav-helper.ts')\"`,
      "`import('./lib/nav-helper.ts')`",
      "/import\\(['\"]\\.\\/lib\\/nav-helper\\.ts['\"]\\)/",
      `if (ready) /import\\(['"]\\.\\/lib\\/nav-helper\\.ts['"]\\)/`,
      `{ markReady(); } /import\\(['"]\\.\\.\\/lib\\/nav-helper\\.ts['"]\\)/`,
      "obj.import('./lib/nav-helper.ts')",
    ]) {
      test(`returns no definition for non-code import ${nonCodeImport}`, async () => {
        const locations = await definitionInside(nonCodeImport);
        assert.ok(!locations || locations.length === 0, 'No definition for non-code import');
      });
    }

    test('returns no definition for bare specifier in data-bascik-build script', async () => {
      const locations = await definitionInside("from 'node:fs/promises'");
      assert.ok(!locations || locations.length === 0, 'No definition for bare specifier');
    });

    test('returns no definition for relative import in client script', async () => {
      const locations = await definitionInside("clientHelper } from './lib/nav-helper.ts'");
      assert.ok(!locations || locations.length === 0, 'No definition for client script import');
    });
  });

  suite('Script Import Definitions: import-root alias (@/)', () => {
    const fixtureUri = vscode.Uri.file(
      path.join(getWorkspaceFolder('primary').uri.fsPath, 'src', 'script-import-alias.html'),
    );

    const definitionInside = async (needle: string): Promise<vscode.Location[]> => {
      assert.ok(fixtureUri, 'Workspace folder should be open');
      const doc = await vscode.workspace.openTextDocument(fixtureUri);
      const text = doc.getText();
      const index = text.indexOf(needle);
      assert.ok(index >= 0, `Fixture should contain ${needle}`);
      const position = doc.positionAt(index + needle.length - 3);
      return vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        position,
      );
    };

    const assertNavHelper = (locations: vscode.Location[] | undefined) => {
      assert.ok(locations && locations.length > 0, 'Definition should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/lib/nav-helper.ts'),
        `Expected location to end with src/lib/nav-helper.ts, got ${targetPath}`,
      );
    };

    test('resolves @/ import in data-bascik-build against the import root', async () => {
      assertNavHelper(await definitionInside("aliasHelper } from '@/lib/nav-helper.ts'"));
    });

    test('returns no definition for a leading-slash import (it is a compile error, not an alias)', async () => {
      const locations = await definitionInside("slashHelper } from '/lib/nav-helper.ts'");
      assert.ok(!locations || locations.length === 0, 'No definition for leading-slash specifier');
    });

    test('resolves @/ export-from in data-bascik-routes', async () => {
      assertNavHelper(await definitionInside("aliasRouteHelper } from '@/lib/nav-helper.ts'"));
    });

    test('resolves @/ dynamic import', async () => {
      assertNavHelper(await definitionInside("await import('@/lib/nav-helper.ts')"));
    });

    test('resolves src="@/…" on a build script', async () => {
      assertNavHelper(await definitionInside('<script data-bascik-build src="@/lib/nav-helper.ts">'));
    });

    test('returns no definition for a leading-slash src= on a server script', async () => {
      const locations = await definitionInside('<script data-bascik-server src="/lib/nav-helper.ts">');
      assert.ok(!locations || locations.length === 0, 'No definition for leading-slash src');
    });

    test('isolates import roots between workspace folders', async () => {
      const locations = await definitionsInFile(
        'secondary',
        'src/script-import-alias.html',
        '@/lib/nav-helper.ts',
      );
      assert.ok(locations?.[0].uri.fsPath.endsWith(path.join('secondary-workspace', 'app', 'lib', 'nav-helper.ts')));
    });

    test('reports an Error diagnostic for each leading-slash specifier and src= in Bascik scripts, naming the @/ fix', async () => {
      assert.ok(fixtureUri, 'Workspace folder should be open');
      const doc = await vscode.workspace.openTextDocument(fixtureUri);
      // The fixture was already opened by the definition tests above, so
      // onDidOpenTextDocument will not fire again. Show it to trigger the
      // active-editor refresh path and then poll briefly.
      await vscode.window.showTextDocument(doc);
      let diagnostics = vscode.languages.getDiagnostics(doc.uri);
      for (let i = 0; i < 20 && !diagnostics.some((d) => d.code === 'leading-slash-specifier'); i++) {
        await new Promise((r) => setTimeout(r, 50));
        diagnostics = vscode.languages.getDiagnostics(doc.uri);
      }
      const slashDiags = diagnostics.filter((d) => d.code === 'leading-slash-specifier');
      assert.strictEqual(slashDiags.length, 2, `Expected exactly 2 leading-slash diagnostics, got ${slashDiags.length}`);
      for (const d of slashDiags) {
        assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Error);
        assert.ok(d.message.includes("'/lib/nav-helper.ts'"), d.message);
        assert.ok(d.message.includes("'@/lib/nav-helper.ts'"), d.message);
        assert.ok(d.message.includes("'./lib/nav-helper.ts'"), d.message);
      }
      const text = doc.getText();
      const flagged = slashDiags.map((d) => text.slice(doc.offsetAt(d.range.start), doc.offsetAt(d.range.end)));
      assert.ok(flagged.every((f) => f === '/lib/nav-helper.ts'), `Ranges should cover the specifier, got ${JSON.stringify(flagged)}`);
      // The client <script type="module"> with '/lib/client-root.js' must not be flagged.
      assert.ok(!diagnostics.some((d) => d.message.includes('client-root.js')), 'Client script leading slash must not be flagged');
    });

    test('does not treat a scoped package as an alias', async () => {
      const locations = await definitionInside("from '@scope/nav-helper.ts'");
      assert.ok(!locations || locations.length === 0, 'No definition for scoped package');
    });

    test('returns no definition for a missing alias target', async () => {
      const locations = await definitionInside("'@/lib/missing-helper.ts'");
      assert.ok(!locations || locations.length === 0, 'No definition for missing alias target');
    });
  });

  suite('Project cache lifecycle', () => {
    test('invalidates component discovery after creating and deleting a component', async () => {
      const folder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'components', 'cache-widget.html'));
      const usageUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'cache-widget-usage.html'));
      await vscode.workspace.fs.writeFile(usageUri, Buffer.from('<cache-widget></cache-widget>'));

      try {
        await vscode.workspace.fs.writeFile(componentUri, Buffer.from('<p>Cache fixture</p>'));
        await waitFor(async () => {
          const locations = await definitionsInFile('primary', 'src/cache-widget-usage.html', 'cache-widget');
          return locations?.[0]?.uri.fsPath === componentUri.fsPath;
        }, 'Created component should become discoverable');

        await vscode.workspace.fs.delete(componentUri);
        await waitFor(async () => {
          const locations = await definitionsInFile('primary', 'src/cache-widget-usage.html', 'cache-widget');
          return !locations || locations.length === 0;
        }, 'Deleted component should leave the discovery cache');
      } finally {
        try { await vscode.workspace.fs.delete(componentUri); } catch {}
        try { await vscode.workspace.fs.delete(usageUri); } catch {}
      }
    });

    test('uses open HTML contents and restores disk usage after close', async () => {
      const folder = getWorkspaceFolder('primary');
      const usageUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'cache-prop-usage.html'));
      const componentUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'components', 'attribute-card.html'));
      await vscode.workspace.fs.writeFile(usageUri, Buffer.from('<attribute-card></attribute-card>'));

      try {
        await vscode.workspace.openTextDocument(componentUri);
        await waitFor(() => vscode.languages.getDiagnostics(componentUri).some((diagnostic) =>
          diagnostic.message.includes('data-bascik-attr-href references prop "link"'),
        ), 'Missing prop diagnostic should be present initially');

        const usage = await vscode.workspace.openTextDocument(usageUri);
        const editor = await vscode.window.showTextDocument(usage);
        await editor.edit((edit) => edit.replace(
          new vscode.Range(usage.positionAt(0), usage.positionAt(usage.getText().length)),
          '<attribute-card data-bascik-prop-link="/docs"></attribute-card>',
        ));
        await waitFor(() => !vscode.languages.getDiagnostics(componentUri).some((diagnostic) =>
          diagnostic.message.includes('data-bascik-attr-href references prop "link"'),
        ), 'Open usage buffer should satisfy the prop diagnostic');

        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await waitFor(() => vscode.languages.getDiagnostics(componentUri).some((diagnostic) =>
          diagnostic.message.includes('data-bascik-attr-href references prop "link"'),
        ), 'Closing the buffer should restore disk-backed prop usage');
      } finally {
        try { await vscode.workspace.fs.delete(usageUri); } catch {}
      }
    });

    test('rebuilds configured component and import roots after config changes', async () => {
      const folder = getWorkspaceFolder('primary');
      const configUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'bascik.config.ts'));
      const usageUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'cache-config-usage.html'));
      const externalRoot = path.join(folder.uri.fsPath, '..', 'cache-external-components');
      const externalComponentUri = vscode.Uri.file(path.join(externalRoot, 'external-widget.html'));
      const alternateImportUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'alternate-imports', 'cache-helper.ts'));
      const originalConfig = await vscode.workspace.fs.readFile(configUri);

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(externalRoot));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(alternateImportUri.fsPath)));
      await vscode.workspace.fs.writeFile(externalComponentUri, Buffer.from('<p>External component</p>'));
      await vscode.workspace.fs.writeFile(alternateImportUri, Buffer.from('export const cacheHelper = true;'));
      await vscode.workspace.fs.writeFile(usageUri, Buffer.from(
        '<external-widget></external-widget>\n<script data-bascik-build>import { cacheHelper } from "@/cache-helper.ts";</script>',
      ));

      try {
        const escapedRoot = externalRoot.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await vscode.workspace.fs.writeFile(configUri, Buffer.from(
          `export default { directory: { components: '${escapedRoot}' }, scripts: { importRoot: 'alternate-imports' } };`,
        ));

        await waitFor(async () => {
          const locations = await definitionsInFile('primary', 'src/cache-config-usage.html', 'external-widget');
          return locations?.[0]?.uri.fsPath === externalComponentUri.fsPath;
        }, 'Changed component root should be discovered');
        await waitFor(async () => {
          const locations = await definitionsInFile('primary', 'src/cache-config-usage.html', '@/cache-helper.ts');
          return locations?.[0]?.uri.fsPath === alternateImportUri.fsPath;
        }, 'Changed import root should be used');
      } finally {
        await vscode.workspace.fs.writeFile(configUri, originalConfig);
        try { await vscode.workspace.fs.delete(usageUri); } catch {}
        try { await vscode.workspace.fs.delete(vscode.Uri.file(externalRoot), { recursive: true }); } catch {}
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(path.dirname(alternateImportUri.fsPath)), { recursive: true });
        } catch {}
      }

      await waitFor(async () => {
        const locations = await definitionsInFile('primary', 'src/component-nav.html', 'my-button');
        return locations?.[0]?.uri.fsPath.endsWith(path.join('src', 'components', 'my-button.html')) ?? false;
      }, 'Restored config should rebuild the original component root');
    });

    test('clears diagnostics and recreates state when a workspace folder is removed and added', async () => {
      const secondary = getWorkspaceFolder('secondary');
      const secondaryIndex = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.name === 'secondary') ?? -1;
      assert.ok(secondaryIndex >= 0);
      const diagnosticUri = vscode.Uri.file(path.join(secondary.uri.fsPath, 'src', 'cache-folder-lifecycle.html'));
      await vscode.workspace.fs.writeFile(diagnosticUri, Buffer.from(
        '<script data-bascik-build data-bascik-server>console.log(1)</script>',
      ));

      try {
        await vscode.workspace.openTextDocument(diagnosticUri);
        await waitFor(() => vscode.languages.getDiagnostics(diagnosticUri).length > 0,
          'Fixture should receive diagnostics before folder removal');
        assert.strictEqual(vscode.workspace.updateWorkspaceFolders(secondaryIndex, 1), true);
        await waitFor(() => !vscode.workspace.workspaceFolders?.some((folder) => folder.name === 'secondary'),
          'Secondary workspace folder should be removed');
        await waitFor(() => vscode.languages.getDiagnostics(diagnosticUri).length === 0,
          'Removed workspace diagnostics should be cleared');
      } finally {
        if (!vscode.workspace.workspaceFolders?.some((folder) => folder.name === 'secondary')) {
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: secondary.uri, name: secondary.name },
          );
        }
        await waitFor(() => vscode.workspace.workspaceFolders?.some((folder) => folder.name === 'secondary') ?? false,
          'Secondary workspace folder should be restored');
        try { await vscode.workspace.fs.delete(diagnosticUri); } catch {}
      }

      await waitFor(async () => {
        const locations = await definitionsInFile('secondary', 'src/component-nav.html', 'conflict-card');
        return locations?.[0]?.uri.fsPath.endsWith(path.join('ui', 'components', 'conflict-card.html')) ?? false;
      }, 'Re-added workspace folder should recreate its project state');
    });
  });

  suite('Diagnostics', () => {
    test('reports info when an ID reference is not declared in the component', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'id-reference-missing.html'),
      );
      const doc = await vscode.workspace.openTextDocument(componentUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const matches = diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('is not declared in this component and will be left unscoped'),
      );
      assert.strictEqual(matches.length, 2);
      assert.ok(matches.every((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Information));
    });

    test('does not report info when an ID reference resolves locally', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'id-reference-local.html'),
      );
      const doc = await vscode.workspace.openTextDocument(componentUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      assert.ok(!diagnostics.some((diagnostic) =>
        diagnostic.message.includes('is not declared in this component and will be left unscoped'),
      ));
    });

    test('does not report component ID reference info for non-component HTML', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<label for="missing">Email</label><a href="#outside">Outside</a>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      assert.ok(!diagnostics.some((diagnostic) =>
        diagnostic.message.includes('is not declared in this component and will be left unscoped'),
      ));
    });

    test('ignores ID references inside component raw-text elements', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'id-reference-raw-text.html'),
      );
      const doc = await vscode.workspace.openTextDocument(componentUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri).filter((diagnostic) =>
        diagnostic.message.includes('is not declared in this component and will be left unscoped'),
      );
      assert.deepStrictEqual(
        diagnostics.map((diagnostic) => diagnostic.message),
        ['ID reference "outside" is not declared in this component and will be left unscoped.'],
      );
    });

    test('warns when data-bascik-preserve contains an unknown token', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<div data-bascik-preserve="id href"></div>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((diagnostic) =>
        diagnostic.message.includes('Unknown data-bascik-preserve token "href"'),
      );
      assert.ok(match, 'Expected warning for an unknown preserve token');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('does not warn for an external form outside a component file', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<form action="https://forms.example/submit"><input name="email"></form>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      assert.ok(!diagnostics.some((diagnostic) =>
        diagnostic.message.includes('External form actions require data-bascik-preserve="name"'),
      ));
    });

    test('warns when a component external form does not preserve name attributes', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'external-form.html'),
      );
      const doc = await vscode.workspace.openTextDocument(componentUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((diagnostic) =>
        diagnostic.message.includes('External form actions require data-bascik-preserve="name"'),
      );
      assert.ok(match, 'Expected warning for an external form with scoped names');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('accepts an external form that preserves name attributes', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<form action="https://forms.example/submit" data-bascik-preserve="name"><input name="email"></form>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      assert.ok(!diagnostics.some((diagnostic) =>
        diagnostic.message.includes('External form actions require data-bascik-preserve="name"'),
      ));
    });

    test('warns when no usage supplies the prop named by an attribute directive', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');
      const componentUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'attribute-card.html'),
      );
      const doc = await vscode.workspace.openTextDocument(componentUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((diagnostic) =>
        diagnostic.message.includes('data-bascik-attr-href references prop "link"'),
      );
      assert.ok(match, 'Expected warning for an attribute directive prop missing from every usage');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports error when script has both data-bascik-build and data-bascik-server', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-build data-bascik-server>\nconsole.log(1);\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('data-bascik-build and data-bascik-server cannot both appear'),
      );
      assert.ok(match, 'Expected error diagnostic for conflicting script attributes');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Error);
    });

    test('reports error when script has both data-bascik-routes and data-bascik-server', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-routes data-bascik-server>\nconsole.log(1);\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('data-bascik-routes and data-bascik-server cannot both appear'),
      );
      assert.ok(match, 'Expected error diagnostic for conflicting routes/server script attributes');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Error);
    });

    test('reports error when script has both data-bascik-routes and data-bascik-build', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-routes data-bascik-build>\nconsole.log(1);\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('data-bascik-routes and data-bascik-build cannot both appear'),
      );
      assert.ok(match, 'Expected error diagnostic for conflicting routes/build script attributes');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Error);
    });

    test('reports JS compatibility warning in html script tag', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script>\nelement.id = "custom";\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Runtime .id assignment'));
      assert.ok(match, 'Expected JS compatibility warning in script block');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('does not report CSS compatibility warning for @import in html style tag', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<style>\n@import "theme.css";\n</style>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('CSS @import is not processed'));
      assert.ok(!match, 'Should NOT report CSS compatibility warning for @import in style block');
    });

    test('reports unclosed component tag warning', async () => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(getWorkspaceFolder('primary').uri.fsPath, 'src', 'unclosed-component.html')),
      );
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Component tag <my-button> is unclosed'));
      assert.ok(match, 'Expected unclosed component tag warning');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('does not report unclosed component warning when nested component is self-closing', async () => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(getWorkspaceFolder('primary').uri.fsPath, 'src', 'self-closing-component.html')),
      );
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Component tag <my-card> is unclosed'));
      assert.ok(!match, 'Should NOT report unclosed warning when nested child component is self-closing');
    });

    test('does not report warning for multiple style tags', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<style>.a { color: red; }</style>\n<style>.b { color: blue; }</style>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Component has multiple <style> tags'));
      assert.ok(!match, 'Should not report warning for multiple style tags');
    });

    test('reports companion CSS file conflict when opening html file', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');

      const companionUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'companion.html'),
      );
      const doc = await vscode.workspace.openTextDocument(companionUri);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('Component has both a companion .css file and an inline <style> tag'),
      );
      assert.ok(match, 'Expected warning for companion CSS file conflict');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports compatibility warning in standalone CSS file', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'css',
        content: '[data-state] { color: red; }',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Standalone attribute selectors are not scoped'));
      assert.ok(match, 'Expected CSS warning in standalone CSS file');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports compatibility warning in standalone JS file', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'javascript',
        content: 'document.querySelector("[data-target]");',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Attribute selectors are not rewritten'));
      assert.ok(match, 'Expected JS warning in standalone JS file');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports non-hyphenated component name warning for component files in src/components/', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');

      const nonHyphenatedUri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'src', 'components', 'card.html'),
      );
      // Test file with fsPath ending with src/components/card.html
      const fileDoc = await vscode.workspace.openTextDocument(nonHyphenatedUri);
      const diagnostics = vscode.languages.getDiagnostics(fileDoc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('Under WHATWG HTML §4.13, custom elements should include a hyphen'),
      );
      assert.ok(match, 'Expected non-hyphenated component warning');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports non-hyphenated component name warning for files in a second configured components root', async () => {
      const workspaceFolder = getWorkspaceFolder('primary');

      const uri = vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, 'shared-components', 'widget.html'),
      );
      const fileDoc = await vscode.workspace.openTextDocument(uri);
      const diagnostics = vscode.languages.getDiagnostics(fileDoc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('Under WHATWG HTML §4.13, custom elements should include a hyphen'),
      );
      assert.ok(match, 'Expected non-hyphenated component warning for a file in the second root');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports server script missing default export error', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-server>\nconst x = 1;\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.code === 'server-script-missing-default-export');
      assert.ok(match, 'Expected server-script-missing-default-export diagnostic');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Error);
    });

    test('reports stream script href sink warning', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-stream>\nexport default async (request) => {\n  return `<a href="${x}">link</a>`;\n};\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.code === 'server-script-sink-url-attribute');
      assert.ok(match, 'Expected server-script-sink-url-attribute warning');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('reports conflict error when script has both data-bascik-stream and data-bascik-build', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-stream data-bascik-build>\nexport default async () => "";\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('data-bascik-build and data-bascik-stream cannot both appear') ||
        d.message.includes('data-bascik-stream and data-bascik-build cannot both appear'),
      );
      assert.ok(match, 'Expected error diagnostic for conflicting stream and build directives');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Error);
    });

    test('clean server script yields zero bascik diagnostics in that block', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-server>\nimport { escape } from "@/lib/server.ts";\nexport default async (request, context, { signal }) => {\n  const user = escape(request.headers.get("x-user") ?? "guest");\n  return `<p>Hello ${user}</p>`;\n};\n</script>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'bascik');
      assert.strictEqual(diagnostics.length, 0);
    });
  });
});
