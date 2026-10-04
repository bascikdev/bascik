import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Publishes images that live beside a post. A post in content/blog/name/ links
// `./image.png`, and the page refers to it at /blog/name/image.png, so the same relative
// path is recreated under the output directory. Markdown and dotfiles stay behind.
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step.');

const CONTENT = join(process.cwd(), 'content');
const PUBLISHED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

let copied = 0;
for (const entry of await readdir(CONTENT, { recursive: true })) {
  const name = entry.split('/').pop() ?? '';
  if (name.startsWith('.') || !PUBLISHED.has(name.slice(name.lastIndexOf('.')).toLowerCase())) continue;
  const target = join(outDirectory, entry);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(CONTENT, entry), target);
  copied++;
}
console.log(`copied ${copied} content image${copied === 1 ? '' : 's'}`);
