import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('code-block component', () => {
  const componentPath = join(process.cwd(), 'src/components/code-block/code-block.html');
  const cssPath = join(process.cwd(), 'src/components/code-block/code-block.css');

  it('renders language and file props, default slot, and inline syntax highlighter', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('data-bascik-prop-lang');
    expect(html).toContain('data-bascik-prop-file');
    expect(html).toContain('data-bascik-slot');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('function highlight(');
  });

  it('contains sr-only / cblock-status styles for screen reader announcements', async () => {
    const css = await readFile(cssPath, 'utf8');

    expect(css).toContain('.cblock-status');
    expect(css).toContain('clip: rect(0, 0, 0, 0);');
  });
});
