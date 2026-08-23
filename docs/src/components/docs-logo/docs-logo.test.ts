import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-logo component', () => {
  const componentPath = join(import.meta.dirname, 'docs-logo.html');

  it('renders vector brand logo SVG with animated cursor and Courier New glyph path', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('class="dlogo"');
    expect(html).toContain('<svg');
    expect(html).toContain('<polygon points="7,0 114,0 107,28 0,28"');
    expect(html).toContain('<animate attributeName="opacity"');
    expect(html).toContain('<path fill="#0e0f10"');
    expect(html).toContain('stroke="#0e0f10"');
  });
});
