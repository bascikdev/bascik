import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import config, { build } from '../bascik.config.ts';

const docsDir = path.resolve(import.meta.dirname, '..');
const authored = path.join(docsDir, 'src/pages/assets/SKILL.md');
const published = path.join(docsDir, 'dist/assets/SKILL.md');

describe('publish-agent-skill', () => {
  it('is wired into both the effective default and build exec arrays without watching its output', () => {
    for (const [label, effective] of [['default', config], ['build', build]] as const) {
      const producer = effective.pipeline?.exec?.find(entry => entry.script === 'scripts/publish-agent-skill.ts');
      expect(producer, `${label} config publishes the skill`).toBeDefined();
      expect(producer).not.toHaveProperty('outputs');
      expect(effective.pipeline?.watchPaths ?? []).not.toContain('dist/assets/SKILL.md');
    }
    const dev = config.pipeline?.exec?.find(entry => entry.script === 'scripts/publish-agent-skill.ts');
    expect(dev?.watch).toEqual(['src/pages/assets/SKILL.md']);
  });

  it('publishes only the authored skill file to dist/assets byte for byte', async () => {
    await fs.rm(published, { force: true });
    await import('./publish-agent-skill.js');
    const [source, output] = await Promise.all([fs.readFile(authored), fs.readFile(published)]);
    expect(output.length).toBeGreaterThan(0);
    expect(output.equals(source)).toBe(true);
  });

  it('does not publish ordinary Markdown sources into the output directory', async () => {
    await import('./publish-agent-skill.js');
    const assets = await fs.readdir(path.join(docsDir, 'dist/assets'));
    expect(assets.filter(name => name.toLowerCase().endsWith('.md'))).toEqual(['SKILL.md']);
    await expect(fs.stat(path.join(docsDir, 'dist/content/getting-started.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(docsDir, 'dist/getting-started.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
