// Task 09: what the seeded WordPress (sources/wordpress-seed/seed.php) publishes, and therefore
// what both the WordPress theme and the Bascik port must serve. Derived from the seed, not from
// either implementation's output. Seven published posts, one draft, two pages, three posts per
// listing page.

export const SITE = { name: 'Fieldwork Journal', description: 'Notes from a small market garden' };
export const PER_PAGE = 3;

/** Newest first, as WordPress lists them. `title` is the plain-text title a visitor reads. */
export const POSTS = [
  { slug: 'harvest-log', date: '2026-07-30', title: 'Harvest log, July', categories: ['projects'], tags: ['tools', 'weather'] },
  { slug: 'seed-saving', date: '2026-06-08', title: 'Saving seed from tomatoes', categories: ['notes'], tags: ['soil'] },
  { slug: 'pasted-embed', date: '2026-05-20', title: 'A pasted embed', categories: ['notes'], tags: [] },
  // Saved as `Tags & <brackets> "quoted"`. WordPress renders the title as HTML (`title.rendered`),
  // so `<brackets>` is an unknown element a browser does not show, and it curls the quotes. The
  // port reads the same rendered title over REST, so it matches. The WXR export carries the raw
  // title, which the converter keeps as text, so the Markdown path shows it as typed (`wxrTitle`).
  { slug: 'ampersands', date: '2026-04-02', title: 'Tags & “quoted”', wxrTitle: 'Tags & <brackets> "quoted"', categories: ['notes'], tags: ['weather'] },
  { slug: 'raised-beds', date: '2026-03-15', title: 'Raised beds, year two', categories: ['notes', 'projects'], tags: ['soil', 'tools'], featured: true },
  { slug: 'tool-shed', date: '2026-02-03', title: 'Rebuilding the tool shed', categories: ['projects'], tags: ['tools'], inlineImage: true },
  { slug: 'first-frost', date: '2026-01-12', title: 'First frost of the season', categories: ['notes'], tags: ['weather'] },
].map((post) => ({ ...post, path: `/${post.date.replaceAll('-', '/')}/${post.slug}/` }));

export const DRAFT = { slug: 'unfinished', title: 'An unfinished draft' };

export const PAGES = [
  { slug: 'about', path: '/about/', title: 'About', text: 'kept by two growers' },
  { slug: 'colophon', path: '/about/colophon/', title: 'Colophon', text: 'written in the WordPress editor', parent: 'about' },
];

export const CATEGORIES = { notes: 'Notes', projects: 'Projects' };
export const TAGS = { soil: 'soil', tools: 'tools', weather: 'weather' };

/** Titles on each listing page, in order. Only terms with posts have an archive. */
export function listings() {
  const pages = (posts, base) => {
    const result = [];
    for (let page = 1; page <= Math.max(1, Math.ceil(posts.length / PER_PAGE)); page++) {
      result.push({
        path: page === 1 ? base : `${base}page/${page}/`,
        page,
        titles: posts.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((post) => post.slug),
      });
    }
    return result;
  };
  const home = pages(POSTS, '/').map((entry) => ({ ...entry, heading: 'Blog' }));
  const terms = [];
  for (const [slug, name] of Object.entries(CATEGORIES)) {
    terms.push(...pages(POSTS.filter((post) => post.categories.includes(slug)), `/category/${slug}/`).map((entry) => ({ ...entry, heading: `Category: ${name}` })));
  }
  for (const [slug, name] of Object.entries(TAGS)) {
    terms.push(...pages(POSTS.filter((post) => post.tags.includes(slug)), `/tag/${slug}/`).map((entry) => ({ ...entry, heading: `Tag: ${name}` })));
  }
  return [...home, ...terms];
}

/** Every HTML route a visitor can reach. */
export function routes() {
  return [...new Set([...listings().map((entry) => entry.path), ...POSTS.map((post) => post.path), ...PAGES.map((page) => page.path)])];
}

export const bySlug = (slug) => POSTS.find((post) => post.slug === slug);
