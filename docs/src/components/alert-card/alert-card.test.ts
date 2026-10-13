import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('alert-card component', () => {
  const componentDir = join(process.cwd(), 'src/components/alert-card');

  it('uses the same class names as plan-card so the scoping demo shows isolation', async () => {
    const html = await readFile(join(componentDir, 'alert-card.html'), 'utf8');
    const css = await readFile(join(componentDir, 'alert-card.css'), 'utf8');

    for (const className of ['card', 'tag', 'title']) {
      expect(html).toContain(`class="${className}"`);
      expect(css).toContain(`.${className} {`);
    }
    expect(css).toMatch(/^p \{/m);
  });
});
