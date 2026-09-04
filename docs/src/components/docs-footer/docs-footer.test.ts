import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-footer component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-footer/docs-footer.html');
  const cssPath = join(process.cwd(), 'src/components/docs-footer/docs-footer.css');

  it('renders footer sitemap build script, logo, and copyright year script', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<footer class="dfooter">');
    expect(html).toContain('<docs-logo />');
    expect(html).toContain('data-bascik-build');
    expect(html).toContain("from '@/lib/nav.ts'");
  });

  it('uses standard breakpoint media query max-width 640px for mobile in footer CSS', async () => {
    const css = await readFile(cssPath, 'utf8');

    expect(css).toContain('@media (max-width: 640px)');
    expect(css).not.toContain('@media (max-width: 768px)');
  });
});
