// scripts/feed.ts: write dist/feed.xml, an Atom feed of the latest posts. Register it as a post-phase exec script:
//
//   pipeline: { exec: [{ script: 'scripts/feed.ts', phase: 'post', watch: ['content/'] }] }
//
// Exec scripts are plain Node modules, so they import helpers with relative paths (the @/ alias only works inside
// <script> tags). A feed needs absolute URLs: set BASCIK_SITE_URL for builds.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, getPosts } from '../src/lib/posts.ts';

const FEED_TITLE = 'Example Site';
const MAX_ENTRIES = 20;

const outDir = process.env.BASCIK_OUT_DIR ?? 'dist';
const siteUrl = process.env.BASCIK_SITE_URL?.replace(/\/+$/, '');
const base = (process.env.BASCIK_BASE || '/').replace(/\/$/, '');

if (!siteUrl) {
  // The dev server usually has no site URL; skip quietly there, but never ship a feed with relative links.
  if (process.env.BASCIK_BUILD === '1') throw new Error('feed.ts: set BASCIK_SITE_URL so the feed can use absolute URLs');
  console.log('[feed] BASCIK_SITE_URL is not set; skipping feed.xml');
} else {
  const posts = (await getPosts()).slice(0, MAX_ENTRIES);
  const url = (path: string) => `${siteUrl}${base}${path}`;
  const stamp = (date: string) => `${date}T00:00:00Z`;
  const updated = posts.reduce((latest, post) => [post.updated ?? post.date, latest].sort().at(-1)!, '1970-01-01');
  const entries = posts.map(
    (post) => `  <entry>
    <title>${escapeHtml(post.title)}</title>
    <link href="${url(`/blog/${post.slug}/`)}" />
    <id>${url(`/blog/${post.slug}/`)}</id>
    <published>${stamp(post.date)}</published>
    <updated>${stamp(post.updated ?? post.date)}</updated>
    <summary>${escapeHtml(post.description)}</summary>
    <content type="html">${escapeHtml(post.html)}</content>
  </entry>`,
  );
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(FEED_TITLE)}</title>
  <link href="${url('/')}" />
  <link rel="self" href="${url('/feed.xml')}" />
  <id>${url('/')}</id>
  <updated>${stamp(updated)}</updated>
${entries.join('\n')}
</feed>
`;
  await writeFile(join(outDir, 'feed.xml'), xml);
  console.log(`[feed] wrote feed.xml with ${posts.length} entries`);
}
