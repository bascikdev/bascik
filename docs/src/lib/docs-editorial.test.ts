import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderMd } from './md-renderer.ts';

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');

async function getMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const parent = entry.parentPath ?? (entry as { path?: string }).path ?? dir;
      files.push(path.join(parent, entry.name));
    }
  }
  return files;
}

describe('docs editorial and technical accuracy', () => {
  it('does not contain numbered prompt provenance in rendered public docs prose', async () => {
    const contentFiles = await getMarkdownFiles(path.join(DOCS_ROOT, 'content'));
    const violations: { file: string; match: string; line: number }[] = [];

    // Pattern matches "prompt 05", "prompt 89", "prompts 88 through 90", "Prompt 05", etc.
    // Exclude legitimate terminal prompt symbols ("$ prompt") or AI agent prompt references if any.
    const promptRefRegex = /\b[Pp]rompts?\s+\d+\b/g;

    for (const filePath of contentFiles) {
      const relativePath = path.relative(DOCS_ROOT, filePath);
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');

      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          continue;
        }

        // Only inspect prose lines outside of code blocks
        if (!inCodeBlock) {
          let match: RegExpExecArray | null;
          promptRefRegex.lastIndex = 0;
          while ((match = promptRefRegex.exec(line)) !== null) {
            violations.push({
              file: relativePath,
              match: match[0],
              line: i + 1,
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found internal prompt provenance in public docs prose:\n${violations
        .map((v) => `  ${v.file}:${v.line} -> "${v.match}"`)
        .join('\n')}`
    ).toEqual([]);
  });

  it('renders cli.md and internals/diagnostics.md through renderMd without prompt provenance', async () => {
    const cliRendered = await renderMd('content/cli.md');
    const diagnosticsRendered = await renderMd('content/internals/diagnostics.md');

    expect(cliRendered).not.toMatch(/\b[Pp]rompts?\s+\d+\b/);
    expect(diagnosticsRendered).not.toMatch(/\b[Pp]rompts?\s+\d+\b/);
  });

  it('verifies Hugo href demo attribute binding syntax extraction', async () => {
    // Verifies that data-bascik-attr-href is extracted correctly and does not use text replacement syntax
    const hugoContent = await readFile(path.join(DOCS_ROOT, 'content/switch/from-hugo.md'), 'utf8');
    // Ensure that in from-hugo.md, any link attribute binding uses data-bascik-attr-href, not data-bascik-prop-href
    expect(hugoContent).not.toContain('data-bascik-prop-href');
  });
});
