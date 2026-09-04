import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

function getBascikExtension(): vscode.Extension<unknown> | undefined {
  return (
    vscode.extensions.getExtension('bascik.bascik-vscode') ??
    vscode.extensions.all.find((ext) => ext.packageJSON?.name === 'bascik-vscode')
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
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<div><my-button></my-button></div>',
      });
      const pos = new vscode.Position(0, 7); // position inside 'my-button'
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos,
      );

      assert.ok(locations && locations.length > 0, 'Definition should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/components/my-button.html'),
        `Expected location to end with src/components/my-button.html, got ${targetPath}`,
      );
    });

    test('provides definition for nested component tag', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<my-card></my-card>',
      });
      const pos = new vscode.Position(0, 3); // position inside 'my-card'
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos,
      );

      assert.ok(locations && locations.length > 0, 'Definition for nested component should be found');
      const targetPath = locations[0].uri.fsPath.replace(/\\/g, '/');
      assert.ok(
        targetPath.endsWith('src/components/card/my-card.html'),
        `Expected location to end with src/components/card/my-card.html, got ${targetPath}`,
      );
    });

    test('provides definition for a component in a second configured components root', async () => {
      // bascik.config.ts in the fixture lists ['src/components', 'shared-components'].
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<shared-pill>Hi</shared-pill>',
      });
      const pos = new vscode.Position(0, 4); // inside 'shared-pill'
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        pos,
      );

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
  });

  suite('Script Import Definitions', () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const fixtureUri = workspaceFolder
      ? vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, 'src', 'script-import-nav.html'))
      : undefined;

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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const fixtureUri = workspaceFolder
      ? vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, 'src', 'script-import-alias.html'))
      : undefined;

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

  suite('Diagnostics', () => {
    test('reports info when an ID reference is not declared in the component', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');
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
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<div>\n<my-button>\n</div>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('Component tag <my-button> is unclosed'));
      assert.ok(match, 'Expected unclosed component tag warning');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });

    test('does not report unclosed component warning when nested component is self-closing', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<my-card>\n<my-card />\n</my-card>',
      });
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');

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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');

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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'Workspace folder should be open');

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

  suite('Code Actions (Quick Fixes)', () => {
    test('rewrites req.headers[\'x-user\'] to request.headers.get(\'x-user\')', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<script data-bascik-server>\nexport default async (request) => {\n  const user = req.headers[\'x-user\'];\n  return `<p>${user}</p>`;\n};\n</script>',
      });
      await vscode.window.showTextDocument(doc);
      const targetNeedle = "req.headers['x-user']";
      const index = doc.getText().indexOf(targetNeedle);
      assert.ok(index >= 0);
      const range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + targetNeedle.length));

      const codeActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        doc.uri,
        range,
        vscode.CodeActionKind.QuickFix.value,
      );

      assert.ok(codeActions && codeActions.length > 0, 'Code actions should be returned');
      const action = codeActions.find((a) => a.title === 'Rewrite to the standard Request API');
      assert.ok(action, 'Expected "Rewrite to the standard Request API" action');
      assert.ok(action.edit, 'Action should have a workspace edit');

      const editApplied = await vscode.workspace.applyEdit(action.edit);
      assert.ok(editApplied, 'Workspace edit should be applied');
      assert.ok(doc.getText().includes("request.headers.get('x-user')"), `Updated doc should have request.headers.get('x-user'), got: ${doc.getText()}`);
    });
  });
});
