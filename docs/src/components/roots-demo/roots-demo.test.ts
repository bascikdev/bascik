import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('roots-demo component', () => {
  const componentPath = join(process.cwd(), 'src/components/roots-demo/roots-demo.html');

  it('has three top-level elements after its style block', async () => {
    const html = await readFile(componentPath, 'utf8');
    const markup = html.slice(html.indexOf('</style>') + '</style>'.length).trim();

    expect(markup.match(/^<(h2|p|div)\b/gm)).toEqual(['<h2', '<p', '<div']);
  });
});
