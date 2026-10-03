import type { Post } from './posts.ts';
import { renderMarkdown } from './markdown.ts';
import { escapeHtml, formatDate } from './site.ts';

// Build scripts print HTML and have no prop API (the documented variables are in the environment
// variables reference), so these helpers assemble component tags as strings. Bascik expands the
// emitted component tags in its next pass.

export function formattedDate(date: Date): string {
  const iso = date.toISOString();
  return `<formatted-date data-bascik-prop-iso="${iso}" data-bascik-prop-label="${escapeHtml(formatDate(date))}"></formatted-date>`;
}

export function renderBaseHead({ title, description }: { title: string; description: string }): string {
  return `<base-head data-bascik-prop-title="${escapeHtml(title)}" data-bascik-prop-description="${escapeHtml(description)}"></base-head>`;
}

/** Equivalent of the upstream BlogPost layout, given one post. */
export function renderPost(post: Post): string {
  const { title, pubDate, updatedDate, heroImage } = post.data;
  const hero = heroImage
    ? `<div data-bascik-slot="hero"><img src="${escapeHtml(heroImage)}" alt="" width="1020" height="510" loading="lazy" decoding="async"></div>`
    : '';
  const updated = updatedDate
    ? `<div data-bascik-slot="updated"><div><em>Last updated on ${formattedDate(updatedDate)}</em></div></div>`
    : '';
  return [
    `<post-layout data-bascik-prop-title="${escapeHtml(title)}">`,
    hero,
    `<div data-bascik-slot="date">${formattedDate(pubDate)}</div>`,
    updated,
    renderMarkdown(post.body),
    '</post-layout>',
  ].join('\n');
}

/** One blog index card. Equivalent of the upstream list item in blog/index.astro. */
export function renderPostCard(post: Post): string {
  const { title, pubDate, heroImage } = post.data;
  const image = heroImage
    ? `<img src="${escapeHtml(heroImage)}" alt="" width="720" height="360" loading="lazy" decoding="async">`
    : '';
  return [
    `<li data-testid="post-card"><a href="/blog/${escapeHtml(post.id)}/">`,
    image,
    `<h4 class="title">${escapeHtml(title)}</h4>`,
    `<p class="date">${formattedDate(pubDate)}</p>`,
    '</a></li>',
  ].join('');
}
