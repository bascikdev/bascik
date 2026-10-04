# Next.js Blog Tutorial

This tutorial walks through a port of the official Next.js `blog-starter` example to Bascik: a home page with a hero post and more stories, one page per post, title and Open Graph metadata, Tailwind CSS, a CSS Module for the post body, and a color scheme switch that remembers your choice. Each section shows the Next.js original, the Bascik replacement, and what is different. It also lists what the port does not reproduce.

## The Original and the Port

| | |
| --- | --- |
| Original | `vercel/next.js`, directory `examples/blog-starter`, commit `ba80ee48fc319735151c3ad6d9bb9a8180c9f09e` (MIT), built with Next.js 16.3.6 |
| Port | `migration-examples/ports/nextjs-blog/` in the Bascik repository |
| Requires | Node 24 or later, `@bascik/bascik` 1.0.0-rc.3 or later |
| Libraries | `gray-matter`, `remark`, `remark-html`, `date-fns`, `zod`, `tailwindcss`, `postcss`, `autoprefixer`, `feed` |

The port's code is adapted from the original under its MIT license, and its notice is kept in `NOTICE.md`. The posts, cover images, avatars, and icons are new. The font is Inter under the SIL Open Font License.

The port was checked side by side with the original in a browser, in production (`next build` and `next start` against `bascik --build` and `bascik --server`) and development (`next dev` against `bascik`): the same routes, titles, social tags, post order, dates, layout at desktop and phone widths, Markdown styles, and color scheme behavior.

## Run the Port

Copy `migration-examples/ports/nextjs-blog/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

The `dev` and `build` scripts pass `--site-url https://example.com`, because Open Graph tags and the feed need an absolute origin. Replace it with your own.

## Project Layout

```text
Next.js (before)                       Bascik (after)
src/app/                               src/pages/
  layout.tsx                             index.html, posts/[slug].html, 404.html
  page.tsx                               index.html
  posts/[slug]/page.tsx                  posts/[slug].html
  globals.css                          src/css/globals.css
  _components/*.tsx                    src/components/<name>/<name>.html
  _components/*.module.css             src/components/<name>/<name>.css
src/lib/api.ts, markdownToHtml.ts      src/lib/api.ts, markdownToHtml.ts
_posts/*.md                            _posts/*.md
public/                                src/pages/assets/, src/pages/favicon/
postcss.config.js                      scripts/build-css.ts (pipeline.exec)
                                       scripts/generate-feed.ts (pipeline.exec)
```

Bascik copies the non-page files under `src/pages/` to `dist/` at the same path, so `public/assets/blog/x.jpg` moves to `src/pages/assets/blog/x.jpg` and keeps its URL.

## Reading the Posts

The original's `src/lib/api.ts` reads `_posts/` with `fs` and `gray-matter`. It works almost unchanged, because a Bascik build script runs in Node. Three edits were needed:

- **Imports between helpers.** The original writes `import { Post } from "@/interfaces/post"`. Bascik resolves `@/` in a script tag, but Node runs the helper file directly, and Node does not read tsconfig `paths`. Inside `src/lib/`, imports are relative and keep their extension: `import type { Post } from "../interfaces/post.ts"`. `import type` matters too: Node strips types without resolving them, so a value import of a type-only module fails at run time.
- **Only Markdown files.** `readdirSync` also returns files such as `.DS_Store`; the port keeps `.md` only.
- **Validation.** The original casts front matter with `as Post`, so a post without a date renders `undefined`. The port checks it with `zod` and fails the build with the file name.

```ts
// src/lib/api.ts (excerpt)
import type { Post } from "../interfaces/post.ts";
import fs from "node:fs";
import matter from "gray-matter";
import { join } from "node:path";
import { z } from "zod";

const frontMatter = z.object({
  title: z.string().min(1),
  excerpt: z.string(),
  coverImage: z.string().startsWith("/"),
  date: z.iso.datetime(),
  author: z.object({ name: z.string().min(1), picture: z.string().startsWith("/") }),
  ogImage: z.object({ url: z.string().startsWith("/") }),
});

export function getPostBySlug(slug: string): Post {
  const realSlug = slug.replace(/\.md$/, "");
  const { data, content } = matter(fs.readFileSync(join(process.cwd(), "_posts", `${realSlug}.md`), "utf8"));
  const parsed = frontMatter.safeParse(data);
  if (!parsed.success) throw new Error(`_posts/${realSlug}.md: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, slug: realSlug, content };
}
```

`markdownToHtml.ts` (remark plus remark-html) is copied unchanged. remark-html sanitizes its output by default.

## Post Pages

`posts/[slug]/page.tsx` has three exports. Each becomes a script in one template, `src/pages/posts/[slug].html`:

| Next.js | Bascik |
| --- | --- |
| `generateStaticParams()` | `<script data-bascik-routes>` that prints `[{ "params": { "slug": "..." } }]` |
| `generateMetadata()` | `<script data-bascik-build>` in `<head>` that prints the title and social tags |
| The page component | `<script data-bascik-build>` in `<body>` that prints the post |

```html
<!-- src/pages/posts/[slug].html (excerpt) -->
<head>
  <script data-bascik-routes>
    import { getAllPosts } from '@/lib/api.ts';
    console.log(JSON.stringify(getAllPosts().map((post) => ({ params: { slug: post.slug } }))));
  </script>
  <site-head></site-head>
  <script data-bascik-build>
    import { getPostBySlug } from '@/lib/api.ts';
    import { SITE_TITLE } from '@/lib/constants.ts';
    import { renderHead } from '@/lib/site.ts';
    const { params } = JSON.parse(process.env.BASCIK_ROUTE);
    const post = getPostBySlug(params.slug);
    console.log(renderHead({ title: `${post.title} | ${SITE_TITLE}`, image: post.ogImage.url }));
  </script>
</head>
```

The file name `[slug].html` gives `/posts/<slug>`, the same URLs as the original. Two behaviors differ:

- **A trailing slash.** Next.js answers `/posts/hello-world/` with a 308 redirect to `/posts/hello-world`. Bascik serves the same page at both.
- **An unknown slug.** The original answers `/posts/no-such-post` with a 500 error, because `getPostBySlug` throws on the missing file before the page reaches `notFound()`. In Bascik only the listed routes exist, so an unknown slug gets the 404 page.

The upstream home page is `src/app/page.tsx`. It becomes `src/pages/index.html` with one build script that prints the hero post and the other stories.

## Components and Helpers

Components that take only text become Bascik components with props. `avatar.tsx` is an example: the name goes in a text prop and the picture in an attribute binding.

```html
<!-- src/components/author-avatar/author-avatar.html -->
<div class="flex items-center">
  <img class="w-12 h-12 rounded-full mr-4" width="48" height="48" data-bascik-attr-src="picture" data-bascik-attr-alt="author">
  <div class="text-xl font-bold" data-bascik-prop-author></div>
</div>
```

Components that take objects or arrays (`HeroPost`, `MoreStories`, `PostPreview`, `CoverImage`, `PostHeader`) become functions in `src/lib/render.ts` that return HTML strings. Props in Bascik are text, so a list of posts cannot be passed to a component. The functions print component tags such as `<author-avatar>` and `<date-formatter>`, and Bascik expands them in its next pass. Every value goes through `escapeHtml`, because a template string does not escape like JSX.

```ts
// src/lib/render.ts (excerpt)
export function renderMoreStories(posts: Post[]): string {
  return `<section>
  <h2 class="mb-8 text-5xl md:text-7xl font-bold tracking-tighter leading-tight">More Stories</h2>
  <div class="grid grid-cols-1 md:grid-cols-2 md:gap-x-16 lg:gap-x-32 gap-y-20 md:gap-y-32 mb-32">
    ${posts.map(renderPostPreview).join("\n")}
  </div>
</section>`;
}
```

`date-formatter.tsx` calls date-fns `format`. The port calls it at build time and passes the label as a prop. Like the original, the label uses the build machine's time zone; set `TZ` when you build if the date must not depend on the machine.

`children` becomes a default slot. `container.tsx` is `<div class="container mx-auto px-5"><div data-bascik-slot></div></div>`.

## Tailwind CSS

The original runs Tailwind through Next.js's PostCSS step (`postcss.config.js` and `@tailwind` directives in `globals.css`). The port runs the same Tailwind 3 configuration as an exec script that writes one stylesheet into the output directory before any page compiles:

```ts
// bascik.config.ts (excerpt)
pipeline: {
  watchPaths: ['_posts/', 'src/lib/'],
  exec: [
    { script: 'scripts/build-css.ts', phase: 'pre', watch: ['src/components/', 'src/pages/', 'src/lib/', 'src/css/', 'tailwind.config.ts'] },
  ],
},
```

```ts
// scripts/build-css.ts (excerpt)
const result = await postcss([tailwindcss('./tailwind.config.ts'), autoprefixer]).process(input, { from, to });
await writeFile(join(process.env.BASCIK_OUT_DIR, 'assets/styles.css'), result.css);
```

`tailwind.config.ts` is copied from the original. Only `content` changes, to the files where the port writes class names: `./src/components/**/*.html`, `./src/pages/**/*.html`, and `./src/lib/**/*.ts`. The head component links `/assets/styles.css`.

No scoping option is needed. Bascik scopes a class only when the component's own stylesheet defines it, so `text-5xl` and `md:grid-cols-2` reach the browser unchanged, and so does the `dark` class the theme script sets on `<html>`.

## The CSS Module

`post-body.tsx` puts the rendered Markdown in a `div` styled by `markdown-styles.module.css`. In the port, `post-body` is a component with a default slot, and the page prints `<post-body>${html}</post-body>`. The module becomes the component's stylesheet, with two changes:

- **`@apply` is written out.** The module uses `@apply text-lg leading-relaxed`. Bascik does not run Tailwind on component stylesheets, so the port writes the CSS those utilities produce (`font-size: 1.125rem; line-height: 1.625`).
- **Element names go in `:is()`.** Bascik scopes `.markdown h2` to `h2` elements written in the component's template, and the headings arrive through the slot. `.markdown :is(h2)` keeps the wrapper scoped and the element name as written, with the same specificity.

```css
/* src/components/post-body/post-body.css (excerpt) */
.markdown {
  font-size: 1.125rem;
  line-height: 1.625;
}

.markdown :is(h2) {
  margin-top: 3rem;
  margin-bottom: 1rem;
  font-size: 1.875rem;
  line-height: 1.375;
}
```

## The Color Scheme Switch

`theme-switcher.tsx` is the example's only client component. It has two halves: an inline `NoFOUCScript` that applies the saved scheme before the page paints, and a React button that cycles system, dark, and light with `useState` and `useEffect`.

The port keeps both halves as two components:

- **`theme-init`** holds the first script and is placed in `<head>` by the head component. Production HTML minification moves scripts in the body to the end of the body, which would apply the saved scheme only after the page painted. Scripts in `<head>` stay where they are.
- **`theme-switcher`** holds the button and a script that writes the next mode to `localStorage`, calls `updateDOM()`, and listens for `storage` events so other tabs follow.

```html
<!-- src/components/theme-switcher/theme-switcher.html (excerpt) -->
<button class="switch" id="switch" type="button"></button>
<script>
  const STORAGE_KEY = "nextjs-blog-starter-theme";
  const modes = ["system", "dark", "light"];
  const button = document.getElementById("switch");
  const current = () => localStorage.getItem(STORAGE_KEY) ?? "system";
  button.addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEY, modes[(modes.indexOf(current()) + 1) % modes.length]);
    window.updateDOM();
  });
</script>
```

`switch.module.css` is copied unchanged as `theme-switcher.css`. Bascik scopes `.switch`, the `--size` custom property, and the `n` keyframes. The port adds a focus ring and an `aria-label`, which the original button lacks.

## Metadata and the Font

The root layout's `metadata` export and each post's `generateMetadata` become one helper, `renderHead()`, that prints the title, description, Open Graph, and Twitter tags. It reads the origin from `BASCIK_SITE_URL` and fails the build without one. The original sets no `metadataBase`, so Next.js prints a warning and writes `http://localhost:<port>` into every `og:image`.

`next/font/google` becomes a self-hosted Inter file, an `@font-face` rule in `globals.css`, and a `<link rel="preload">` in the head component. The home page's `og:image` in the original points at a hosted image service; the port ships its own image.

## Added in the Port

- **A feed.** The original's layout links `/feed.xml`, but nothing generates it, so the link is a 404. The port writes it with a `post` exec script.
- **A sitemap and `robots.txt`.** Bascik generates them at build time from the site URL. The 404 page is left out.
- **A 404 page.** `src/pages/404.html` keeps the site layout and the same text as the Next.js default.

## What the Port Does Not Reproduce

- **Client-side navigation and prefetching.** Links are ordinary page loads. The original ships about 590 kB of JavaScript on the home page; the port ships two short inline scripts.
- **Image optimization.** `next/image` serves resized copies through `/_next/image`. The port serves each cover as authored, with its width and height set.
- **Font fallback metrics.** `next/font` generates an adjusted fallback face to reduce layout shift. The port does not.
- **Preview mode.** The original's alert component has a preview branch that links to `/api/exit-preview`, a route the example does not include, and no post enables it. The port keeps only the default banner.
- **The source link.** The original's banner and footer link to the example on GitHub. The port links to the original example and to these docs.
