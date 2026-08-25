import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('global design tokens & breakpoint CSS variables (styles.css)', () => {
  const cssPath = join(process.cwd(), 'src/css/styles.css');

  it('defines standard responsive breakpoint screen width variables according to 2026 guidelines', async () => {
    const css = await readFile(cssPath, 'utf8');

    // Standard breakpoint values: sm=640px, md=768px, lg=1024px, xl=1280px, 2xl=1536px
    expect(css).toContain('--bp-sm:          640px;');
    expect(css).toContain('--bp-md:          768px;');
    expect(css).toContain('--bp-lg:          1024px;');
    expect(css).toContain('--bp-xl:          1280px;');
    expect(css).toContain('--bp-2xl:         1536px;');

    expect(css).toContain('--screen-sm:      640px;');
    expect(css).toContain('--screen-md:      768px;');
    expect(css).toContain('--screen-lg:      1024px;');
    expect(css).toContain('--screen-xl:      1280px;');
    expect(css).toContain('--screen-2xl:     1536px;');

    expect(css).toContain('--breakpoint-sm:  640px;');
    expect(css).toContain('--breakpoint-md:  768px;');
    expect(css).toContain('--breakpoint-lg:  1024px;');
    expect(css).toContain('--breakpoint-xl:  1280px;');
    expect(css).toContain('--breakpoint-2xl: 1536px;');
  });
});
