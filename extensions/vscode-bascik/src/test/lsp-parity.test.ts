import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The extension and the language server each carry their own copy of the
 * HTML analysis code. These checks fail when the copies drift apart, so a fix
 * to one (such as the script and style tag rules) always reaches both.
 */
const root = path.resolve(__dirname, '../../../..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

/** Source lines that hold a script or style tag pattern, in sorted order. */
const tagPatternLines = (source: string): string[] =>
  source
    .split('\n')
    .filter((line) => /\[\\s\\S\]\*\?/.test(line) && /script|style/.test(line))
    .map((line) => line.trim())
    .sort();

suite('LSP parity', () => {
  test('component metadata analysis is identical', () => {
    assert.strictEqual(
      read('extensions/vscode-bascik/src/component-metadata.ts'),
      read('lsp/src/component-metadata.ts'),
    );
  });

  test('server script rules are identical apart from import specifiers', () => {
    const withoutImports = (source: string) => source.replace(/^import .*$/gm, '');
    assert.strictEqual(
      withoutImports(read('extensions/vscode-bascik/src/server-script-rules.ts')),
      withoutImports(read('lsp/src/server-script-rules.ts')),
    );
  });

  test('script and style tag patterns are identical', () => {
    const extension = tagPatternLines(read('extensions/vscode-bascik/src/extension.ts'));
    const lsp = tagPatternLines(read('lsp/src/analyzer.ts'));
    assert.ok(lsp.length >= 4, `expected the analyzer's tag patterns, found ${lsp.length}`);
    assert.deepStrictEqual(extension, lsp);
  });
});
