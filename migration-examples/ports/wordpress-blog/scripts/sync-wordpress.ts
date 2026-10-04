import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { snapshotFromMarkdown } from '../src/lib/markdown.ts';
import { snapshotFromRest } from '../src/lib/rest.ts';
import { SNAPSHOT_PATH } from '../src/lib/model.ts';
import { validateSnapshot } from '../src/lib/schema.ts';

// A `pre` exec step: gathers all content once, before any page compiles, so pages never fetch.
//
//   WORDPRESS_URL set    read the live site through its REST API and download its media
//   WORDPRESS_URL unset  read Markdown converted from a WordPress export in content/
//
// The result is one validated JSON snapshot that every page reads. Media files are written
// straight into the output directory (the exec-script output rule).

const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step.');

const origin = process.env.WORDPRESS_URL?.trim();
const snapshot = origin
  ? await snapshotFromRest(origin, outDirectory)
  : await snapshotFromMarkdown({
    root: join(process.cwd(), 'content'),
    outDirectory,
    // Drafts appear in dev (`bascik`) and are left out of `bascik --build`.
    includeDrafts: process.env.BASCIK_BUILD !== '1',
  });

const target = join(process.cwd(), SNAPSHOT_PATH);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(validateSnapshot(snapshot)));
console.log(`wordpress: ${snapshot.posts.length} posts, ${snapshot.pages.length} pages from ${origin ? new URL(origin).origin : 'content/'}`);
