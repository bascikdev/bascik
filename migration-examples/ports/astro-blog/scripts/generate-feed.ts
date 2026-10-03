import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Feed } from 'feed';
import { getPosts } from '../src/lib/posts.ts';
import { SITE_DESCRIPTION, SITE_TITLE, siteOrigin } from '../src/lib/site.ts';

// Equivalent of the upstream src/pages/rss.xml.js endpoint. Bascik pages are HTML-only, so the
// feed is a post-build exec script that writes straight into the output directory.
const origin = siteOrigin();
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required');

const feed = new Feed({
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  id: `${origin}/`,
  link: `${origin}/`,
  copyright: '',
});

// Collection order (file name), matching the upstream endpoint, which does not sort by date.
for (const post of await getPosts()) {
  const link = `${origin}/blog/${post.id}/`;
  feed.addItem({
    title: post.data.title,
    id: link,
    link,
    description: post.data.description,
    date: post.data.pubDate,
  });
}

await mkdir(outDirectory, { recursive: true });
await writeFile(join(outDirectory, 'rss.xml'), feed.rss2());
console.log(`wrote rss.xml (${(await getPosts()).length} items)`);
