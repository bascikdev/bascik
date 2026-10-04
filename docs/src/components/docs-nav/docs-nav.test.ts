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
    expect(html).toContain("from '@/lib/nav.ts'");
  });

  it('shows the scheduled release date in the notice banner until the release ships', async () => {
    const html = await readFile(componentPath, 'utf8');
    const match = /scheduled to release ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(html);

    // When the banner is removed or reworded after the release, delete this test with it.
    expect(match, 'banner must state a release date').not.toBeNull();
    const releaseDate = new Date(`${match![1]} 23:59:59`);
    expect(Number.isNaN(releaseDate.getTime())).toBe(false);
    expect(releaseDate.getTime(), 'release date in the banner is in the past; see RELEASING.md').toBeGreaterThan(Date.now());
  });

  it('does not link Sponsor directly from the top navigation', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).not.toContain('<a href="/sponsor">Sponsor</a>');
  });

  it('excludes /sponsor and /press from activating the Docs link', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain("path !== '/sponsor'");
    expect(html).toContain("path !== '/press'");
  });

  it('links Use Cases from the top navigation and keeps Docs from also claiming those pages', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('<li><a href="/use-cases">Use Cases</a></li>');
    expect(html).toContain("href === '/use-cases' && a.closest('.dnav-links')");
    expect(html).toContain('!inUseCases');
  });

  it('constrains banner and dnav-inner to max-width', async () => {
    const css = await readFile(cssPath, 'utf8');

    expect(css).toContain('.dnav-banner {\n  max-width: var(--site-max-width);\n  margin: 0 auto;');
    expect(css).toContain('.dnav-inner {\n  max-width: var(--site-max-width);\n  margin: 0 auto;');
  });

  it('contains skip-link styles placed off-screen by default in global styles.css', async () => {
    const globalCssPath = join(process.cwd(), 'src/css/styles.css');
    const css = await readFile(globalCssPath, 'utf8');

    expect(css).toContain('.skip-link {');
    expect(css).toContain('top: -100px;');
    expect(css).toContain('.skip-link:focus');
  });
});
