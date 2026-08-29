import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-pagination component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-pagination/docs-pagination.html');

  it('contains documentation comment noting build-time rendering via src/lib/render-nav.ts', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('src/lib/render-nav.ts');
  });
});
