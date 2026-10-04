// Behavior expectations for the approved Eleventy base blog (SRC-11TY-BASE-BLOG @94bd3b7) and its
// Bascik port. Upstream values are read from the pinned source and verified by running it. Port
// values are the original content written for the port. Slugs, dates, tags, and structure are
// shared, so the same checks run against both implementations.
export const SITE_ORIGIN = 'https://example.com';

const longDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${iso}T00:00:00Z`));
const monthYear = (iso) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${iso}T00:00:00Z`));

export const slugify = (value) => value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

function post(slug, title, description, iso, tags, { draft = false } = {}) {
  return {
    slug, url: `/blog/${slug}/`, description, iso, tags, draft,
    title: draft ? `${title} (draft)` : title,
    longDate: longDate(iso), monthYear: monthYear(iso),
  };
}

// Oldest first, the order the pinned source sorts its collection in.
export const upstream = {
  name: 'upstream',
  siteTitle: 'Eleventy Base Blog v9',
  siteDescription: 'I am writing about my experiences as a naval navel-gazer.',
  feedTitle: 'Blog Title',
  footerPattern: /Built with\s+Eleventy/,
  // The pinned layout ships the heading-anchors web component as a module script.
  scripts: 'module-bundle',
  headingAnchors: 'client',
  // The pinned syntax-highlight plugin adds tabindex only to highlighted blocks, so an unmarked
  // block that scrolls sideways cannot be reached from the keyboard. Recorded as an upstream gap.
  unmarkedBlockFocusable: false,
  // `eleventy --serve` answers image requests from a virtual /.11ty/image/ endpoint instead of
  // writing files, so image URLs differ between its dev server and its production build.
  devImageEndpoint: true,
  sitemapInDev: true,
  sitemapHasTagPages: false,
  sitemapHasFeed: true,
  posts: [
    post('firstpost', 'This is my first post.', 'This is a post on My Blog about agile frameworks.', '2018-05-01', ['another tag']),
    post('secondpost', 'This is my second post with a much longer title.', 'This is a post on My Blog about leveraging agile frameworks.', '2018-07-04', ['number 2']),
    post('thirdpost', 'This is my third post.', 'This is a post on My Blog about win-win survival strategies.', '2018-08-24', ['second tag', 'posts with two tags']),
    post('fourthpost', 'This is my fourth post', 'This is a post on My Blog about touchpoints and circling wagons.', '2018-09-30', ['second tag']),
    post('fifthpost', 'This is a fifth post', undefined, '2023-01-23', [], { draft: true }),
  ],
  codePosts: { diff: 'firstpost', highlighted: 'thirdpost' },
  imagePost: 'fourthpost',
  linkPost: 'secondpost',
};

export const port = {
  name: 'port',
  siteTitle: 'Harbor Notes',
  siteDescription: 'Short notes from a small coastal workshop.',
  feedTitle: 'Harbor Notes',
  footerPattern: /Built with\s+Bascik/,
  scripts: 'none',
  headingAnchors: 'build-time',
  unmarkedBlockFocusable: true,
  devImageEndpoint: false,
  // Bascik writes sitemap.xml during builds only; its dev server does not serve one.
  sitemapInDev: false,
  sitemapHasTagPages: true,
  sitemapHasFeed: false,
  posts: [
    post('firstpost', 'Mending a rope fender', 'A first note about splicing, and what a small repair teaches about patience.', '2018-05-01', ['another tag']),
    post('secondpost', 'Why the second entry carries a much longer title than the rest', 'A second note about keeping a workshop log that you will actually read.', '2018-07-04', ['number 2']),
    post('thirdpost', 'Measuring a tide table', 'A third note about reading a tide table without trusting it too far.', '2018-08-24', ['second tag', 'posts with two tags']),
    post('fourthpost', 'A lamp at the end of the pier', 'A fourth note about a small light and why it stays lit.', '2018-09-30', ['second tag']),
    post('fifthpost', 'Notes still being written', undefined, '2023-01-23', [], { draft: true }),
  ],
  codePosts: { diff: 'firstpost', highlighted: 'thirdpost' },
  imagePost: 'fourthpost',
  linkPost: 'secondpost',
};

/** Posts a mode publishes, oldest first. Drafts are written by development servers only. */
export const published = (expected, dev) => expected.posts.filter((entry) => dev || !entry.draft);

/** Tag groups for a set of posts, sorted alphabetically. Posts inside a tag are oldest first. */
export function tagGroups(posts) {
  const groups = new Map();
  for (const entry of posts) {
    for (const name of entry.tags) {
      if (!groups.has(name)) groups.set(name, { name, slug: slugify(name), posts: [] });
      groups.get(name).posts.push(entry);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function routesOf(expected, dev) {
  const posts = published(expected, dev);
  return ['/', '/blog/', '/about/', '/tags/', ...posts.map((entry) => entry.url), ...tagGroups(posts).map((tag) => `/tags/${tag.slug}/`)];
}

/** URLs the sitemap must list for this implementation. They differ by design, see CLAIMS. */
export function sitemapPaths(expected, dev) {
  const posts = published(expected, dev);
  const paths = ['/', '/about/', '/blog/', '/tags/', ...posts.map((entry) => entry.url)];
  if (expected.sitemapHasTagPages) paths.push(...tagGroups(posts).map((tag) => `/tags/${tag.slug}/`));
  if (expected.sitemapHasFeed) paths.push('/feed/feed.xml');
  return paths;
}
