# Astro Blog Tutorial

This tutorial walks through a port of the official Astro blog starter to Bascik: five posts, a blog index, an about page, an RSS feed, a sitemap, canonical and Open Graph metadata, and an active navigation link. Each section shows the Astro original, the Bascik replacement, and what is different. It also lists what the port does not reproduce.

## The Original and the Port

| | |
| --- | --- |
| Original | `withastro/astro`, directory `examples/blog`, commit `4c1470a7f907fe678ef5e7dceaa972ca83d297da` (MIT) |
| Port | `migration-examples/ports/astro-blog/` in the Bascik repository |
| Requires | Node 24 or later |
| Libraries | `gray-matter`, `marked`, `marked-footnote`, `marked-gfm-heading-id`, `zod`, `feed` |

The port's code is adapted from the original under its MIT license, and its notice is kept in `NOTICE.md`. The posts, images, and icons are new. The fonts are Atkinson Hyperlegible under the SIL Open Font License.

The port was checked side by side with the original in a browser, in production and development modes: the same routes, titles, descriptions, canonical URLs, post order, navigation state, feed entries, mobile layout, and keyboard navigation.

## Run the Port

Copy `migration-examples/ports/astro-blog/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

The `dev` and `build` scripts pass `--site-url https://example.com`, because canonical URLs, Open Graph tags, the feed, and the sitemap all need an absolute origin. Replace it with your own.

## Project Layout

```text
Astro (before)                    Bascik (after)
src/                              src/
  pages/                            pages/
    index.astro                       index.html
    about.astro                       about/index.html
    blog/index.astro                  blog/index.html
    blog/[...slug].astro              blog/[slug]/index.html
    rss.xml.js                      components/
  components/                         base-head/  site-header/  header-link/
    BaseHead.astro                    site-footer/  social-links/
    Header.astro  HeaderLink.astro    formatted-date/  post-layout/  post-list/
    Footer.astro  FormattedDate.astro lib/
  layouts/BlogPost.astro              posts.ts  render.ts  markdown.ts  site.ts
  content/blog/*.md(x)              css/global.css
  content.config.ts               content/blog/*.md
  consts.ts                       scripts/generate-feed.ts
astro.config.mjs                  bascik.config.ts
```

Each `.astro` component becomes a directory under `src/components/` with an `.html` file and, if it had a `<style>` block, a `.css` file. `consts.ts` becomes `src/lib/site.ts`. Posts move from `src/content/blog/` to a top-level `content/blog/`, outside the pages directory.

## The Content Collection

Astro's `getCollection('blog')` and the schema in `content.config.ts` become one helper. It reads the folder, parses front matter with `gray-matter`, and validates it with the same `zod` shape the original declared:

```ts
// src/lib/posts.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

const schema = z.object({
  title: z.string(),
  description: z.string(),
  pubDate: z.coerce.date(),
  updatedDate: z.coerce.date().optional(),
  heroImage: z.string().optional(),
});

const CONTENT_DIRECTORY = join(process.cwd(), 'content/blog');

export async function getPosts() {
  const files = (await readdir(CONTENT_DIRECTORY)).filter((name) => name.endsWith('.md')).sort();
  const posts = [];
  for (const file of files) {
    const parsed = matter(await readFile(join(CONTENT_DIRECTORY, file), 'utf8'));
    const result = schema.safeParse(parsed.data);
    if (!result.success) {
      throw new Error(`Invalid front matter in content/blog/${file}: ${z.prettifyError(result.error)}`);
    }
    posts.push({ id: file.replace(/\.md$/, ''), data: result.data, body: parsed.content });
  }
  return posts;
}
```

Build scripts run with the project root as the working directory, so `process.cwd()` is the project root. An invalid post fails the build and names the file.

## Post Pages

`[...slug].astro` with `getStaticPaths` becomes a dynamic route. The routes script lists the slugs, and each page reads its own slug from `BASCIK_ROUTE`:

```html
<!-- src/pages/blog/[slug]/index.html -->
<head>
  <script data-bascik-routes>
    import { getPosts } from '@/lib/posts.ts';
    console.log(JSON.stringify((await getPosts()).map((post) => ({ params: { slug: post.id } }))));
  </script>
  <script data-bascik-build>
    import { getPost } from '@/lib/posts.ts';
    import { renderBaseHead } from '@/lib/render.ts';
    const { params } = JSON.parse(process.env.BASCIK_ROUTE);
    const { data } = await getPost(params.slug);
    console.log(renderBaseHead({ title: data.title, description: data.description }));
  </script>
</head>
<body>
  <site-header></site-header>
  <script data-bascik-build>
    import { getPost } from '@/lib/posts.ts';
    import { renderPost } from '@/lib/render.ts';
    const { params } = JSON.parse(process.env.BASCIK_ROUTE);
    console.log(renderPost(await getPost(params.slug)));
  </script>
  <site-footer></site-footer>
</body>
```

The directory template produces the same trailing-slash URLs as Astro, such as `/blog/first-post/`, and Bascik lists each one in `sitemap.xml`.

## The BlogPost Layout

`layouts/BlogPost.astro` becomes the `post-layout` component. Astro passed `Date` objects and an image path as props. Bascik props are text only, so `renderPost` passes the title as a prop and fills named slots with the hero image and the dates:

```html
<!-- src/components/post-layout/post-layout.html -->
<main>
  <article>
    <div class="hero-image"><div data-bascik-slot="hero"></div></div>
    <div class="prose">
      <div class="title">
        <div class="date">
          <div data-bascik-slot="date"></div>
          <div data-bascik-slot="updated"></div>
        </div>
        <h1 data-bascik-prop-title></h1>
        <hr>
      </div>
      <div class="prose-content"><div data-bascik-slot></div></div>
    </div>
  </article>
</main>
```

```ts
// src/lib/render.ts (excerpt)
export function renderPost(post: Post): string {
  const { title, pubDate, updatedDate, heroImage } = post.data;
  const hero = heroImage
    ? `<div data-bascik-slot="hero"><img src="${escapeHtml(heroImage)}" alt="" width="1020" height="510"></div>`
    : '';
  const updated = updatedDate
    ? `<div data-bascik-slot="updated"><em>Last updated on ${formattedDate(updatedDate)}</em></div>`
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
```

`FormattedDate.astro` becomes a one-line component. `data-bascik-attr-datetime` binds the ISO string to the `datetime` attribute, and the readable label is a text prop:

```html
<!-- src/components/formatted-date/formatted-date.html -->
<time data-bascik-attr-datetime="iso" data-bascik-prop-label></time>
```

Every value interpolated into these strings goes through `escapeHtml`, so a title containing `<` or `&` cannot break the markup.

## Head Metadata and the Active Link

`BaseHead.astro` used `Astro.url` and `Astro.site`. In Bascik, the `base-head` component reads `BASCIK_PAGE_PATH` and `BASCIK_SITE_URL` through helpers in `src/lib/site.ts`. Because the page path is read only through those helpers, the script must be marked `data-bascik-build="page"` so it runs once per page, not once for the component:

```html
<!-- src/components/base-head/base-head.html (excerpt) -->
<script data-bascik-build="page">
  import { pagePath, siteOrigin } from '@/lib/site.ts';
  const url = `${siteOrigin()}${pagePath()}`;
  console.log(`<link rel="canonical" href="${url}">`);
  console.log(`<meta property="og:url" content="${url}">`);
</script>
<title data-bascik-prop-title></title>
<meta name="description" data-bascik-attr-content="description">
```

`HeaderLink.astro` compared `Astro.url.pathname` with its `href`. The port's `site-header` does the same comparison in a page-aware script and adds `aria-current="page"` to the matching `header-link`.

## Styles

The original's `<style>` blocks moved to paired `.css` files unchanged, including the `nav a` and `h2 a` rules in `Header.astro` and the `ul li *` and `ul li:first-child img` rules on the blog index. They match markup in the same component.

One rule needed a change. In Astro, `nav a` in `Header.astro` also styles the `<a>` that `HeaderLink.astro` renders as its root. In Bascik a component's CSS never reaches a child component's root, so the header puts a class on each `<header-link>` usage tag and its stylesheet targets that class. See [Styling a Child Component from Its Parent](/attribute-inheritance#styling-a-child-component-from-its-parent).

`src/styles/global.css` became `src/css/global.css`, listed in `assets.inlineStyles` so it is inlined into every page head, as the original's import from `BaseHead` did.

## The MDX Post

The original's `using-mdx.mdx` places a component between two sections of prose. The port renames it to `using-mdx.md`, removes the `import` line, and writes the component tag in the same place:

```md
## Example

Here is how a component appears inside a Markdown file.

<header-link href="#" onclick="alert('clicked!'); return false;">Embedded component in Markdown</header-link>

## More Links
```

`marked` passes the tag through as HTML, and Bascik expands it in its next pass, between the two headings. The inline `onclick` runs in the browser as written.

## The RSS Feed

`src/pages/rss.xml.js` with `@astrojs/rss` becomes an exec script that runs after the pages are built and writes straight into the output directory:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: { inlineStyles: ['src/css/global.css'] },
  pipeline: {
    watchPaths: ['content/', 'src/lib/'],
    exec: [{ script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] }],
  },
  scripts: {
    cache: {
      exclude: ['src/components/site-footer/**', 'src/components/post-list/**', 'src/pages/blog/**'],
    },
  },
});
```

```ts
// scripts/generate-feed.ts (excerpt)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Feed } from 'feed';
import { getPosts } from '../src/lib/posts.ts';
import { SITE_DESCRIPTION, SITE_TITLE, siteOrigin } from '../src/lib/site.ts';

const origin = siteOrigin();
const outDirectory = process.env.BASCIK_OUT_DIR;
const feed = new Feed({ title: SITE_TITLE, description: SITE_DESCRIPTION, id: `${origin}/`, link: `${origin}/`, copyright: '' });
for (const post of await getPosts()) {
  const link = `${origin}/blog/${post.id}/`;
  feed.addItem({ title: post.data.title, id: link, link, description: post.data.description, date: post.data.pubDate });
}
await mkdir(outDirectory, { recursive: true });
await writeFile(join(outDirectory, 'rss.xml'), feed.rss2());
```

The cache exclusions are there because those scripts read `content/` or the current year, which Bascik cannot see as imports. Without them, editing a post would not refresh the blog index.

## The Sitemap

`@astrojs/sitemap` is not needed. With a site URL set, `bascik --build` writes `sitemap.xml` and `robots.txt`, including every dynamic route. The sitemap is a single file, not a sitemap index, and it is not served by the development server. See [Sitemap & robots.txt](/sitemap).

## What the Port Does Not Reproduce

- **Image optimization.** `astro:assets` generated resized WebP variants and `srcset`. The port ships the images as authored, with `width` and `height` set.
- **Syntax highlighting.** Code blocks are plain, keyboard-focusable `<pre>` regions. The [Eleventy Blog Tutorial](/switch/eleventy-blog-tutorial#syntax-highlighting) shows build-time highlighting with Prism.
- **Font pipeline.** The fonts are declared with `@font-face` and preloaded by hand. Astro's generated fallback metrics are not reproduced.
- **Feed details.** The feed carries the same items, but `guid` and channel fields come from the `feed` library and differ in detail.
- **Islands.** The original has no `client:*` directives, so this port does not test hydration. Interactive behavior in Bascik is a vanilla `<script>` in a component.

> **Next:** compare the same patterns in a different starter in the [Eleventy Blog Tutorial](/switch/eleventy-blog-tutorial), or return to [From Astro](/switch/from-astro).
