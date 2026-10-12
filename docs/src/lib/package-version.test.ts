import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackageVersion, readStableVersion, stableVersion, versionBadge } from './package-version.js';

describe('stableVersion', () => {
  it.each([
    ['1.0.0', '1.0.0'],
    ['1.0.0-rc.6', '1.0.0'],
    ['1.0.0-rc.99', '1.0.0'],
    ['1.2.3-beta.1', '1.2.3'],
    ['1.0.0+build.5', '1.0.0'],
    ['1.0.0-rc.1+build.5', '1.0.0'],
  ])('%s -> %s', (input, expected) => {
    expect(stableVersion(input)).toBe(expected);
  });
});

describe('package version readers', () => {
  let tempDir: string;
  let packageJson: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'package-version-test-'));
    packageJson = join(tempDir, 'package.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads the raw version, keeping the release candidate suffix', async () => {
    await writeFile(packageJson, JSON.stringify({ version: '1.0.0-rc.6' }));
    expect(await readPackageVersion(packageJson)).toBe('1.0.0-rc.6');
  });

  it('reads the stable version, dropping the release candidate suffix', async () => {
    await writeFile(packageJson, JSON.stringify({ version: '1.0.0-rc.6' }));
    expect(await readStableVersion(packageJson)).toBe('1.0.0');
  });

  it('renders the badge text without the release candidate suffix', async () => {
    await writeFile(packageJson, JSON.stringify({ version: '1.0.0-rc.6' }));
    expect(await versionBadge(packageJson)).toBe('v1.0.0');
  });

  it('renders an empty badge instead of a wrong number when the version is unreadable', async () => {
    expect(await versionBadge(join(tempDir, 'missing.json'))).toBe('');
    for (const body of ['{}', '{"version":""}', '{"version":1}', 'not json']) {
      await writeFile(packageJson, body);
      expect(await readPackageVersion(packageJson), body).toBeUndefined();
      expect(await versionBadge(packageJson), body).toBe('');
    }
  });

  it('reads the real workspace package by default', async () => {
    expect(await versionBadge()).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
