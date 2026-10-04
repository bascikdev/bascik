import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export function validateManifest(manifest) {
  if (!/^[a-z0-9-]+$/.test(manifest.id) ||
    !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(manifest.repository) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256)) {
    throw new Error('Invalid pinned source manifest');
  }
  if (manifest.licenseMarkers !== undefined &&
    (!Array.isArray(manifest.licenseMarkers) || manifest.licenseMarkers.length === 0 ||
      manifest.licenseMarkers.some((marker) => typeof marker !== 'string' || !marker))) {
    throw new Error('Invalid license markers');
  }
  for (const path of [manifest.subdirectory, manifest.licensePath]) {
    if (typeof path !== 'string' || !path || path.startsWith('/') ||
      path.includes('\\') || path.split('/').includes('..')) {
      throw new Error('Unsafe source path');
    }
  }
  return manifest;
}

export function verifyArchive(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Archive SHA-256 mismatch: ${actual}`);
}

export async function fetchSource(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid source ID');
  const manifest = validateManifest(JSON.parse(await readFile(join(root, 'sources', `${id}.json`), 'utf8')));
  const scratch = await mkdtemp(join(tmpdir(), 'bascik-upstream-'));
  const destination = join(root, '.upstream', id);
  try {
    const archive = join(scratch, 'source.tar.gz');
    const slug = manifest.repository.replace('https://github.com/', '');
    await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '120',
      `https://codeload.github.com/${slug}/tar.gz/${manifest.commit}`, '-o', archive]);
    verifyArchive(await readFile(archive), manifest.archiveSha256);
    const prefix = `${slug.split('/')[1]}-${manifest.commit}`;
    const { stdout } = await execute('tar', ['-tzf', archive], { maxBuffer: 32 * 1024 * 1024 });
    for (const entry of stdout.trim().split('\n')) {
      if (!entry.startsWith(`${prefix}/`) || entry.split('/').includes('..')) {
        throw new Error('Unsafe archive entry');
      }
    }
    // Extract only reviewed source paths and the original notice, never execute them.
    const extracted = join(scratch, 'extracted');
    await mkdir(extracted);
    const members = manifest.subdirectory === '.' ? [prefix] :
      [`${prefix}/${manifest.subdirectory}`, `${prefix}/${manifest.licensePath}`];
    await execute('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1', ...members]);
    const license = await readFile(join(extracted, manifest.licensePath), 'utf8');
    // MIT by default. A manifest for another license lists text its license file must contain.
    const markers = manifest.licenseMarkers ?? ['MIT License', 'Permission is hereby granted'];
    if (!markers.every((marker) => license.includes(marker))) {
      throw new Error(`Expected ${manifest.license} notice missing`);
    }
    await mkdir(dirname(destination), { recursive: true });
    // Refuse to overwrite an existing cache, including any authored lockfile.
    await rename(extracted, destination);
    return join(destination, manifest.subdirectory);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchSource(process.argv[2] ?? '').then(console.log).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}