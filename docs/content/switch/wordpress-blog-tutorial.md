# WordPress Blog Tutorial

This tutorial rebuilds a WordPress blog as a static Bascik site: the home listing with pagination, posts at date permalinks, category and tag archives, pages with a page menu, featured images, previous and next links, an RSS feed, a sitemap, and a 404 page. The content comes either from the live site's REST API, so WordPress stays as the editor, or from a WordPress export converted to Markdown, so you can leave WordPress entirely. Each section shows what WordPress did and the Bascik code that replaces it.

## The Original and the Port

| | |
| --- | --- |
| Original | WordPress 7.1.2 with its default theme, Twenty Twenty-Five 1.5 |
| Port | `migration-examples/ports/wordpress-blog/` in the Bascik repository |
| Requires | Node 24 or later, `@bascik/bascik` 1.0.0-rc.3 or later |
| Libraries | `sanitize-html`, `entities`, `marked`, `gray-matter`, `image-size`, `zod` |

WordPress and its theme are GPL. The port copies none of their code, markup, or styles: it is original code that reproduces what a visitor sees, and its CSS is new. The sample posts and images were written for it.

The port was checked side by side with a real WordPress 7.1.2 running locally, using the same browser assertions on both: every route and its status, listing order and pagination, post titles and document titles, category and tag links, previous and next links, headings, lists, figures, code, tables, quotes, featured images, entities, and the page menu. Further checks cover the minified production build, the development server, a rebuild after an edit in WordPress, a build from a converted export with WordPress stopped, keyboard navigation, a 390 pixel wide screen, and light and dark contrast.

## Run the Port

Copy `migration-examples/ports/wordpress-blog/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
BASCIK_SITE_URL=https://example.com npm run build   # from the Markdown in content/
npm run serve                                        # production server over dist/
```

To read a live WordPress site instead, set its address:

```sh
WORDPRESS_URL=https://cms.example.com BASCIK_SITE_URL=https://example.com npm run build
```

`BASCIK_SITE_URL` is required for a build because the feed needs absolute links. `npm run dev` starts the development server; content in `content/posts/_drafts/` appears there and is left out of builds.

## One Content Snapshot

A WordPress theme queries the database on every request. A static site reads everything once, at build time. The port does that in a single `pre` [exec script](/exec-scripts) that runs before any page compiles:

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    watchPaths: ['src/lib/'],
    exec: [
      { script: 'scripts/sync-wordpress.ts', phase: 'pre', watch: ['content/'], timeout: 600000 },
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] },
    ],
  },
  scripts: {
    cache: { exclude: ['src/pages/**', 'src/components/**'] },
  },
});
```

`scripts/sync-wordpress.ts` reads the REST API when `WORDPRESS_URL` is set and `content/` otherwise. It sanitizes every body, rewrites links between posts to their new paths, copies or downloads the images into `dist/`, validates the result with `zod`, and writes one JSON file under `node_modules/.cache/`. Every page reads that file and nothing else.

Three settings matter:

- **`scripts.cache.exclude`.** A build script's output is cached by its own text and the files it imports. The snapshot is read at run time, so Bascik cannot see it change. Without the exclusion, a rebuild after an edit in WordPress reuses the old pages.
- **`timeout`.** An exec script is stopped after 60 seconds by default. Downloading a large media library takes longer.
- **Light page helpers.** Every build script runs in its own Node process, so whatever a page imports is loaded once per script. Validation (`zod`) and sanitizing (`sanitize-html`) happen once, in the sync step; the helpers pages import (`src/lib/model.ts`, `render.ts`) have no dependencies. On the machine used for this tutorial, moving `zod` and `sanitize-html` out of the page helpers cut a 19-page build from 54 to 13 seconds.

## Reading the REST API

WordPress returns at most 100 items per request and rejects a larger `per_page` with a 400. The port follows the `X-WP-TotalPages` header and embeds authors, featured media, and terms in the same requests:

```ts
// src/lib/rest.ts (excerpt)
async function fetchAll(origin, path) {
  const items = [];
  for (let page = 1, total = 1; page <= total; page++) {
    const res = await fetch(`${origin}/wp-json/wp/v2/${path}&per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`WordPress REST request failed: ${res.status}`);
    total = Number(res.headers.get('x-wp-totalpages') ?? '1');
    items.push(...await res.json());
  }
  return items;
}

const posts = await fetchAll(origin, 'posts?_embed=author,wp:featuredmedia,wp:term&orderby=date&order=desc');
const pages = await fetchAll(origin, 'pages?orderby=menu_order&order=asc');
```

Only published items are public, so a draft, a private post, or a password-protected body never reaches the build. Titles arrive as HTML (`Fish &#038; Chips`), so the port turns them into plain text and escapes them again when printing. Featured images come with their resized copies (`raised-beds-300x188.png`); the port keeps the ones with the original aspect ratio for `srcset`, as WordPress does, and downloads them to the same `/wp-content/uploads/...` path so image URLs keep working.

## Sanitizing Post Bodies

`content.rendered` is HTML an editor saved. WordPress lets administrators save anything, including `<script>`, `onerror` handlers, `javascript:` links, and pasted embed code. The sample site includes such a post. Printed as is, its script would run for every visitor.

The port passes every body through an allowlist that covers what the core blocks produce:

```ts
// src/lib/html.ts (excerpt)
import sanitizeHtml from 'sanitize-html';

export function sanitizeContent(html, mapUrl) {
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'h1'), 'img', 'figure', 'figcaption'],
    allowedAttributes: { '*': ['class'], a: ['href', 'title', 'rel'], img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: mapUrl(attribs.src, 'image') ?? attribs.src } }),
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, href: mapUrl(attribs.href, 'link') ?? attribs.href } }),
    },
  });
}
```

The allowlist also removes unknown and custom elements, so a post cannot place a Bascik component tag such as `<site-header>` into the page.

Bascik adds a second line of defense. Build script output is processed again so that it can contain component tags, which means a `<script data-bascik-build>` inside printed content would run during the build with the build's file and network access. From 1.0.0-rc.3, Bascik removes any directive script (`data-bascik-build`, `data-bascik-server`, `data-bascik-routes`) that a build script prints, and warns:

```text
[bascik] warning: build script output in "pages/index.html" contained <script data-bascik-build>.
Printed directive scripts never run; they were removed. Write directives in source files, and
sanitize HTML from a CMS or an API before printing it.
```

That guard is not a sanitizer: it does nothing about ordinary `<script>` tags or event handlers. Keep the allowlist.

## Permalinks Are Dynamic Routes

WordPress's default "Day and name" permalinks are `/2026/03/15/raised-beds/`. A route parameter cannot contain `/`, so the template has one bracket per segment:

```html
<!-- src/pages/[year]/[month]/[day]/[slug]/index.html (excerpt) -->
<script data-bascik-routes>
  import { loadSnapshot } from '@/lib/model.ts';
  const { posts } = await loadSnapshot();
  console.log(JSON.stringify(posts.map((post) => {
    const [year, month, day] = post.date.slice(0, 10).split('-');
    return { params: { year, month, day, slug: post.slug } };
  })));
</script>
```

The other templates follow the same pattern: `[pageslug]/index.html` for top-level pages, `[parent]/[child]/index.html` for child pages, `page/[page]/index.html` for `/page/2/`, and `category/[term]/` and `tag/[term]/`, each with its own `page/[page]/` folder for later pages. These templates sit side by side at the root without colliding. `/nope/` matches no generated page and gets `src/pages/404.html` with a 404 status. A routes script that prints `[]` builds with a warning and leaves no output; the tag pagination template does that while no tag has more than three posts.

## The Loop and Pagination

The theme's Query Loop shows three posts per page with image, linked title, full content, and date, then Previous, numbered, and Next links. The port's `renderListing` in `src/lib/render.ts` prints the same structure for the home page and every archive. WordPress's posts-per-page setting is not exposed over REST, so the port keeps it as a constant (`POSTS_PER_PAGE` in `src/lib/model.ts`). Set it to match Settings > Reading on your site.

Post pages print previous and next links with `rel="prev"` and `rel="next"`. WordPress calls the older post "previous", and the port does the same.

## The Page Menu

Twenty Twenty-Five's header shows a Page List: top-level pages in menu order, with child pages beneath. The port builds it in the `site-header` component from the snapshot and marks the current page with `aria-current="page"`. The component's script is page-aware (`data-bascik-build="page"`), because it reads `BASCIK_PAGE_PATH` to know which link is current.

## From an Export

Tools > Export > All content produces a WXR file. The port reads what the community converter `wordpress-export-to-markdown` makes of it:

```sh
npx wordpress-export-to-markdown --wizard=false --input=export.xml --output=content \
  --post-folders=true --date-folders=none --save-images=all --include-time=true
```

Run it while the old site is still online: it downloads each post's images from there. The output is one folder per post with `index.md` and an `images/` folder. A real export of the sample site lost some things, and the port expects them back by hand:

| Lost in conversion | Restore it with |
| --- | --- |
| Site name, description, author | `content/site.json` |
| Display names of categories and tags (only slugs are kept) | `categories` and `tags` maps in `content/site.json` |
| A page's parent and menu order | `parent:` and `order:` in its front matter |
| Featured image alt text | `coverImageAlt:` in the post's front matter |
| Resized image copies | Nothing; the build writes no `srcset` for these images |
| Draft dates (WordPress dates a draft when it is published) | Drafts without a date are skipped with a warning |
| Images the converter could not download | The link stays; the build stops and names the missing file |

The converter also keeps raw HTML it cannot convert, such as pasted `<script>` tags and `<script data-bascik-build>` in the sample post. Markdown is rendered with `marked` and then goes through the same allowlist as REST content.

Titles in a WXR file are the raw text the editor typed. WordPress's theme renders a title as HTML and curls its quotes, so a title such as `Tags & <brackets> "quoted"` reads `Tags & “quoted”` on the WordPress site and over REST, and `Tags & <brackets> "quoted"` in the Markdown version.

## The Feed

WordPress serves RSS at `/feed/`. A static host cannot serve XML at a directory URL without its own configuration, so the port writes `/feed.xml` in a `post` exec script and links it from every page head. Add a redirect from `/feed/` on your host. Feed links and image URLs are absolute, which is why a build needs `BASCIK_SITE_URL`.

## What Was Not Ported

- Comments and search (`/?s=`). Both need a service; a static site cannot accept or query data by itself.
- Date archives (`/2026/`, `/2026/03/`) and author archives (`/author/admin/`). They follow the same dynamic route pattern if you need them.
- Empty categories. WordPress shows an empty archive for "Uncategorized"; the port has no page for a category without posts.
- Timezones. Dates are treated as UTC. Set the WordPress timezone to UTC, or adjust the date helpers.
- Twenty Twenty-Five's look. The port's CSS is original; reproduce your own theme's design from its rendered pages.
- Shortcodes, page builders, and plugin output. They arrive as whatever HTML WordPress rendered (over REST) or as raw shortcode text (in an export).

## Checks Worth Copying

The port's harness shows a few checks that catch real migration mistakes:

- Request every URL from the old sitemap and expect `200`, and expect `404` for a post that does not exist.
- Load a post that contains pasted script and assert nothing ran: no global set, no `<script>` in `main`, no `on*` attribute, no `javascript:` link.
- Edit a post in WordPress, publish a draft, and trash a post, then rebuild in the same folder and check that all three changes reached the pages, the sitemap, and the feed.
