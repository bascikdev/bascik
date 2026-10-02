# From WordPress

WordPress is a PHP content management system that renders pages from a database on each request; Bascik is a build tool for HTML components that produces static pages. The main conceptual shift is that a Bascik site has no database or admin dashboard at runtime. Theme templates become HTML component files, The Loop becomes a Node.js build script, and your posts and pages become Markdown files or build-time fetches from the WordPress REST API.

## Is This the Right Move?

- **Great fit:** Brochure sites, marketing sites, blogs, and documentation that are updated by developers or a small team comfortable with Markdown or a Git workflow.
- **Keep WordPress, or go headless:** Sites where non-technical editors need a visual dashboard, or that depend on plugins such as WooCommerce memberships or comment moderation. You can still get a static front end by keeping WordPress as a headless CMS and fetching content at build time (see [Keep WordPress as a Headless CMS](#keep-wordpress-as-a-headless-cms)).

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
| Media Library | `wp-content/uploads/` | Image files in your site's assets directory |

## A Low-Risk First Step

Move your theme's footer into a Bascik component before touching any content:

1. Create a new Bascik workspace with `yarn create bascik`.
2. Create `src/components/site-footer/site-footer.html` and paste the rendered footer markup from your live site.
3. Use `<site-footer></site-footer>` inside `src/pages/index.html`.
4. Run `yarn dev` to inspect the generated HTML.

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
<site-header></site-header>
<main>
  <div data-bascik-slot></div>
</main>
<site-footer></site-footer>
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

The Loop iterates over posts from the database. The Bascik equivalent is a `<script data-bascik-build>` block that reads Markdown files with Node.js and prints HTML to stdout.

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

    const files = (await readdir('./content/posts')).filter(f => f.endsWith('.md'));
    const posts = await Promise.all(files.map(async f => {
      const { data } = matter(await readFile(`./content/posts/${f}`, 'utf8'));
      return { slug: f.replace('.md', ''), title: data.title, date: data.date };
    }));
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));

    console.log(posts.map(p =>
      `<li><a href="/blog/${p.slug}">${p.title}</a><time>${p.date}</time></li>`
    ).join('\n'));
  </script>
</ul>
```

## Single Posts → Dynamic Routes

`single.php` renders one template for every post. In Bascik, a file named `src/pages/blog/[slug].html` with a `<script data-bascik-routes>` block expands into one static page per post. See [Dynamic Routes](/dynamic-routes) for the full route object format.

```html
<!-- src/pages/blog/[slug].html (Bascik - after) -->
<script data-bascik-routes>
  import { readdir } from 'node:fs/promises';

  const files = (await readdir('./content/posts')).filter(f => f.endsWith('.md'));
  console.log(JSON.stringify(files.map(f => ({
    params: { slug: f.replace('.md', '') }
  }))));
</script>
```

To keep existing permalinks, name files and folders to match your current URL structure (for example `src/pages/blog/[slug].html` for `/blog/my-post/`). Check the result against your live sitemap before launch.

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

1. **Export to Markdown.** Export your content from WordPress (Tools → Export produces a WXR XML file), convert posts to Markdown with a community converter, and commit the `.md` files under `content/`. Then read them with a build script as shown above. Review the converted output, because page builders and shortcodes rarely convert cleanly.
2. **Fetch at build time.** Read posts from the WordPress REST API in a build script. This keeps WordPress as your editor and Bascik as your renderer.

Copy images from `wp-content/uploads/` into your assets directory and update the paths. WordPress generates resized variants such as `photo-300x200.jpg`; keep only the originals you still reference.

## Keep WordPress as a Headless CMS

A WordPress site exposes its content at `/wp-json/wp/v2/posts` and `/wp-json/wp/v2/pages`. A `<script data-bascik-routes>` block can fetch from there, so editors keep using the dashboard while visitors receive static HTML.

```html
<!-- src/pages/blog/[slug].html (Bascik - after) -->
<script data-bascik-routes>
  const res = await fetch('https://cms.example.com/wp-json/wp/v2/posts?per_page=100&_fields=slug,title,content');
  const posts = await res.json();

  console.log(JSON.stringify(posts.map(post => ({
    params: { slug: post.slug },
    data: { title: post.title.rendered, content: post.content.rendered }
  }))));
</script>
```

```html
<!-- Same file: render the route data in the page body -->
<article>
  <script data-bascik-build>
    const { data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
    console.log(`<h1>${data.title}</h1>`);
    console.log(data.content);
  </script>
</article>
```

> **Rebuild on publish:** Static output only changes when you rebuild. Trigger a build from a WordPress webhook or your CI pipeline whenever content is published. The REST API returns up to 100 items per request, so paginate with the `page` parameter for larger sites.

> **Trusted content only:** The example prints `content.rendered` into the page as raw HTML. Only do this with content from a WordPress instance you control.

## Migration Checklist

1. Crawl your live site (or export a sitemap) and list every URL you need to keep.
2. Recreate the header, footer, and shared head as components.
3. Build the layout component and one page per template type.
4. Move content into Markdown or wire up the REST API.
5. Replace each plugin with a build script, API route, or service from the table above.
6. Compare the built output against your old sitemap, and configure redirects on your host for any URLs that change.

> **AI-Assisted Migration:** If you use LLMs or AI coding assistants to convert theme templates, see the [Agent Skill](/tools/agent-skill) documentation for guidelines on providing context to AI tools.
