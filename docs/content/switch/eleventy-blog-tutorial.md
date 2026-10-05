# Eleventy Blog Tutorial

This tutorial walks through a port of the official Eleventy base blog to Bascik: posts, the archive, tag pages, drafts, previous and next links, an Atom feed, a sitemap, a 404 page, heading anchors, and syntax highlighting. Each section shows what the Eleventy template or plugin did and the Bascik code that replaces it. The port uses no Eleventy packages; the work is done by a few small helpers built on general-purpose libraries.

## The Original and the Port

| | |
| --- | --- |
| Original | `11ty/eleventy-base-blog`, commit `94bd3b71d454da5b88eb505b8db6aea1cd0e9754` (MIT) |
| Port | `migration-examples/ports/eleventy-blog/` in the Bascik repository |
| Requires | Node 24 or later |
| Libraries | `gray-matter`, `marked`, `prismjs`, `zod`, `feed`, `image-size` |

The port's code is adapted from the original under its MIT license, and its notice is kept in `NOTICE.md`. The posts and the image are new.

The port was checked side by side with the original in a browser, in production and development modes: routes, titles, post order, tag pages, feed entries, drafts, navigation state, the skip link, heading anchors, highlighted code, mobile layout, and keyboard navigation. A second suite adds, edits, and removes posts and checks the output and the error messages.

## Run the Port

Copy `migration-examples/ports/eleventy-blog/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
npm run dev      # development server, drafts included
npm run build    # writes dist/, drafts left out
npm run serve    # production server over dist/
```

The `dev` and `build` scripts pass `--site-url https://example.com`, because the feed and the sitemap need an absolute origin. A build without a site URL fails on purpose rather than writing relative feed links. Replace it with your own.

## Project Layout

```text
Eleventy (before)                 Bascik (after)
content/                          content/
  index.njk  about.md  404.md       about.md
  blog.njk  tags.njk                blog/*.md  blog/<name>/<name>.md
  tag-pages.njk  sitemap.xml.njk  src/pages/
  blog/*.md  blog/blog.11tydata.js  index.html  404.html  about/index.html
_includes/                          blog/index.html  blog/[slug]/index.html
  layouts/base.njk                  tags/index.html  tags/[tag]/index.html
  layouts/home.njk  post.njk      src/components/
  postslist.njk                     site-head/  site-header/  site-footer/
_data/metadata.js                 src/lib/
_config/filters.js                  posts.ts  render.ts  markdown.ts
eleventy.config.js                  highlight.ts  site.ts
                                  src/css/global.css  diff.css
                                  scripts/generate-feed.ts
                                  scripts/copy-content-assets.ts
                                  bascik.config.ts
```

Content stays in `content/`. Templates become pages in `src/pages/`, and the Nunjucks logic moves into `src/lib/`.

## Layouts

`base.njk`, `home.njk`, and `post.njk` chained three layouts. In Bascik each page owns its `<html>`, `<head>`, and `<body>`, and the shared parts are components and helpers:

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
<head>
  <script data-bascik-build>
    import { renderHead } from '@/lib/render.ts';
    console.log(renderHead({}));
  </script>
</head>
<body>
  <site-header />
  <main id="main">
    <script data-bascik-build>
      import { loadPosts } from '@/lib/posts.ts';
      import { renderHome } from '@/lib/render.ts';
      console.log(renderHome(await loadPosts()));
    </script>
  </main>
  <site-footer />
</body>
</html>
```

`renderHead` prints `<site-head>` with the title and description as props. The `site-head` component holds the charset, viewport, title, description, and feed link that `base.njk` wrote in every page. A layout component cannot own `<html>` or `<body>` itself; the page would have no body of its own and the build fails.

## Posts as a Collection

Eleventy's `collections.posts`, the `blog.11tydata.js` directory data, and the draft rule become `loadPosts` in `src/lib/posts.ts`. It reads `content/blog/**/*.md`, validates front matter with `zod`, drops drafts from builds, and sorts by date as Eleventy does:

```ts
// src/lib/posts.ts (excerpt)
const frontMatter = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  date: z.coerce.date(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  draft: z.boolean().optional(),
});

export function includeDrafts(): boolean {
  return process.env.BASCIK_BUILD !== '1';
}

// ...for each file: parse, validate, skip `draft: true` unless includeDrafts()...

return posts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.file.localeCompare(b.file));
```

The original validated only `draft`. The port also requires a `date`, because a post without one has no place in the order. A post with a missing date, a non-boolean `draft`, or a URL that another post already uses fails the build and names the file.

`content/blog/name.md` and `content/blog/name/name.md` both become `/blog/name/`. The folder form is where a post keeps its images.

## Post and Tag Pages

Eleventy paginated over collections to make one page per post and per tag. Bascik uses two dynamic routes. The post template lists slugs and renders the post with its neighbors:

```html
<!-- src/pages/blog/[slug]/index.html (excerpt) -->
<script data-bascik-routes>
  import { loadPosts, postRoutes } from '@/lib/posts.ts';
  console.log(JSON.stringify(postRoutes(await loadPosts())));
</script>

<!-- in <main> -->
<script data-bascik-build>
  import { findPost, loadPosts } from '@/lib/posts.ts';
  import { renderPost } from '@/lib/render.ts';
  const { params } = JSON.parse(process.env.BASCIK_ROUTE);
  const posts = await loadPosts();
  console.log(renderPost(findPost(posts, params.slug), posts));
</script>
```

`renderPost` replaces `post.njk` and the `getPreviousCollectionItem` and `getNextCollectionItem` filters: it finds the post's index in the date-ordered list and links the posts on either side. `src/pages/tags/[tag]/index.html` works the same way, with one route per tag from `collectTags`. Two tags that would produce the same URL fail the build.

A route parameter cannot contain `/`. Deeper URLs need a template per depth, such as `src/pages/blog/[year]/[slug]/index.html`.

## Templates and Filters

Nunjucks loops, conditionals, and filters move into `src/lib/render.ts`. The include `postslist.njk` read `postslist` and `postslistCounter` from its caller, so it became a function instead of a component:

```ts
// src/lib/render.ts (excerpt)
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
```

The filters in `_config/filters.js` (`readableDate`, `htmlDateString`, `head`, `min`, `filterTagList`) became plain functions in `src/lib/site.ts` and `posts.ts`. The home page shows the latest three posts and an "N more posts" line, as the original does. These helpers are most of the port's code, which is the honest cost of leaving a template language.

## Navigation and the Skip Link

`@11ty/eleventy-navigation` built the menu from front matter. The port keeps a `NAV` array in `src/lib/site.ts`, and `site-header` prints it from a page-aware script, marking the current entry with `aria-current="page"`:

```html
<!-- src/components/site-header/site-header.html (excerpt) -->
<a href="#main" class="skip-link visually-hidden">Skip to main content</a>
<header>
  <a href="/" class="home-link">Harbor Notes</a>
  <nav>
    <ul class="nav">
      <script data-bascik-build="page">
        import { NAV, pagePath, escapeHtml } from '@/lib/site.ts';
        const here = pagePath();
        console.log(NAV.map((entry) => {
          const current = entry.url === here ? ' aria-current="page"' : '';
          return `<li class="nav-item"><a href="${entry.url}"${current}>${escapeHtml(entry.title)}</a></li>`;
        }).join('\n'));
      </script>
    </ul>
  </nav>
</header>
```

The header has no stylesheet of its own. Its classes (`skip-link`, `nav-item`, `home-link`) are not defined in a component stylesheet, so they stay global and the rules in `src/css/global.css` match them, exactly as the original's global CSS did. The skip link targets `#main`, which each page defines on its own `<main>`.

## Markdown, Heading Anchors, and Syntax Highlighting

The original used markdown-it, `IdAttributePlugin`, the `<heading-anchors>` web component, and `eleventy-plugin-syntaxhighlight`. The port replaces all of them with one render step in `src/lib/markdown.ts`, built on `marked`:

- Headings get unique ids, and `h2` to `h6` get the same `#` anchor links the web component added, written at build time. No script ships to the browser.
- Links written as paths to other Markdown files, such as `./secondpost.md`, become the URL of that page. A link to a missing file, or to a draft in a production build, fails the build.
- Images beside a post get `width` and `height` from `image-size`. A missing image fails the build.

### Syntax highlighting

`src/lib/highlight.ts` runs Prism at build time, including the original's `diff-<language>` blocks, and the post pages inline Prism's Okaidia theme from the `prismjs` package. To keep using a third-party custom element such as `<heading-anchors>` instead, declare it in [`components.external`](/configuration#componentsexternal); see [Third-Party Web Components](/how-to/third-party-web-components).

## The Feed, Images, and the Sitemap

The feed and the post images are exec scripts that write into the output directory:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: { inlineStyles: ['src/css/global.css'] },
  pipeline: {
    watchPaths: ['content/', 'src/lib/'],
    exec: [
      { script: 'scripts/copy-content-assets.ts', phase: 'pre', watch: ['content/'] },
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] },
    ],
  },
  scripts: {
    cache: { exclude: ['src/pages/**', 'src/components/**'] },
  },
});
```

- `copy-content-assets.ts` replaces the image transform's copying. Images under `content/` are outside `src/pages/`, so Bascik does not copy them by itself.
- `generate-feed.ts` replaces `eleventy-plugin-rss`. It writes `feed/feed.xml`, an Atom feed with the newest ten posts, using the `feed` library and the same `loadPosts` list.
- `sitemap.xml.njk` is not needed. `bascik --build` writes `sitemap.xml` and `robots.txt` when a site URL is set. See [Sitemap & robots.txt](/sitemap).

If a feed or copy script fails, `bascik --build` stops with exit code 1, and the development server reports the error and keeps running. See [When a script fails](/exec-scripts#when-a-script-fails).

The cache exclusion and watch paths are needed because the pages read `content/`, which Bascik cannot see as an import.

## The 404 Page

`content/404.md` becomes `src/pages/404.html`. Bascik's production server serves it for unknown routes. Static hosts need their own 404 setting; see [Static Hosting](/deployment/static-hosting).

## What the Port Does Not Reproduce

- **Image variants.** The original generated AVIF and WebP versions. The port copies the image as authored, with its size.
- **Feed stylesheet.** The original's pretty-feed XSL has no license, so it is not copied. The feed carries the same entries; `<id>` values differ in detail.
- **Sitemap contents.** Bascik's sitemap lists every published page, including tag pages, and not the feed. The original lists the feed and no tag pages. The development server serves no sitemap.
- **`pathPrefix`.** Hosting under a subpath is not exercised. Bascik's equivalent is the [`base`](/configuration#base) option.

> **Next:** see the same migration from a different starter in the [Astro Blog Tutorial](/switch/astro-blog-tutorial), or return to [From Eleventy](/switch/from-eleventy).
