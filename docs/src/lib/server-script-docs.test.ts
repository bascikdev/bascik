import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');

async function getMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      // In Node 20+, parentPath or path gives the directory
      const parent = entry.parentPath ?? (entry as { path?: string }).path ?? dir;
      files.push(path.join(parent, entry.name));
    }
  }
  return files;
}

describe('server and stream script docs hygiene', () => {
  it('does not contain deprecated server script patterns, BASCIK_REQUEST, or { req }', async () => {
    const contentFiles = await getMarkdownFiles(path.join(DOCS_ROOT, 'content'));
    const allFiles = [...contentFiles, path.join(DOCS_ROOT, 'src/pages/assets/SKILL.md')];

    const violations: { file: string; type: string; snippet: string }[] = [];

    for (const filePath of allFiles) {
      const relativePath = path.relative(DOCS_ROOT, filePath);
      const content = await readFile(filePath, 'utf8');

      // 1. BASCIK_REQUEST check
      if (content.includes('BASCIK_REQUEST')) {
        violations.push({
          file: relativePath,
          type: 'Contains BASCIK_REQUEST',
          snippet: 'Found BASCIK_REQUEST in file content',
        });
      }

      // 2. { req } check (case-sensitive literal "{ req }")
      if (/\{\s*req\s*\}/.test(content)) {
        violations.push({
          file: relativePath,
          type: 'Contains { req }',
          snippet: 'Found { req } pattern in file content',
        });
      }

      // 3. from '@bascik/bascik' inside fenced blocks containing data-bascik-server or data-bascik-stream
      const fencedBlockRegex = /```(?:html|js|ts|javascript|typescript)?\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = fencedBlockRegex.exec(content)) !== null) {
        const block = match[1];
        if (
          (block.includes('data-bascik-server') || block.includes('data-bascik-stream')) &&
          block.includes("from '@bascik/bascik'")
        ) {
          violations.push({
            file: relativePath,
            type: "Fenced code block imports from '@bascik/bascik'",
            snippet: block.slice(0, 150),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
