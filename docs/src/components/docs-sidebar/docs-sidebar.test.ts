import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-sidebar component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-sidebar/docs-sidebar.html');

  it('renders sidebar navigation build script and preloading script', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<aside class="docs-sidebar" aria-label="Documentation navigation">');
    expect(html).toContain('scripts/nav.ts');
    expect(html).toContain('link.rel = \'prefetch\'');
  });
});
