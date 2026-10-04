import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml } from '../src/lib/escape.ts';
import { absoluteUrls } from '../src/lib/html.ts';
import { loadSnapshot, postPath } from '../src/lib/model.ts';
import { siteOrigin } from '../src/lib/render.ts';

// RSS 2.0 feed of the ten newest posts at /feed.xml. WordPress serves its feed at /feed/; a
// static host cannot serve XML at a directory URL without its own configuration, so the old
// address needs a redirect on the host (see the README).

const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error('BASCIK_OUT_DIR is required; run this as a pipeline.exec step.');

const origin = siteOrigin();
if (!origin) {
  // Feed readers need absolute links. Dev without a site URL simply has no feed.
  if (process.env.BASCIK_BUILD === '1') throw new Error('Set BASCIK_SITE_URL (or --site-url) so the feed has absolute links.');
  console.log('feed: skipped, no site URL');
} else {
  const snapshot = await loadSnapshot();
  // Times are the site's local time; this port assumes the WordPress timezone is UTC (README).
  const rfc822 = (date: string) => new Date(`${date}Z`).toUTCString();
  const items = snapshot.posts.slice(0, 10).map((post) => {
    const link = origin + postPath(post);
    const categories = [...post.categories, ...post.tags]
      .map((term) => `<category>${escapeHtml(term.name)}</category>`).join('');
    return `<item><title>${escapeHtml(post.title)}</title><link>${escapeHtml(link)}</link>` +
      `<guid isPermaLink="true">${escapeHtml(link)}</guid><pubDate>${rfc822(post.date)}</pubDate>` +
      `${categories}<description>${escapeHtml(post.excerpt)}</description>` +
      `<content:encoded><![CDATA[${absoluteUrls(post.html, origin).replaceAll(']]>', ']]]]><![CDATA[>')}]]></content:encoded></item>`;
  });
  const updated = snapshot.posts[0] ? rfc822(snapshot.posts[0].date) : new Date(0).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>${escapeHtml(snapshot.site.name)}</title><link>${escapeHtml(origin)}/</link>` +
    `<atom:link href="${escapeHtml(origin)}/feed.xml" rel="self" type="application/rss+xml"/>` +
    `<description>${escapeHtml(snapshot.site.description)}</description><lastBuildDate>${updated}</lastBuildDate><language>en-US</language>
${items.join('\n')}
</channel></rss>
`;
  await writeFile(join(outDirectory, 'feed.xml'), xml);
  console.log(`feed: ${items.length} items`);
}
