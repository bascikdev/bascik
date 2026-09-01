import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-pagination component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-pagination/docs-pagination.html');

  it('renders pagination at build-time via src/lib/render-nav.ts', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('data-bascik-build');
    expect(html).toContain('src/lib/render-nav.ts');
    expect(html).toContain('renderPagination()');
  });
});
