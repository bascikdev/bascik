import { escapeHtml } from './escape.ts';
import type { Page, Post, Snapshot, Term } from './model.ts';
import { listingPath, pageCount, pageOf, pagePath, postPath, termPath } from './model.ts';

// Markup for the pages. Everything WordPress templates did with the Loop, template tags, and
// pagination blocks happens here, in plain functions called by build scripts. Titles and names
// are plain text and are escaped; bodies were sanitized when the snapshot was written.

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** `March 15, 2026`, the WordPress default date format (`F j, Y`). */
export function readableDate(date: string): string {
  return dateFormat.format(new Date(`${date}Z`));
}

/** Absolute origin for canonical and feed URLs, when one is configured. */
export function siteOrigin(): string | undefined {
  const value = process.env.BASCIK_SITE_URL;
  return value ? new URL(value).origin : undefined;
}

export interface HeadOptions { title: string; description?: string; path: string; noindex?: boolean }

/** `<title>`, description, canonical, and the feed link. WordPress prints these from `wp_head()`. */
export function renderHead(snapshot: Snapshot, { title, description, path, noindex }: HeadOptions): string {
  const origin = siteOrigin();
  return [
    `<title>${escapeHtml(title)}</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    origin && !noindex ? `<link rel="canonical" href="${escapeHtml(origin + path)}">` : '',
    noindex ? '<meta name="robots" content="noindex">' : '',
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(snapshot.site.name)} &raquo; Feed" href="/feed.xml">`,
  ].filter(Boolean).join('\n');
}

/** `Raised beds, year two – Fieldwork Journal`, the WordPress document title format. */
export function documentTitle(snapshot: Snapshot, title?: string, page = 1): string {
  const name = snapshot.site.name;
  if (!title) {
    const parts = [name, page > 1 ? `Page ${page}` : '', snapshot.site.description].filter(Boolean);
    return parts.join(' – ');
  }
  return [title, page > 1 ? `Page ${page}` : '', name].filter(Boolean).join(' – ');
}

/** Top-level pages, then their children, in menu order. This is the theme's page list menu. */
export function navigation(snapshot: Snapshot, here: string): string {
  const byOrder = (a: Page, b: Page) => a.order - b.order || a.title.localeCompare(b.title);
  const link = (item: Page) => {
    const href = pagePath(item);
    const current = href === here ? ' aria-current="page"' : '';
    return `<a href="${escapeHtml(href)}"${current}>${escapeHtml(item.title)}</a>`;
  };
  const items = snapshot.pages.filter((item) => !item.parent).sort(byOrder).map((item) => {
    const children = snapshot.pages.filter((child) => child.parent === item.slug).sort(byOrder);
    const submenu = children.length ? `<ul>${children.map((child) => `<li>${link(child)}</li>`).join('')}</ul>` : '';
    return `<li>${link(item)}${submenu}</li>`;
  });
  return `<ul class="menu" data-testid="site-menu">${items.join('')}</ul>`;
}

function termLinks(terms: Term[], taxonomy: 'category' | 'tag', separator: string): string {
  return terms.map((entry) => `<a href="${termPath(taxonomy, entry.slug)}" rel="tag">${escapeHtml(entry.name)}</a>`).join(separator);
}

function picture(post: Post, sizes: string, eager: boolean): string {
  const image = post.featured;
  if (!image) return '';
  const srcset = image.srcset ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(sizes)}"` : '';
  const loading = eager ? ' fetchpriority="high"' : ' loading="lazy"';
  return `<img src="${escapeHtml(image.src)}"${srcset} width="${image.width}" height="${image.height}" alt="${escapeHtml(image.alt)}" decoding="async"${loading}>`;
}

/** One entry in a listing. The theme's query loop shows image, title, full content, and date. */
function listItem(post: Post, eager: boolean): string {
  const href = postPath(post);
  const image = post.featured
    ? `<a class="entry-image" href="${href}" tabindex="-1" aria-hidden="true">${picture(post, '(max-width: 48rem) 100vw, 48rem', eager)}</a>`
    : '';
  return `<li class="entry" data-testid="post-list-item">
${image}
<h2 class="entry-title"><a href="${href}">${escapeHtml(post.title)}</a></h2>
<div class="entry-content">${post.html}</div>
<p class="entry-date"><a href="${href}"><time datetime="${post.date}">${readableDate(post.date)}</time></a></p>
</li>`;
}

/** Previous, numbered, and next links, as the Query Pagination block prints them. */
function pagination(current: number, total: number, pathOf: (page: number) => string): string {
  if (total < 2) return '';
  const numbers = Array.from({ length: total }, (_, index) => {
    const page = index + 1;
    return page === current
      ? `<span aria-current="page" class="page-numbers current">${page}</span>`
      : `<a class="page-numbers" href="${pathOf(page)}">${page}</a>`;
  }).join(' ');
  const previous = current > 1 ? `<a class="pagination-previous" href="${pathOf(current - 1)}" data-testid="pagination-previous"><span aria-hidden="true">←</span> Previous Page</a>` : '';
  const next = current < total ? `<a class="pagination-next" href="${pathOf(current + 1)}" data-testid="pagination-next">Next Page <span aria-hidden="true">→</span></a>` : '';
  return `<nav class="pagination" aria-label="Pagination" data-testid="pagination">${previous}<span class="page-list">${numbers}</span>${next}</nav>`;
}

export interface ListingOptions { heading: string; intro?: string; posts: Post[]; page: number; pathOf: (page: number) => string }

export function renderListing({ heading, intro, posts, page, pathOf }: ListingOptions): string {
  const items = pageOf(posts, page);
  const list = items.length
    ? `<ul class="post-list" data-testid="post-list">${items.map((item, index) => listItem(item, index === 0)).join('\n')}</ul>`
    : '<p data-testid="no-results">Sorry, but nothing was found.</p>';
  return `<h1 class="page-title" data-testid="page-title">${escapeHtml(heading)}</h1>
${intro ?? ''}
${list}
${pagination(page, pageCount(posts.length), pathOf)}`;
}

export function homeListing(snapshot: Snapshot, page: number): string {
  return renderListing({ heading: 'Blog', posts: snapshot.posts, page, pathOf: listingPath });
}

/** Newer and older neighbors. WordPress calls the older post "previous". */
function neighbors(post: Post, posts: Post[]): string {
  const index = posts.findIndex((item) => item.slug === post.slug && item.date === post.date);
  const older = posts[index + 1];
  const newer = posts[index - 1];
  const link = (item: Post, rel: 'prev' | 'next') => rel === 'prev'
    ? `<div class="nav-previous"><span aria-hidden="true">←</span> <a href="${postPath(item)}" rel="prev" data-testid="post-previous">${escapeHtml(item.title)}</a></div>`
    : `<div class="nav-next"><a href="${postPath(item)}" rel="next" data-testid="post-next">${escapeHtml(item.title)}</a> <span aria-hidden="true">→</span></div>`;
  if (!older && !newer) return '';
  return `<nav class="post-navigation" aria-label="Post navigation">${older ? link(older, 'prev') : '<div></div>'}${newer ? link(newer, 'next') : ''}</nav>`;
}

/** The four newest other posts, as the theme's "More posts" pattern shows them. */
function morePosts(post: Post, posts: Post[]): string {
  const others = posts.filter((item) => item !== post).slice(0, 4);
  if (!others.length) return '';
  const items = others.map((item) => `<li><a href="${postPath(item)}">${escapeHtml(item.title)}</a> <time datetime="${item.date}">${readableDate(item.date)}</time></li>`);
  return `<section class="more-posts" aria-labelledby="more-posts" data-testid="more-posts"><h2 id="more-posts">More posts</h2><ul>${items.join('')}</ul></section>`;
}

export function renderPost(snapshot: Snapshot, post: Post): string {
  const byline = [
    post.author ? `Written by ${escapeHtml(post.author)}` : '',
    post.categories.length ? `in ${termLinks(post.categories, 'category', ', ')}` : '',
  ].filter(Boolean).join(' ');
  return `<article class="post" data-testid="post">
<h1 class="post-title" data-testid="post-title">${escapeHtml(post.title)}</h1>
${post.featured ? `<figure class="featured-image">${picture(post, '(max-width: 48rem) 100vw, 48rem', true)}</figure>` : ''}
<p class="byline" data-testid="post-byline">${byline}${byline ? ' · ' : ''}<time datetime="${post.date}">${readableDate(post.date)}</time></p>
<div class="entry-content" data-testid="post-content">${post.html}</div>
${post.tags.length ? `<p class="post-tags" data-testid="post-tags">${termLinks(post.tags, 'tag', ' ')}</p>` : ''}
</article>
${neighbors(post, snapshot.posts)}
${morePosts(post, snapshot.posts)}`;
}

export function renderPage(page: Page): string {
  return `<article class="page" data-testid="page">
<h1 class="post-title" data-testid="post-title">${escapeHtml(page.title)}</h1>
<div class="entry-content" data-testid="post-content">${page.html}</div>
</article>`;
}

export function findPost(snapshot: Snapshot, params: Record<string, string>): Post {
  const post = snapshot.posts.find((item) => postPath(item) === `/${params.year}/${params.month}/${params.day}/${params.slug}/`);
  if (!post) throw new Error(`No post for ${JSON.stringify(params)}`);
  return post;
}

export function findPage(snapshot: Snapshot, path: string): Page {
  const page = snapshot.pages.find((item) => pagePath(item) === path);
  if (!page) throw new Error(`No page for ${path}`);
  return page;
}
