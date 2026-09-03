// fingerprint-assets.mjs: content-hash renames for copied page assets,
// then rewrites references in the built HTML.
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ASSET_DIR = 'dist/assets/img';
const files = await readdir(ASSET_DIR);

const renames = [];
for (const file of files) {
  const full = join(ASSET_DIR, file);
  const buf = await readFile(full);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const dot = file.lastIndexOf('.');
  const hashed = `${file.slice(0, dot)}.${hash}${file.slice(dot)}`;
  if (hashed !== file) {
    await rename(full, join(ASSET_DIR, hashed));
    renames.push([`/assets/img/${file}`, `/assets/img/${hashed}`]);
  }
}

// Rewrite references in built HTML. String replacement is the fragile
// part: it cannot tell a real reference from prose that happens to
// contain the same path.
for (const [from, to] of renames) {
  const page = await readFile('dist/index.html', 'utf8');
  await writeFile('dist/index.html', page.split(from).join(to));
}
console.log(`fingerprinted ${renames.length} asset(s)`);
