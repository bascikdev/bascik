import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('platform-shift component', () => {
  const componentPath = join(process.cwd(), 'src/components/platform-shift/platform-shift.html');

  it('captions a list of library-to-platform rows ending with the open gap', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<figcaption class="shift-caption">');
    expect(html.match(/class="shift-row[" ]/g)).toHaveLength(4);
    expect(html).toContain('class="shift-row shift-row-open"');
  });

  it('hides the decorative arrows from assistive technology', async () => {
    const html = await readFile(componentPath, 'utf8');
    const arrows = html.match(/<span class="shift-arrow"[^>]*>/g) ?? [];

    expect(arrows).toHaveLength(4);
    for (const arrow of arrows) expect(arrow).toContain('aria-hidden="true"');
  });
});
