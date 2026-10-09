# From WordPress

WordPress is a PHP content management system that renders pages from a database on each request; Bascik is a build tool for HTML components. Theme templates become HTML component files, The Loop becomes a Node.js build script, and your posts and pages become Markdown files or build-time fetches from the WordPress REST API.

## Why Switch to Bascik

- **Streamlined Architecture:** Clean HTML, CSS, and scoped JavaScript without the weight, vulnerabilities, or maintenance overhead of a database-backed CMS.
- **Flexible Content Workflows:** Manage content via Markdown, headless CMS APIs, or build scripts, deploying to any host or serverless platform.
- **Headless Option:** You can keep WordPress as a headless CMS for authoring while letting Bascik render fast, modern front ends (see [Keep WordPress as a Headless CMS](#keep-wordpress-as-a-headless-cms)).

## Mental Model Comparison

| Concept | WordPress | Bascik |
| --- | --- | --- |
| Theme template parts | `header.php`, `footer.php`, `get_template_part()` | `src/components/site-header/site-header.html` (`<site-header>`) |
| Page templates | `page.php`, `single.php`, `archive.php` | Files in `src/pages/` plus slot-based layout components |
| The Loop | `while ( have_posts() ) : the_post();` | `<script data-bascik-build>` with Node.js |
| Template tags | `the_title()`, `the_permalink()` | `data-bascik-prop-*` and `data-bascik-attr-*` |
| Posts and pages in the database | Markdown files or the REST API at build time | [Dynamic Routes](/dynamic-routes) |
| Shortcodes and blocks | `[callout]...[/callout]` | Component tags with `data-bascik-slot` |
| `style.css` and enqueued assets | `wp_enqueue_style()` | Paired `.css` files (auto-scoped and deduplicated) |
| `functions.php` hooks | `add_action()` and `add_filter()` | Build scripts, [Exec Scripts](/exec-scripts), and [API Routes](/api-routes) |
| Plugins | PHP plugins | npm packages, build scripts, or hosted services |
| Media Library | `wp-content/uploads/` | Image files copied into `dist/` by an [Exec Script](/exec-scripts) |
| Permalinks (`/%year%/%monthnum%/%day%/%postname%/`) | Rewrite rules | One dynamic route template per URL shape, such as `src/pages/[year]/[month]/[day]/[slug]/index.html` |

## A Low-Risk First Step

Move your theme's footer into a Bascik component before touching any content:

1. Create a new Bascik project with `npm create bascik@latest`.
2. Create `src/components/site-footer/site-footer.html` and paste the rendered footer markup from your live site.
3. Use `<site-footer />` inside `src/pages/index.html`.
4. Run `npm run dev` to inspect the generated HTML.

## Theme Files → HTML Component Files

WordPress themes are PHP files that mix markup and logic. In Bascik, every reusable piece of markup is a plain `.html` file under `src/components/`, identified by its hyphenated folder name. Start from the rendered HTML of your live site rather than the PHP source.

```text
Before (WordPress theme)       After (Bascik)
my-theme/                      src/components/
  header.php                     site-header/
  footer.php                       site-header.html
  sidebar.php                    site-footer/
  index.php                        site-footer.html
  single.php                     site-layout/
  page.php                         site-layout.html
  archive.php                    post-card/
  template-parts/                  post-card.html
    content-post.php           src/pages/
  style.css                      index.html
  functions.php                  about.html
                                 blog/
                                   [slug].html
```

## `get_header()` and `get_footer()` → Slot-based Layout Components

A WordPress template calls `get_header()` and `get_footer()` around the page content. In Bascik, a layout component wraps the repeated structure and uses `data-bascik-slot` for the page body.

```php
<?php /* page.php (WordPress - before) */ ?>
<?php get_header(); ?>
<main>
  <h1><?php the_title(); ?></h1>
  <?php the_content(); ?>
</main>
<?php get_footer(); ?>
```

```html
<!-- src/components/site-layout/site-layout.html (Bascik - after) -->
<site-header />
<main>
  <div data-bascik-slot></div>
</main>
<site-footer />
```

```html
<!-- src/pages/about.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>About - Acme</title>
  <meta name="description" content="Learn about Acme Corp." />
</head>
<body>
  <site-layout>
    <h1>About</h1>
    <p>We build things.</p>
  </site-layout>
</body>
</html>
```

The `<html>`, `<head>`, and `<body>` live in the page file, so `wp_head()` and `wp_footer()` have no direct equivalent. Put shared head markup such as favicons, fonts, and Open Graph tags in a reusable component like `<site-head>`.

## Template Tags → data-bascik-prop-* and data-bascik-attr-*

Template tags such as `the_title()` and `the_permalink()` print values from the current post. In Bascik, a component declares where values go with `data-bascik-prop-*` for text and `data-bascik-attr-{attribute}="{propName}"` for attributes such as `href` or `src`.

```php
<?php /* template-parts/content-post.php (WordPress - before) */ ?>
<article class="post-card">
  <h3><?php the_title(); ?></h3>
  <p><?php echo esc_html( get_the_excerpt() ); ?></p>
  <a href="<?php the_permalink(); ?>">Read more</a>
</article>
```

```html
<!-- src/components/post-card/post-card.html (Bascik - after) -->
<article class="post-card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-excerpt></p>
  <a data-bascik-attr-href="url">Read more</a>
</article>

<!-- Usage -->
<post-card
  data-bascik-prop-title="Hello World"
  data-bascik-prop-excerpt="A short summary."
  data-bascik-prop-url="/blog/hello-world"
></post-card>
```

> **Text and attribute values:** Bascik props carry plain text strings. For rich HTML content, such as a post body, use a slot instead of a prop.

## The Loop → `<script data-bascik-build>`

The Loop iterates over posts from the database. The Bascik equivalent is a `<script data-bascik-build>` block that reads Markdown files with Node.js and returns HTML from its default export.

```php
<?php /* archive.php (WordPress - before) */ ?>
<ul class="post-list">
  <?php while ( have_posts() ) : the_post(); ?>
    <li>
      <a href="<?php the_permalink(); ?>"><?php the_title(); ?></a>
      <time><?php echo get_the_date( 'Y-m-d' ); ?></time>
    </li>
  <?php endwhile; ?>
</ul>
```

```html
<!-- src/pages/blog/index.html (Bascik - after) -->
<ul class="post-list">
  <script data-bascik-build>
    import { readdir, readFile } from 'node:fs/promises';
    import matter from 'gray-matter';

    const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

    export default async function () {
      const files = (await readdir('./content/posts')).filter(f => f.endsWith('.md'));
      const posts = await Promise.all(files.map(async f => {
        const { data } = matter(await readFile(`./content/posts/${f}`, 'utf8'));
        return { slug: f.replace('.md', ''), title: data.title, date: new Date(data.date) };
      }));
      posts.sort((a, b) => b.date - a.date);

      return posts.map(p =>
        `<li><a href="/blog/${p.slug}/">${escape(p.title)}</a> <time datetime="${p.date.toISOString()}">${p.date.toISOString().slice(0, 10)}</time></li>`
      ).join('\n');
    }
  </script>
</ul>
```

Install `gray-matter` (`npm install gray-matter`): the scaffold does not include it. A title is text, so escape it before returning. A page that reads files Bascik cannot see as imports (here `readdir`) must be listed in `scripts.cache.exclude`, or a rebuild reuses the old output; see [Build Scripts](/build-scripts#invalidation-limits-cache-exclusions).

## Single Posts → Dynamic Routes

`single.php` renders one template for every post. In Bascik, a file named `src/pages/blog/[slug].html` with a `<script data-bascik-routes>` block expands into one static page per post. See [Dynamic Routes](/dynamic-routes) for the full route object format.

```html
<!-- src/pages/blog/[slug].html (Bascik - after) -->
<script data-bascik-routes>
  import { readdir } from 'node:fs/promises';

  export default async function () {
    const files = await readdir('./content/posts');
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        params: { slug: f.replace('.md', '') }
      }));
  }
</script>
```

To keep existing permalinks, name files and folders to match your current URL structure. `src/pages/blog/[slug].html` writes `/blog/my-post.html`; for the trailing-slash URLs WordPress uses, put the template in a folder: `src/pages/blog/[slug]/index.html` gives `/blog/my-post/`. A route parameter cannot contain `/`, so a date permalink needs one bracket per segment:

```text
WordPress permalink                    Bascik template
/2026/03/15/raised-beds/               src/pages/[year]/[month]/[day]/[slug]/index.html
/about/  (top-level page)              src/pages/[pageslug]/index.html
/about/colophon/  (child page)         src/pages/[parent]/[child]/index.html
/category/notes/                       src/pages/category/[term]/index.html
/page/2/                               src/pages/page/[page]/index.html
```

Templates at different depths can sit side by side at the root. Check the result against your live sitemap before launch.

## Shortcodes and Blocks → Components

Shortcodes such as `[callout]text[/callout]` and custom Gutenberg blocks are reusable fragments. In Bascik, they become component files. For fragments that wrap content, use `data-bascik-slot`.

```php
<?php /* functions.php (WordPress - before) */
add_shortcode( 'callout', function ( $atts, $content = '' ) {
  return '<div class="callout">' . do_shortcode( $content ) . '</div>';
} );
```

```html
<!-- src/components/my-callout/my-callout.html (Bascik - after) -->
<div class="callout">
  <div data-bascik-slot></div>
</div>

<!-- Used in a page with: -->
<my-callout><p>This is a tip.</p></my-callout>
```

## `style.css` → Paired CSS Files

WordPress themes usually ship one global stylesheet loaded with `wp_enqueue_style()`. In Bascik, write a `.css` file next to each component. Class names are scoped at build time, so you can split a large `style.css` per component and stop worrying about collisions with plugin styles. See [Scoped Styles](/scoped-styles).

## Plugins → Build Scripts, API Routes, and Services

Plugins have no direct equivalent because Bascik pages are static HTML. Map each plugin to the closest piece:

| Plugin purpose | Bascik approach |
| --- | --- |
| SEO (title, meta, sitemap) | Hardcode tags in pages, and use the built-in [Sitemap and Robots](/sitemap) generation |
| Contact forms | A handler in `src/api/` (see [API Routes](/api-routes)) or a hosted form service |
| Search | Build a search index at build time with an [Exec Script](/exec-scripts) |
| Caching and performance | Not needed for static output; see [Performance](/performance) |
| Image galleries and sliders | Vanilla JavaScript in a component `<script>`, see [Scoped JavaScript](/scoped-javascript) |
| Comments, memberships, e-commerce | Hosted services, or keep WordPress for those features |

```ts
// src/api/contact.ts (Bascik - replaces a contact form plugin)
export const POST = async (request: Request): Promise<Response> => {
  const { name, email, message } = await request.json();
  if (!email || !message) {
    return Response.json({ error: 'email and message are required' }, { status: 400 });
  }
  // Send the message with your email provider here.
  return Response.json({ ok: true }, { status: 201 });
};
```

Run `bascik --server` to serve API routes in production. Fully static hosting cannot run API routes, so pick a host that supports them or use a hosted form service.

## Moving Your Content

You have two options, and they can be combined:

1. **Export to Markdown.** Export your content from WordPress (Tools → Export produces a WXR XML file), convert posts to Markdown with a community converter such as `wordpress-export-to-markdown`, and commit the `.md` files under `content/`. Then read them with a build script as shown above. Run the converter while the old site is still online, because it downloads the images. Review the output: page builders and shortcodes rarely convert cleanly; check page hierarchy, category names, image alt text, and draft dates.
2. **Fetch at build time.** Read posts from the WordPress REST API in a build script. This keeps WordPress as your editor and Bascik as your renderer.

The converter saves each post's images next to its Markdown, as originals only. Copy them into `dist/` with an [Exec Script](/exec-scripts) and point the Markdown at the copied path. The resized copies WordPress made (`photo-300x200.jpg`) are not in an export; if you want `srcset`, regenerate them or keep fetching through the REST API, which lists them.

## Keep WordPress as a Headless CMS

A WordPress site exposes its published content at `/wp-json/wp/v2/posts` and `/wp-json/wp/v2/pages`. Drafts, private posts, and password-protected bodies are not public, so they never reach the build. Editors keep using the dashboard while visitors receive static HTML.

Fetch everything once, in a `pre` [Exec Script](/exec-scripts), rather than in every page. The script follows the `X-WP-TotalPages` header (the API rejects `per_page` above 100 with a 400), sanitizes each body, downloads the media into `dist/`, and writes one JSON file that the pages read:

```ts
// scripts/sync-wordpress.ts (Bascik - a pre exec step; illustrative)
import { mkdir, writeFile } from 'node:fs/promises';
import sanitizeHtml from 'sanitize-html';

const origin = process.env.WORDPRESS_URL;
const posts = [];
for (let page = 1, total = 1; page <= total; page++) {
  const res = await fetch(`${origin}/wp-json/wp/v2/posts?per_page=100&page=${page}&_embed=wp:term`);
  if (!res.ok) throw new Error(`WordPress returned ${res.status}`);
  total = Number(res.headers.get('x-wp-totalpages') ?? 1);
  posts.push(...await res.json());
}
const snapshot = posts.map((post) => ({
  slug: post.slug,
  date: post.date,
  title: sanitizeHtml(post.title.rendered, { allowedTags: [] }),
  html: sanitizeHtml(post.content.rendered),
}));
await mkdir('node_modules/.cache/site', { recursive: true });
await writeFile('node_modules/.cache/site/posts.json', JSON.stringify(snapshot));
```

```html
<!-- src/pages/[year]/[month]/[day]/[slug]/index.html (Bascik - after) -->
<script data-bascik-routes>
  import { readFile } from 'node:fs/promises';

  export default async function () {
    const posts = JSON.parse(await readFile('node_modules/.cache/site/posts.json', 'utf8'));
    return posts.map((post) => {
      const [year, month, day] = post.date.slice(0, 10).split('-');
      return { params: { year, month, day, slug: post.slug } };
    });
  }
</script>
```

> **Sanitize what you print.** `content.rendered` is HTML that an editor wrote, and administrators may save any markup, including `<script>`, `onerror` handlers, and `javascript:` links. Printed as is, it runs in every visitor's browser. Pass it through an allowlist such as `sanitize-html` before printing. Bascik also removes any `<script data-bascik-build>`, `data-bascik-server`, or `data-bascik-routes` tag found in a build script's output, with a warning. This is not a substitute for sanitizing CMS content.

> **Rebuild on publish:** Static output only changes when you rebuild. Trigger a build from a WordPress webhook or your CI pipeline whenever content is published. List the pages that read the fetched data in `scripts.cache.exclude`: a build script's cache key does not include network responses, so without it a rebuild can reuse output from before the edit.

> **Large posts:** Passing a whole post body as route `data` works without an environment-size limit. Reading the snapshot file from the page is another option.

## Migration Checklist

1. Crawl your live site (or export a sitemap) and list every URL you need to keep.
2. Recreate the header, footer, and shared head as components.
3. Build the layout component and one page per template type.
4. Move content into Markdown or wire up the REST API.
5. Replace each plugin with a build script, API route, or service from the table above.
6. Compare the built output against your old sitemap, and configure redirects on your host for any URLs that change. WordPress serves its feed at `/feed/`; a static feed is usually a file such as `/feed.xml`, so redirect the old address.
7. Choose your approach for dynamic features such as comments, search, and archives using Bascik API routes, server scripts, or dedicated services.

> **AI-Assisted Migration:** If you use LLMs or AI coding assistants to convert theme templates, see the [Agent Skill](/tools/agent-skill) documentation for guidelines on providing context to AI tools.
