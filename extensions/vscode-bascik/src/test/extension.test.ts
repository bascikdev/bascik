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

  suite('Diagnostics', () => {
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

    test('reports CSS compatibility warning in html style tag', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<style>\n@import "theme.css";\n</style>',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('CSS @import is not processed'));
      assert.ok(match, 'Expected CSS compatibility warning in style block');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
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
        content: '@import "base.css";',
      });
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const match = diagnostics.find((d) => d.message.includes('CSS @import is not processed'));
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
      const doc = await vscode.workspace.openTextDocument({
        language: 'html',
        content: '<article><p>Card</p></article>',
      });
      // Test file with fsPath ending with src/components/card.html
      const fileDoc = await vscode.workspace.openTextDocument(nonHyphenatedUri);
      const diagnostics = vscode.languages.getDiagnostics(fileDoc.uri);
      const match = diagnostics.find((d) =>
        d.message.includes('Under WHATWG HTML §4.13, custom elements should include a hyphen'),
      );
      assert.ok(match, 'Expected non-hyphenated component warning');
      assert.strictEqual(match.severity, vscode.DiagnosticSeverity.Warning);
    });
  });
});
