import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pagesDir = join(process.cwd(), 'src/pages');
const diagramsDir = join(process.cwd(), 'src/diagrams');
const contentDir = join(process.cwd(), 'content');

/** Every code block a diagram panel reads, as `file#marker`, from the page shells. */
function usedBlocks(): Array<{ page: string; file: string; marker: string }> {
  return readdirSync(pagesDir)
    .filter((name) => name.endsWith('.html'))
    .flatMap((name) => {
      const html = readFileSync(join(pagesDir, name), 'utf8');
      return [...html.matchAll(/<diagram-panel\b[\s\S]*?<\/diagram-panel>/g)].flatMap((panel) =>
        [...panel[0].matchAll(/extractDemoBlock\('\.\/([\w/.-]+)', '([\w-]+)'\)/g)].map((call) => ({
          page: name,
          file: call[1],
          marker: call[2],
        })),
      );
    });
}

const markersIn = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/<!--\s*demo:([\w-]+)\s*-->/g)].map((match) => match[1]);

describe('diagram code blocks', () => {
  it('are read from src/diagrams, so page content, search, and llms.txt never carry them', () => {
    for (const { page, file } of usedBlocks()) {
      expect(file, page).toMatch(/^src\/diagrams\/[\w-]+\.md$/);
    }
  });

  it('exist in the file each panel reads', () => {
    for (const { page, file, marker } of usedBlocks()) {
      expect(markersIn(join(process.cwd(), file)), `${page} -> ${file}#${marker}`).toContain(marker);
    }
  });

  it('are each used by a panel, so none is left behind after a diagram changes', () => {
    const used = new Set(usedBlocks().map(({ file, marker }) => `${file}#${marker}`));
    const stale = readdirSync(diagramsDir)
      .filter((name) => name.endsWith('.md'))
      .flatMap((name) => markersIn(join(diagramsDir, name)).map((marker) => `src/diagrams/${name}#${marker}`))
      .filter((key) => !used.has(key));
    expect(stale).toEqual([]);
  });

  it('are never duplicated into the page content', () => {
    const used = new Set(usedBlocks().map(({ marker }) => marker));
    for (const name of readdirSync(contentDir).filter((entry) => entry.endsWith('.md'))) {
      const leaked = markersIn(join(contentDir, name)).filter((marker) => used.has(marker));
      expect(leaked, name).toEqual([]);
    }
  });
});
