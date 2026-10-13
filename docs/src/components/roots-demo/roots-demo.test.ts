import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('roots-demo component', () => {
  const componentPath = join(process.cwd(), 'src/components/roots-demo/roots-demo.html');

  it('has three top-level elements after its style block', async () => {
    const html = await readFile(componentPath, 'utf8');
    const markup = html.slice(html.indexOf('</style>') + '</style>'.length).trim();

    expect(markup.match(/^<(p|div)\b/gm)).toEqual(['<p', '<p', '<div']);
  });

  it('adds no heading, so the live demo leaves the page outline alone', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).not.toMatch(/<h[1-6]\b/);
  });
});
