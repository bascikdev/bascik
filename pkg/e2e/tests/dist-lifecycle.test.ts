import { test, expect } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = join(e2eDir, '..');
const entryPath = join(pkgDir, 'dist/index.js');

const runBuild = (cwd: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entryPath, '--build'], {
    cwd,
    env: {
      ...process.env,
      BASCIK_SITE_URL: 'https://example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString('utf8');
  });
  child.stderr?.on('data', (data) => {
    output += data.toString('utf8');
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`Build exited with code ${code}:\n${output}`));
    }
  });
});

test('a fresh build removes output for a deleted source page', async () => {
  const fixtureDir = join(e2eDir, `.dist-lifecycle-${process.pid}-${Date.now()}`);
  const pagesDir = join(fixtureDir, 'src/pages');
  const stalePagePath = join(pagesDir, 'stale.html');
  const staleOutputPath = join(fixtureDir, 'dist/stale.html');

  try {
    await mkdir(pagesDir, { recursive: true });
    await writeFile(join(pagesDir, 'index.html'), '<!doctype html><html><body>home</body></html>');
    await writeFile(stalePagePath, '<!doctype html><html><body>stale</body></html>');

    await runBuild(fixtureDir);
    await expect(readFile(staleOutputPath, 'utf8')).resolves.toContain('stale');

    await rm(stalePagePath);
    await runBuild(fixtureDir);

    await expect(readFile(staleOutputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
