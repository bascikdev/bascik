import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from '../data/site.ts';
import { contentRoot, pagePath, siteOrigin } from './env.ts';
import { escapeHtml, isoDate, plural, readableDate, slugify } from './format.ts';
import { renderMarkdown } from './markdown.ts';
import { describeImage, renderImg } from './images.ts';
import { resolveContentPath } from './content-paths.ts';
import { archiveUrl, paginate, type Page } from './pagination.ts';
import { collectTags, newestFirst, type Post, type TagGroup } from './posts.ts';

// Build scripts print HTML and Bascik has no template language, so these helpers are the
// "templates". Each returns a string that a page prints with console.log. Every interpolated
// value goes through escapeHtml.

const ABOUT_FILE = 'about.md';

/** Page URLs that exist in this build. A Markdown link to any other `.md` file fails the build. */
export const publishedUrls = (posts: readonly Post[]): Set<string> => new Set(['/about/', ...posts.map((post) => post.url)]);

/** Maps a path relative to content/ to the URL it publishes at, or null when it is not a page. */
export function urlForContentFile(posts: readonly Post[]): (relativePath: string) => string | null {
  const byFile = new Map(posts.map((post) => [post.file, post.url]));
  return (relativePath) => (relativePath === ABOUT_FILE ? '/about/' : (byFile.get(relativePath) ?? null));
}

function markdownOptions(file: string, posts: readonly Post[], extra: { reservedIds?: string[]; anchors?: boolean } = {}) {
  return { file, published: publishedUrls(posts), urlForFile: urlForContentFile(posts), ...extra };
}

/** Render a post body as it appears on its page, or in the feed (`anchors: false`). */
export const renderPostBody = (post: Post, posts: readonly Post[], extra: { reservedIds?: string[]; anchors?: boolean } = {}): string =>
  renderMarkdown(post.body, markdownOptions(post.file, posts, extra));

// ── head and metadata ─────────────────────────────────────────────────────────────────────────

export interface HeadMeta {
  /** Page title. The site title is appended unless this is the home page. */
  title?: string;
  description?: string;
  /** Path of a social image under the site root, such as `/blog/welcome/lantern.png`. */
  image?: string;
  type?: 'website' | 'article';
  published?: Date;
  tags?: readonly string[];
  /** Keep the page out of search indexes (the 404 page). Also drops the canonical link. */
  noindex?: boolean;
}

/**
 * The whole `<head>` of a page. It is one function, not a component, because a component cannot
 * take a computed value and `bascik --check` cannot see a component that only a build script
 * prints. Absolute URLs (canonical, Open Graph) need a site URL; without one (normal in
 * development) those tags are left out rather than written as relative URLs.
 */
export function renderHead(meta: HeadMeta = {}): string {
  const origin = siteOrigin();
  const title = meta.title ? `${meta.title} | ${SITE.title}` : SITE.title;
  const description = meta.description || SITE.description;
  const parts: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
    `<link rel="alternate" href="/feed/feed.xml" type="application/atom+xml" title="${escapeHtml(SITE.title)}">`,
  ];
  if (meta.noindex) {
    parts.push('<meta name="robots" content="noindex">');
    return parts.join('\n');
  }
  const url = origin ? `${origin}${pagePath()}` : null;
  const image = origin ? `${origin}${meta.image ?? SITE.socialImage}` : null;
  if (url) parts.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
  parts.push(
    `<meta property="og:site_name" content="${escapeHtml(SITE.title)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.title || SITE.title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="${meta.type ?? 'website'}">`,
  );
  if (url) parts.push(`<meta property="og:url" content="${escapeHtml(url)}">`);
  if (image) {
    parts.push(`<meta property="og:image" content="${escapeHtml(image)}">`, '<meta name="twitter:card" content="summary_large_image">');
  } else {
    parts.push('<meta name="twitter:card" content="summary">');
  }
  if (meta.type === 'article' && meta.published) {
    parts.push(`<meta property="article:published_time" content="${isoDate(meta.published)}">`);
    for (const tag of meta.tags ?? []) parts.push(`<meta property="article:tag" content="${escapeHtml(tag)}">`);
  }
  return parts.join('\n');
}

/** Syntax theme and code-block rules, needed only on pages that can contain code. */
export function renderCodeStyles(): string {
  const theme = readFileSync(join(process.cwd(), 'node_modules/prismjs/themes/prism-okaidia.css'), 'utf8');
  return `<style>${theme}</style>`;
}

// ── lists ─────────────────────────────────────────────────────────────────────────────────────

/** `posts` is shown in the order given (callers pass newest first). Numbering counts down to 1. */
export function renderPostList(posts: readonly Post[], firstNumber = posts.length): string {
  if (posts.length === 0) return '<p>No posts yet.</p>';
  const items = posts.map((post) => {
    const description = post.description ? `<p class="postlist-description">${escapeHtml(post.description)}</p>` : '';
    return [
      '<li class="postlist-item">',
      `<a href="${post.url}" class="postlist-link">${escapeHtml(post.title)}</a>`,
      `<time class="postlist-date" datetime="${isoDate(post.date)}">${escapeHtml(readableDate(post.date, SITE.language))}</time>`,
      description,
      '</li>',
    ].join('');
  });
  return `<ol reversed start="${firstNumber}" class="postlist">\n${items.join('\n')}\n</ol>`;
}

export function renderHome(posts: readonly Post[]): string {
  const latest = newestFirst(posts).slice(0, SITE.homePosts);
  const more = posts.length - latest.length;
  const parts = [
    `<h1 id="latest">${latest.length === 1 ? 'Latest post' : 'Latest posts'}</h1>`,
    renderPostList(latest, posts.length),
  ];
  if (more > 0) parts.push(`<p>${plural(more, 'more post')} in <a href="/blog/">the archive</a>.</p>`);
  return parts.join('\n');
}

/** Previous/next links between archive pages. Empty when there is only one page. */
export function renderPager(page: Page<unknown>): string {
  if (page.pages <= 1) return '';
  const previous = page.page > 1 ? `<a href="${archiveUrl(page.page - 1)}" rel="prev">\u2190 Newer posts</a>` : '<span aria-hidden="true"></span>';
  const next = page.page < page.pages ? `<a href="${archiveUrl(page.page + 1)}" rel="next">Older posts \u2192</a>` : '<span aria-hidden="true"></span>';
  return `<nav class="pager" aria-label="Archive pages">${previous}<span class="pager-status">Page ${page.page} of ${page.pages}</span>${next}</nav>`;
}

/** One archive page. `pageNumber` 1 is /blog/. */
export function renderArchive(posts: readonly Post[], pageNumber: number): string {
  const ordered = newestFirst(posts);
  const page = paginate(ordered, SITE.postsPerPage, pageNumber);
  const heading = page.page === 1 ? 'Archive' : `Archive, page ${page.page}`;
  const firstNumber = ordered.length - (page.page - 1) * SITE.postsPerPage;
  return [`<h1 id="archive">${heading}</h1>`, renderPostList(page.items, firstNumber), renderPager(page)].filter(Boolean).join('\n');
}

export function renderTagsIndex(posts: readonly Post[]): string {
  const tags = collectTags(posts);
  if (tags.length === 0) return '<h1 id="tags">Tags</h1>\n<p>No tags yet.</p>';
  const items = tags.map(
    (tag) => `<li><a href="/tags/${tag.slug}/" class="post-tag">${escapeHtml(tag.name)}</a> <span class="tag-count">(${tag.posts.length})</span></li>`,
  );
  return `<h1 id="tags">Tags</h1>\n<ul class="taglist">\n${items.join('\n')}\n</ul>`;
}

export function renderTagPage(group: TagGroup): string {
  const heading = `Tagged \u201c${group.name}\u201d`;
  return [
    `<h1 id="${slugify(heading)}">${escapeHtml(heading)}</h1>`,
    renderPostList(newestFirst(group.posts)),
    '<p>See <a href="/tags/">all tags</a>.</p>',
  ].join('\n');
}

// ── posts and pages ───────────────────────────────────────────────────────────────────────────

/** The post's hero image (front matter `image`), or an empty string. */
function heroImage(post: Post): string {
  if (!post.image) return '';
  const root = contentRoot();
  const found = resolveContentPath(`/${post.image}`, post.file, root);
  if (!found) throw new Error(`content/${post.file}: image "${post.image}" does not exist`);
  return `<div class="hero">${renderImg(describeImage(found, root), post.imageAlt, { eager: true })}</div>`;
}

export function renderPost(post: Post, posts: readonly Post[]): string {
  const titleId = slugify(post.title) || 'post';
  const tags = post.tags.map((tag, index) => {
    const separator = index < post.tags.length - 1 ? ', ' : '';
    return `<li><a href="/tags/${slugify(tag)}/" class="post-tag">${escapeHtml(tag)}</a>${separator}</li>`;
  });
  // The title's own id is reserved so a body heading with the same text becomes `title-2`.
  const body = renderPostBody(post, posts, { reservedIds: [titleId] });
  const index = posts.findIndex((entry) => entry.url === post.url);
  const previous = posts[index - 1];
  const next = posts[index + 1];
  const links: string[] = [];
  if (previous) links.push(`<li class="links-nextprev-prev">\u2190 Previous<br><a href="${previous.url}" rel="prev">${escapeHtml(previous.title)}</a></li>`);
  if (next) links.push(`<li class="links-nextprev-next">Next \u2192<br><a href="${next.url}" rel="next">${escapeHtml(next.title)}</a></li>`);
  return [
    `<h1 id="${titleId}">${escapeHtml(post.title)}</h1>`,
    '<ul class="post-metadata">',
    `<li><time datetime="${isoDate(post.date)}">${escapeHtml(readableDate(post.date, SITE.language))}</time></li>`,
    ...tags,
    '</ul>',
    heroImage(post),
    body,
    links.length ? `<ul class="links-nextprev">${links.join('')}</ul>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Render content/about.md. */
export function renderAbout(posts: readonly Post[]): string {
  const source = readFileSync(join(contentRoot(), ABOUT_FILE), 'utf8');
  return renderMarkdown(source, markdownOptions(ABOUT_FILE, posts));
}

/** The first `# heading` of a Markdown page, used as its document title. */
export function aboutTitle(): string {
  const source = readFileSync(join(contentRoot(), ABOUT_FILE), 'utf8');
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(source);
  return match?.[1] ?? 'About';
}
