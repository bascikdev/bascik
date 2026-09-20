import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('component-demo component', () => {
  const componentPath = join(import.meta.dirname, 'component-demo.html');

  it('uses CSS :has() for tab switching and contains no client-side <script>', async () => {
    const html = await readFile(componentPath, 'utf8');

    // 1. Should render radio inputs for tabs
    expect(html).toContain('type="radio"');
    expect(html).toContain('value="preview"');
    expect(html).toContain('value="code"');
    expect(html).toContain('value="output"');

    // 2. Should use CSS :has() for state-driven styling and pane visibility
    expect(html).toContain(':has(');
    expect(html).toContain('.demo-tab-radio');

    // 3. Should not contain any client runtime <script> tag
    const clientScriptRegex = /<script(?![^>]*data-bascik-build)[^>]*>[\s\S]*?<\/script>/gi;
    expect(clientScriptRegex.test(html)).toBe(false);
  });

  it('supports no-preview prop marker and CSS rules for hiding preview tab', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('data-bascik-prop-no-preview');
    expect(html).toContain('data-bascik-prop-hide-preview');
    expect(html).toContain('.demo-no-preview-marker:not(:empty)');
  });
});
