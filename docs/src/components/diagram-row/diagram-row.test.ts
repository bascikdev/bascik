import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('diagram-row component', () => {
  const dir = join(process.cwd(), 'src/components/diagram-row');

  it('labels a row and binds the direction prop to a data attribute', async () => {
    const html = await readFile(join(dir, 'diagram-row.html'), 'utf8');

    expect(html).toContain('data-bascik-prop-label');
    expect(html).toContain('data-bascik-attr-data-direction="direction"');
    expect(html).toContain('data-bascik-slot');
  });

  it('stacks on request and on narrow screens', async () => {
    const css = await readFile(join(dir, 'diagram-row.css'), 'utf8');

    expect(css).toContain("[data-direction='stack']");
    expect(css).toContain('@media (max-width: 640px)');
  });
});
