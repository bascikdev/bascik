import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Feed } from 'feed';
import { loadPosts } from '../src/lib/posts.ts';
import { absolutizeForFeed, renderMarkdown } from '../src/lib/markdown.ts';
import { publishedUrls } from '../src/lib/render.ts';
import { SITE, siteOrigin } from '../src/lib/site.ts';

// Equivalent of `@11ty/eleventy-plugin-rss` `feedPlugin` (Atom, newest 10 entries). Bascik pages
// are HTML only, so the feed is written straight into the output directory by a post-build
// script. Upstream also links an XSL stylesheet that makes the feed readable in a browser;
// this port does not ship one.
const origin = siteOrigin();
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step.');

const posts = await loadPosts();
const published = publishedUrls(posts);
const newest = [...posts].reverse().slice(0, 10);

const feed = new Feed({
  title: SITE.title,
  description: SITE.description,
  id: `${origin}/`,
  link: `${origin}/`,
  language: SITE.language,
  copyright: '',
  // An empty blog has no entry to take a date from. Eleventy's feed plugin uses the build time.
  updated: newest.length ? newest[0].date : new Date(),
  feedLinks: { atom: `${origin}/feed/feed.xml` },
  author: SITE.author,
});

for (const post of newest) {
  const url = `${origin}${post.url}`;
  // Anchors are for readers on the site. A feed reader would show them as stray "#" links.
  const html = renderMarkdown(post.body, { file: post.file, published, anchors: false });
  feed.addItem({
    title: post.title ?? post.slug,
    id: url,
    link: url,
    date: post.date,
    content: absolutizeForFeed(html, origin, post.url),
  });
}

await mkdir(join(outDirectory, 'feed'), { recursive: true });
await writeFile(join(outDirectory, 'feed/feed.xml'), feed.atom1());
console.log(`wrote feed/feed.xml (${newest.length} entries)`);
