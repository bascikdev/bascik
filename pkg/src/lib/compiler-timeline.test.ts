import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerCommand, linkDependencies } from '../../bench/compiler-timeline.ts';

describe('private compiler investigation harness', () => {
  it('keeps fixture cache private while linking dependencies and the selected compiler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bascik-timeline-test-'));
    try {
      const source = join(root, 'original');
      const fixture = join(root, 'fixture');
      await mkdir(join(source, '.cache'), { recursive: true });
      await mkdir(join(source, 'dependency'));
      await writeFile(join(source, '.cache/sentinel'), 'untouched');
      await linkDependencies(source, fixture, join(root, 'compiler'));
      expect((await lstat(join(fixture, 'dependency'))).isSymbolicLink()).toBe(true);
      await expect(lstat(join(fixture, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(fixture, '.cache'));
      expect((await lstat(join(fixture, '.cache'))).isSymbolicLink()).toBe(false);
      await rm(join(fixture, '.cache'), { recursive: true });
      expect(await readFile(join(source, '.cache/sentinel'), 'utf8')).toBe('untouched');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses distinct Clinic Flame and 0x commands with an explicit Node subject', async () => {
    const subject = [process.execPath, '/private/subject.ts', '--build'];
    const flame = await compilerCommand('flame', subject, '/private/profiles');
    expect(flame).toContain('flame');
    expect(flame).toContain('--collect-only');
    expect(flame.slice(flame.indexOf('--') + 1)).toEqual(subject);
    const zero = await compilerCommand('0x', subject, '/private/profiles');
    expect(zero).toContain('--tree-debug');
    expect(zero.slice(zero.indexOf('--') + 1)).toEqual(subject);
  });
});
