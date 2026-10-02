import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-sidebar component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-sidebar/docs-sidebar.html');

  it('renders sidebar navigation build script and preloading script', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<aside class="docs-sidebar-nav" aria-label="Documentation navigation">');
    expect(html).toContain("from '@/lib/nav.ts'");
    expect(html).toContain('link.rel = \'prefetch\'');
  });

  it('renders an "On this page" table of contents from the page Markdown', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<nav class="docs-toc" aria-label="On this page" hidden>');
    expect(html).toContain('<script data-bascik-build="page">');
    expect(html).toContain('renderPageTableOfContents');
  });
});
