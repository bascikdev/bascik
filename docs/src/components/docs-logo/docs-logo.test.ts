import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-logo component', () => {
  const componentPath = join(import.meta.dirname, 'docs-logo.html');
  const svgPath = join(import.meta.dirname, '../../pages/assets/bascik-logo.svg');

  it('renders vector brand logo SVG with animated cursor and Courier New glyph path via build script', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('.dlogo');
    expect(html).toContain('data-bascik-build');
    expect(html).toContain('bascik-logo.svg');

    const svg = await readFile(svgPath, 'utf8');
    expect(svg).toContain('<polygon points="7,0 114,0 107,28 0,28"');
    expect(svg).toContain('<animate attributeName="opacity"');
    expect(svg).toContain('<path fill="#0e0f10"');
    expect(svg).toContain('stroke="#0e0f10"');
  });
});
