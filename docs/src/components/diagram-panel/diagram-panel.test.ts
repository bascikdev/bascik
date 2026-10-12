import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('diagram-panel component', () => {
  const dir = join(process.cwd(), 'src/components/diagram-panel');

  it('hides its decorative arrow from assistive technology', async () => {
    const html = await readFile(join(dir, 'diagram-panel.html'), 'utf8');

    expect(html).toContain('<span class="panel-arrow" aria-hidden="true" data-bascik-prop-arrow>');
    expect(html).toContain('data-bascik-prop-label');
    expect(html).toContain('data-bascik-slot');
  });

  it('hides the label and arrow when their props are not set', async () => {
    const css = await readFile(join(dir, 'diagram-panel.css'), 'utf8');

    expect(css).toContain('.panel-label:empty');
    expect(css).toContain('.panel-arrow:empty');
  });
});
