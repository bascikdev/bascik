import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import config, { build } from '../bascik.config.ts';

const run = promisify(execFile);
const docsDir = path.resolve(import.meta.dirname, '..');
const script = path.join(docsDir, 'scripts/publish-heading-anchors.ts');
const packageFile = createRequire(import.meta.url).resolve('@zachleat/heading-anchors');

describe('publish-heading-anchors', () => {
  it('is a pre-phase exec step in both the default and build configs', () => {
    for (const [label, effective] of [['default', config], ['build', build]] as const) {
      const step = effective.pipeline?.exec?.find((entry) => entry.script === 'scripts/publish-heading-anchors.ts');
      expect(step, `${label} config publishes the element`).toBeDefined();
      // 'pre' guarantees the file exists before any page that loads it is compiled.
      expect(step?.phase).toBe('pre');
    }
  });

  it('declares the element tag as external so no unresolved-tag warning is printed', () => {
    expect(config.components?.external).toContain('heading-anchors');
  });

  it('copies the package file byte for byte into the output directory', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-heading-anchors-'));
    try {
      await run(process.execPath, [script], { cwd: docsDir, env: { ...process.env, BASCIK_OUT_DIR: out } });
      const [source, published] = await Promise.all([
        fs.readFile(packageFile),
        fs.readFile(path.join(out, 'assets/vendor/heading-anchors.js')),
      ]);
      expect(published.length).toBeGreaterThan(0);
      expect(published.equals(source)).toBe(true);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it('fails clearly instead of writing to a guessed location when run outside the pipeline', async () => {
    const env = { ...process.env };
    delete env.BASCIK_OUT_DIR;
    await expect(run(process.execPath, [script], { cwd: docsDir, env })).rejects.toMatchObject({
      stderr: expect.stringContaining('BASCIK_OUT_DIR is not set'),
    });
  });
});
