import { format, parseISO } from "date-fns";
import type { Post } from "../interfaces/post.ts";
import markdownToHtml from "./markdownToHtml.ts";
import { escapeHtml } from "./site.ts";

// Build scripts print HTML strings. These helpers replace the JSX components that take data
// (hero-post, post-preview, more-stories, cover-image, post-header). Components that only take
// text (avatar, date) are emitted as Bascik component tags with props, which Bascik expands in
// its next pass. Every interpolated value is escaped.

const e = escapeHtml;

/** date-formatter.tsx: `LLLL d, yyyy` from date-fns, formatted at build time. */
export function dateFormatter(dateString: string): string {
  const label = format(parseISO(dateString), "LLLL d, yyyy");
  return `<date-formatter data-bascik-prop-iso="${e(dateString)}" data-bascik-prop-label="${e(label)}"></date-formatter>`;
}

export function avatar(author: Post["author"]): string {
  return `<author-avatar data-bascik-prop-author="${e(author.name)}" data-bascik-prop-picture="${e(author.picture)}"></author-avatar>`;
}

/** cover-image.tsx. `next/image` becomes a plain img with its intrinsic size; see the README. */
export function coverImage({ title, src, slug }: { title: string; src: string; slug?: string }): string {
  const hover = slug ? " hover:shadow-lg transition-shadow duration-200" : "";
  const image = `<img src="${e(src)}" alt="Cover Image for ${e(title)}" class="shadow-sm w-full${hover}" width="1300" height="630" loading="lazy" decoding="async">`;
  const inner = slug ? `<a href="/posts/${e(slug)}" aria-label="${e(title)}">${image}</a>` : image;
  return `<div class="sm:mx-0">${inner}</div>`;
}

/** hero-post.tsx */
export function renderHeroPost(post: Post): string {
  return `<section data-testid="hero-post">
  <div class="mb-8 md:mb-16">${coverImage({ title: post.title, src: post.coverImage, slug: post.slug })}</div>
  <div class="md:grid md:grid-cols-2 md:gap-x-16 lg:gap-x-8 mb-20 md:mb-28">
    <div>
      <h3 class="mb-4 text-4xl lg:text-5xl leading-tight">
        <a href="/posts/${e(post.slug)}" class="hover:underline">${e(post.title)}</a>
      </h3>
      <div class="mb-4 md:mb-0 text-lg">${dateFormatter(post.date)}</div>
    </div>
    <div>
      <p class="text-lg leading-relaxed mb-4">${e(post.excerpt)}</p>
      ${avatar(post.author)}
    </div>
  </div>
</section>`;
}

/** post-preview.tsx */
export function renderPostPreview(post: Post): string {
  return `<div data-testid="post-preview">
  <div class="mb-5">${coverImage({ title: post.title, src: post.coverImage, slug: post.slug })}</div>
  <h3 class="text-3xl mb-3 leading-snug">
    <a href="/posts/${e(post.slug)}" class="hover:underline">${e(post.title)}</a>
  </h3>
  <div class="text-lg mb-4">${dateFormatter(post.date)}</div>
  <p class="text-lg leading-relaxed mb-4">${e(post.excerpt)}</p>
  ${avatar(post.author)}
</div>`;
}

/** more-stories.tsx. The `posts.map(...)` loop is a plain array map. */
export function renderMoreStories(posts: Post[]): string {
  return `<section data-testid="more-stories">
  <h2 class="mb-8 text-5xl md:text-7xl font-bold tracking-tighter leading-tight">More Stories</h2>
  <div class="grid grid-cols-1 md:grid-cols-2 md:gap-x-16 lg:gap-x-32 gap-y-20 md:gap-y-32 mb-32">
    ${posts.map(renderPostPreview).join("\n")}
  </div>
</section>`;
}

/** posts/[slug]/page.tsx body: post-header.tsx plus post-body.tsx. */
export async function renderPost(post: Post): Promise<string> {
  const content = await markdownToHtml(post.content || "");
  return `<article class="mb-32" data-testid="post">
  <h1 class="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tighter leading-tight md:leading-none mb-12 text-center md:text-left">${e(post.title)}</h1>
  <div class="hidden md:block md:mb-12">${avatar(post.author)}</div>
  <div class="mb-8 md:mb-16 sm:mx-0">${coverImage({ title: post.title, src: post.coverImage })}</div>
  <div class="max-w-2xl mx-auto">
    <div class="block md:hidden mb-6">${avatar(post.author)}</div>
    <div class="mb-6 text-lg">${dateFormatter(post.date)}</div>
  </div>
  <post-body>${content}</post-body>
</article>`;
}
