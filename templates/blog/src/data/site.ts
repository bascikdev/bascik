// Site settings. Edit this file to rebrand the blog; every page, the feed, and the page
// metadata read from it. The site URL is NOT stored here: it differs per deployment, so
// pass it as BASCIK_SITE_URL (see README.md).

export const SITE = {
  title: 'Lantern Log',
  description: 'Notes from a small workshop by the water.',
  /** BCP 47 tag used for `<html lang>`, the feed, and date formatting. */
  language: 'en',
  author: { name: 'Your Name' },
  /** Posts on each archive page. Page 1 is /blog/, later pages are /blog/page/2/ and so on. */
  postsPerPage: 5,
  /** Posts shown on the home page before the link to the archive. */
  homePosts: 3,
  /** Entries in the Atom feed. */
  feedEntries: 10,
  /** Site-root path of the image used for link previews when a post sets no `image`. */
  socialImage: '/assets/social-card.png',
} as const;

/** Header navigation. `url` is compared with the current page to set aria-current. */
export const NAV: ReadonlyArray<{ title: string; url: string }> = [
  { title: 'Home', url: '/' },
  { title: 'Archive', url: '/blog/' },
  { title: 'Tags', url: '/tags/' },
  { title: 'About', url: '/about/' },
  { title: 'Feed', url: '/feed/feed.xml' },
];
