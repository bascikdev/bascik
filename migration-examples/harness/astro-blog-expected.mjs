// Behavior expectations for the approved Astro blog pilot (SRC-ASTRO-BLOG @4c1470a).
// Upstream values are facts read from the pinned source. Port values are the original
// content written for the Bascik port. Slugs, dates, and structure are shared.
export const SITE_ORIGIN = 'https://example.com';

const dates = {
  'markdown-style-guide': ['2024-06-19', 'Jun 19, 2024'],
  'using-mdx': ['2024-06-01', 'Jun 1, 2024'],
  'third-post': ['2022-07-22', 'Jul 22, 2022'],
  'second-post': ['2022-07-15', 'Jul 15, 2022'],
  'first-post': ['2022-07-08', 'Jul 8, 2022'],
};

function post(slug, title, description) {
  const [iso, label] = dates[slug];
  return { slug, title, description, iso, label };
}

// Newest first, which is the order the blog index must show.
export const upstream = {
  name: 'upstream',
  siteTitle: 'Astro Blog',
  siteDescription: 'Welcome to my website!',
  about: { title: 'About Me', description: 'Lorem ipsum dolor sit amet', label: 'Aug 8, 2021' },
  posts: [
    post('markdown-style-guide', 'Markdown Style Guide',
      'Here is a sample of some basic Markdown syntax that can be used when writing Markdown content in Astro.'),
    post('using-mdx', 'Using MDX', 'Lorem ipsum dolor sit amet'),
    post('third-post', 'Third post', 'Lorem ipsum dolor sit amet'),
    post('second-post', 'Second post', 'Lorem ipsum dolor sit amet'),
    post('first-post', 'First post', 'Lorem ipsum dolor sit amet'),
  ],
  mdxComponentText: 'Embedded component in MDX',
  homeHeading: /Hello, Astronaut/,
  sitemapPaths: ['/', '/about/', '/blog/', '/blog/first-post/', '/blog/markdown-style-guide/',
    '/blog/second-post/', '/blog/third-post/', '/blog/using-mdx/'],
};

export const port = {
  name: 'port',
  siteTitle: 'Bascik Port Blog',
  siteDescription: 'A Bascik port of the official Astro blog example.',
  about: { title: 'About This Port', description: 'Why this site exists and what it demonstrates.', label: 'Aug 8, 2021' },
  posts: [
    post('markdown-style-guide', 'Markdown Style Guide',
      'A tour of the Markdown features this port renders at build time, from headings to footnotes.'),
    post('using-mdx', 'Components in Markdown',
      'How a Bascik component sits in the middle of rendered Markdown.'),
    post('third-post', 'Third post', 'The third of three short sample entries.'),
    post('second-post', 'Second post', 'The second of three short sample entries.'),
    post('first-post', 'First post', 'The first of three short sample entries.'),
  ],
  mdxComponentText: 'Embedded component in Markdown',
  homeHeading: /Hello, Bascik/,
  sitemapPaths: upstream.sitemapPaths,
};
