import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { contentRoot, includeDrafts } from '../src/lib/env.ts';
import { loadPosts } from '../src/lib/posts.ts';
import { toPosix } from '../src/lib/content-paths.ts';

// Publishes images that live beside a post. A post in content/blog/name/ refers to
// `./image.png`, and the page uses /blog/name/image.png, so the same relative path is recreated
// under the output directory. Markdown and dotfiles stay behind, and so do the images of a draft
// post in a production build (a draft's pictures must not be public before its text is).
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step (see bascik.config.ts).');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const root = contentRoot();

// A draft written as content/blog/name/name.md keeps its images in content/blog/name/.
const skippedFolders: string[] = [];
if (!includeDrafts()) {
  for (const post of await loadPosts({ drafts: true })) {
    if (post.draft && post.file === `blog/${post.slug}/${post.slug}.md`) skippedFolders.push(`blog/${post.slug}/`);
  }
}

let copied = 0;
for (const entry of await readdir(root, { recursive: true })) {
  const path = toPosix(entry);
  const name = path.split('/').pop() ?? '';
  if (path.split('/').some((segment) => segment.startsWith('.'))) continue;
  if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
  if (skippedFolders.some((folder) => path.startsWith(folder))) continue;
  const target = join(outDirectory, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, path), target);
  copied++;
}
console.log(`copied ${copied} content image${copied === 1 ? '' : 's'}`);
