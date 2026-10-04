import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectTags, visibleTags, type Post, type TagGroup } from './posts.ts';
import { renderMarkdown } from './markdown.ts';
import { SITE, contentRoot, escapeHtml, htmlDate, monthYear, readableDate, slugify } from './site.ts';

// Build scripts print HTML and have no template language, so these helpers play the part of
// the upstream Nunjucks layouts and includes. Each one returns a string a page prints.

/** Page-level URLs that exist in this build, for validating links written as `.md` paths. */
export function publishedUrls(posts: Post[]): Set<string> {
  return new Set(['/about/', ...posts.map((post) => post.url)]);
}

/** `<site-head>` carries title and description. Upstream: `{{ title or metadata.title }}`. */
export function renderHead({ title, description }: { title?: string; description?: string }): string {
  return `<site-head data-bascik-prop-title="${escapeHtml(title || SITE.title)}" data-bascik-prop-description="${escapeHtml(description || SITE.description)}"></site-head>`;
}

/** Upstream `_includes/postslist.njk`. `posts` is oldest first and is shown newest first. */
export function renderPostList(posts: Post[], counter = posts.length): string {
  const items = [...posts].reverse().map((post) => {
    const label = post.title ? escapeHtml(post.title) : `<code>${escapeHtml(post.url)}</code>`;
    return [
      '<li class="postlist-item">',
      `<a href="${post.url}" class="postlist-link">${label}</a>`,
      `<time class="postlist-date" datetime="${htmlDate(post.date)}">${monthYear(post.date)}</time>`,
      '</li>',
    ].join('');
  });
  return `<ol reversed class="postlist" style="--postlist-index: ${counter + 1}">\n${items.join('\n')}\n</ol>`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Upstream `content/index.njk`: the latest three posts and a count of the rest. */
export function renderHome(posts: Post[], latest = 3): string {
  const shown = posts.slice(-latest);
  const more = posts.length - latest;
  const parts = [
    `<h1 id="${slugify(`Latest ${plural(shown.length, 'Post')}`)}">Latest ${plural(shown.length, 'Post')}</h1>`,
    renderPostList(shown, posts.length),
  ];
  if (more > 0) {
    parts.push(`<p>${plural(more, 'more post')} can be found in <a href="/blog/">the archive</a>.</p>`);
  }
  return parts.join('\n');
}

/** Upstream `content/blog.njk`. */
export const renderArchive = (posts: Post[]): string =>
  `<h1 id="archive">Archive</h1>\n${renderPostList(posts)}`;

/** Upstream `content/tags.njk`. */
export function renderTagsIndex(posts: Post[]): string {
  const items = collectTags(posts).map((tag) => `<li><a href="/tags/${tag.slug}/" class="post-tag">${escapeHtml(tag.name)}</a></li>`);
  return `<h1 id="tags">Tags</h1>\n\n<ul>\n${items.join('\n')}\n</ul>`;
}

/** Upstream `content/tag-pages.njk`. */
export function renderTagPage(group: TagGroup): string {
  const heading = `Tagged \u201c${group.name}\u201d`;
  return [
    `<h1 id="${slugify(heading)}">${escapeHtml(heading)}</h1>`,
    renderPostList(group.posts),
    '<p>See <a href="/tags/">all tags</a>.</p>',
  ].join('\n');
}

/** Upstream `_includes/layouts/post.njk`: title, metadata, body, previous and next links. */
export function renderPost(post: Post, posts: Post[]): string {
  const title = post.title ?? post.slug;
  const titleId = slugify(title);
  const tags = visibleTags(post).map((tag, index, all) => {
    const separator = index < all.length - 1 ? ', ' : '';
    return `<li><a href="/tags/${slugify(tag)}/" class="post-tag">${escapeHtml(tag)}</a>${separator}</li>`;
  });
  // The title's own id is reserved so a body heading with the same text becomes `title-2`.
  const body = renderMarkdown(post.body, { file: post.file, published: publishedUrls(posts), reservedIds: [titleId] });
  const index = posts.findIndex((entry) => entry.url === post.url);
  const previous = posts[index - 1];
  const next = posts[index + 1];
  const links: string[] = [];
  if (previous) links.push(`<li class="links-nextprev-prev">\u2190 Previous<br> <a href="${previous.url}">${escapeHtml(previous.title ?? previous.slug)}</a></li>`);
  if (next) links.push(`<li class="links-nextprev-next">Next \u2192<br><a href="${next.url}">${escapeHtml(next.title ?? next.slug)}</a></li>`);
  return [
    `<h1 id="${titleId}">${escapeHtml(title)}</h1>`,
    '<ul class="post-metadata">',
    `<li><time datetime="${htmlDate(post.date)}">${readableDate(post.date)}</time></li>`,
    ...tags,
    '</ul>',
    body,
    links.length ? `<ul class="links-nextprev">${links.join('')}</ul>` : '',
  ].join('\n');
}

/** Render a standalone Markdown page such as content/about.md. */
export function renderMarkdownPage(file: string, posts: Post[]): string {
  const source = readFileSync(join(contentRoot(), file), 'utf8');
  return renderMarkdown(source, { file, published: publishedUrls(posts) });
}

/** Styles used only by post pages: Prism's theme and the diff block rules. */
export function renderPostStyles(): string {
  const theme = readFileSync(join(process.cwd(), 'node_modules/prismjs/themes/prism-okaidia.css'), 'utf8');
  const diff = readFileSync(join(process.cwd(), 'src/css/diff.css'), 'utf8');
  return `<style>${theme}\n${diff}</style>`;
}
