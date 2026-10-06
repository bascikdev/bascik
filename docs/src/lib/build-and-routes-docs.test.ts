import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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

describe('build and routes script docs contract', () => {
  it('ensures all active <script data-bascik-build> examples use default export and do not use console.log as the content return channel', async () => {
    const contentFiles = await getMarkdownFiles(path.join(DOCS_ROOT, 'content'));
    const allFiles = [...contentFiles, path.join(DOCS_ROOT, 'src/pages/assets/SKILL.md')];

    const violations: { file: string; type: string; snippet: string }[] = [];

    const fencedBlockRegex = /```(?:html|js|ts)?\n([\s\S]*?)```/g;
    for (const filePath of allFiles) {
      const relativePath = path.relative(DOCS_ROOT, filePath);
      const content = await readFile(filePath, 'utf8');

      let match: RegExpExecArray | null;
      while ((match = fencedBlockRegex.exec(content)) !== null) {
        const block = match[1];
        if (block.includes('data-bascik-build')) {
          // If the block contains an actual executable script tag with data-bascik-build
          const scriptMatch = /<script\s+data-bascik-build[^>]*>([\s\S]*?)<\/script>/gi.exec(block);
          if (scriptMatch) {
            const scriptBody = scriptMatch[1].trim();
            // Should contain export default
            if (!scriptBody.includes('export default') && !scriptMatch[0].includes('src=')) {
              violations.push({
                file: relativePath,
                type: 'Missing export default in <script data-bascik-build>',
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
          }
        }

        if (block.includes('data-bascik-routes')) {
          const scriptMatch = /<script\s+data-bascik-routes[^>]*>([\s\S]*?)<\/script>/gi.exec(block);
          if (scriptMatch) {
            const scriptBody = scriptMatch[1].trim();
            if (!scriptBody.includes('export default') && !scriptMatch[0].includes('src=')) {
              violations.push({
                file: relativePath,
                type: 'Missing export default in <script data-bascik-routes>',
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
            if (scriptBody.includes('console.log(JSON.stringify')) {
              violations.push({
                file: relativePath,
                type: 'Uses console.log(JSON.stringify) in <script data-bascik-routes>',
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
