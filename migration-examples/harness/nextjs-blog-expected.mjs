// Behavior expectations for the Next.js blog-starter example (SRC-NEXT-BLOG-STARTER @ba80ee4)
// and its Bascik port. Upstream values are facts read from the pinned source and its running
// build. Port values are the original content written for the port. Slugs, order, layout, and
// behavior are shared.
//
// Dates: date-fns `format` uses the build machine's time zone (the upstream date-formatter does
// too), so both lanes run with TZ=UTC and the labels below are UTC calendar days.
export const SITE_ORIGIN = 'https://example.com';
export const TZ = 'UTC';
export const STORAGE_KEY = 'nextjs-blog-starter-theme';

const upstreamPost = (slug, title, author) => ({
  slug, title, author, iso: '2020-03-16T05:35:07.322Z', label: 'March 16, 2020',
});

export const upstream = {
  name: 'upstream',
  siteTitle: 'Next.js Blog Example with Markdown',
  siteDescription: 'A statically generated blog example using Next.js and Markdown.',
  // All three upstream posts share one date. Their order then comes from the file listing.
  posts: [
    upstreamPost('dynamic-routing', 'Dynamic Routing and Static Generation', 'JJ Kasper'),
    upstreamPost('hello-world', 'Learn How to Pre-render Pages Using Static Generation with Next.js', 'Tim Neutkens'),
    upstreamPost('preview', 'Preview Mode for Static Generation', 'Joe Haddad'),
  ],
  footerHeading: 'Statically Generated with Next.js.',
  // The example sets no metadataBase, so Next.js prints a warning and resolves social image URLs
  // against http://localhost:<PORT at build time> (3000 by default). Not a deployable origin.
  socialOrigin: /^http:\/\/localhost:\d+$/,
  // Facts recorded from the pinned build, asserted so a change in either side is noticed.
  unknownPostStatus: 500, // getPostBySlug throws ENOENT before notFound() runs
  trailingSlash: 'redirect', // /posts/x/ answers 308 to /posts/x
  feedStatus: 404, // the layout links /feed.xml, but nothing generates it
  sitemapStatus: 404,
};

const portPost = (slug, title, author, iso, label) => ({ slug, title, author, iso, label });

export const port = {
  name: 'port',
  siteTitle: 'Bascik Blog Example with Markdown',
  siteDescription: 'A statically generated blog example using Bascik and Markdown.',
  posts: [
    portPost('dynamic-routing', 'One Template, Many Pages', 'Ada Brennan', '2024-03-18T09:00:00.000Z', 'March 18, 2024'),
    portPost('hello-world', 'Pages That Are Finished Before Anyone Asks', 'Ravi Okafor', '2024-03-11T09:00:00.000Z', 'March 11, 2024'),
    portPost('preview', 'A Color Scheme Switch Without a Framework', 'Lena Fischer', '2024-03-04T09:00:00.000Z', 'March 4, 2024'),
  ],
  footerHeading: 'Statically Generated with Bascik.',
  socialOrigin: SITE_ORIGIN,
  unknownPostStatus: 404,
  trailingSlash: 'same-page', // Bascik serves /posts/x and /posts/x/ as the same page
  feedStatus: 200,
  sitemapStatus: 200,
  sitemapPaths: ['/', '/posts/dynamic-routing', '/posts/hello-world', '/posts/preview'],
};
