import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('scope-lab component', () => {
  const componentPath = join(process.cwd(), 'src/components/scope-lab/scope-lab.html');

  it('renders scope lab section and meter signal element', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('class="scope-lab"');
    expect(html).toContain('class="scope-lab-meter"');
  });
});
