import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Feed } from 'feed';
import { SITE } from '../src/data/site.ts';
import { absolutizeUrls } from '../src/lib/format.ts';
import { siteOrigin, requireSiteOrigin } from '../src/lib/env.ts';
import { loadPosts, newestFirst } from '../src/lib/posts.ts';
import { renderPostBody } from '../src/lib/render.ts';

// Atom feed of the newest posts, written to /feed/feed.xml after the pages are built. Bascik
// pages are HTML only, so the feed is a post-build exec step that writes straight into dist/.
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step (see bascik.config.ts).');

// Feed readers need absolute URLs. The dev server has no deployment URL, so it skips the feed;
// a production build without one fails instead of publishing relative links.
if (process.env.BASCIK_BUILD !== '1' && !siteOrigin()) {
  console.log('skipped feed: set BASCIK_SITE_URL to generate it in development');
} else {
  const origin = requireSiteOrigin();
  // Link checking uses every post the pages use (drafts included in development), but a draft is
  // never an entry, so a dev feed cannot leak one into a reader.
  const posts = await loadPosts();
  const newest = newestFirst(posts)
    .filter((post) => !post.draft)
    .slice(0, SITE.feedEntries);

  const feed = new Feed({
    title: SITE.title,
    description: SITE.description,
    id: `${origin}/`,
    link: `${origin}/`,
    language: SITE.language,
    copyright: `${new Date().getUTCFullYear()} ${SITE.author.name}`,
    // An empty blog has no entry to take a date from.
    updated: newest[0]?.date ?? new Date(0),
    feedLinks: { atom: `${origin}/feed/feed.xml` },
    author: SITE.author,
  });

  for (const post of newest) {
    const url = `${origin}${post.url}`;
    // Anchors are for readers on the site; a feed reader would show them as stray "#" links.
    const html = renderPostBody(post, posts, { anchors: false });
    feed.addItem({
      title: post.title,
      id: url,
      link: url,
      date: post.date,
      ...(post.description ? { description: post.description } : {}),
      content: absolutizeUrls(html, origin, post.url),
    });
  }

  await mkdir(join(outDirectory, 'feed'), { recursive: true });
  await writeFile(join(outDirectory, 'feed/feed.xml'), feed.atom1());
  console.log(`wrote feed/feed.xml (${newest.length} ${newest.length === 1 ? 'entry' : 'entries'})`);
}
