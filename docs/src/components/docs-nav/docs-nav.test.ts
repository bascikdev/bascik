import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-nav component', () => {
  const componentPath = join(process.cwd(), 'src/components/docs-nav/docs-nav.html');
  const cssPath = join(process.cwd(), 'src/components/docs-nav/docs-nav.css');

  it('renders site navigation, search component, and mobile nav build script', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<a href="#main-content" class="skip-link">Skip to main content</a>');
    expect(html).toContain('<nav class="dnav" aria-label="Main">');
    expect(html).toContain('<docs-logo />');
    expect(html).toContain('<docs-search />');
    expect(html).toContain('scripts/nav.ts');
  });

  it('constrains banner and dnav-inner to max-width 1140px', async () => {
    const css = await readFile(cssPath, 'utf8');

    expect(css).toContain('.dnav-banner {\n  max-width: 1140px;\n  margin: 0 auto;');
    expect(css).toContain('.dnav-inner {\n  max-width: 1140px;\n  margin: 0 auto;');
  });

  it('contains skip-link styles placed off-screen by default in global styles.css', async () => {
    const globalCssPath = join(process.cwd(), 'src/css/styles.css');
    const css = await readFile(globalCssPath, 'utf8');

    expect(css).toContain('.skip-link {');
    expect(css).toContain('top: -100px;');
    expect(css).toContain('.skip-link:focus');
  });
});
