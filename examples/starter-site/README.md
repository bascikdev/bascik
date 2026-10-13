# Starter Site

A small, complete Bascik site: shared head, header, and footer components, a light and dark theme, per-page SEO tags, a Markdown blog with tags and an Atom feed, `llms.txt`, a contact form with an API route, and a 404 page. Copy it whole or take the parts you need.

```sh
npm install
BASCIK_SITE_URL=https://example.com npx bascik --build
npx bascik --server
```

## Copy It

With the [Bascik agent skills](https://bascik.dev/tools/agent-skill) installed, run from your project root:

```sh
node .agents/skills/bascik/scripts/add-example.mjs starter-site
node .agents/skills/bascik/scripts/add-example.mjs starter-site/src/pages/blog starter-site/src/lib/posts.ts
```

The script prints `bascik.config.ts` and `package.json` instead of copying them; merge their settings and install `marked`. It also copies the [example components](https://bascik.dev/example-components) the site uses: [Site Header](https://bascik.dev/example-components/site-header), [Site Footer](https://bascik.dev/example-components/site-footer), [Theme Toggle](https://bascik.dev/example-components/theme-toggle) (with `theme-init`), and [Contact Form](https://bascik.dev/example-components/contact-form).

In this repository the site lists `../components` as a second component folder to reach the shared example components. In your project those components are copied into `src/components/`, so leave that entry out.

## Configuration

`bascik.config.ts`:

- `pipeline.watchPaths` rebuilds pages in the dev server when a post or a helper in `src/lib/` changes.
- The blog pages and the home page call `getPosts()`, which reads a directory. The [build script cache](https://bascik.dev/build-scripts) keys only on files a script names literally, so those pages are excluded from it; otherwise a new post would not appear.
- Two `post` exec scripts read the finished output: `scripts/feed.ts` writes `feed.xml`, and `scripts/llms-txt.ts` writes `llms.txt`.

## Layout Components

Every page is a short shell: `<site-head />` in `<head>`, then `<site-header><theme-toggle /></site-header>`, a `<main id="main">`, and `<site-footer />`.

`site-head` is the site's own component: it holds the stylesheet, favicon, and `theme-init`. The header and footer are the [Site Header](https://bascik.dev/example-components/site-header) and [Site Footer](https://bascik.dev/example-components/site-footer) example components. Edit their navigation in `links.ts` next to each component; the header marks the current page at build time. The theme toggle goes in the header's slot.

## SEO Tags

`seo()` in `src/lib/seo.ts` writes the title, description, canonical URL, Open Graph, and Twitter tags for one page, escaping every value. Absolute URLs come from `BASCIK_SITE_URL`, `BASCIK_BASE`, and the page path, so the same source works at any domain and base path. Call it from a build script in each page's `<head>` (see `src/pages/about.html`), not from a shared component, so each page gets its own canonical URL.

The helper also exports `jsonLd()` (it escapes `<` so data can never close the script tag), `breadcrumbList()`, and `article()`. A page marked `noindex` also needs `<meta name="bascik-sitemap" content="exclude" />` in its source; see [Sitemap](https://bascik.dev/sitemap#per-page-sitemap-exclusion).

## Blog

Posts are Markdown files in `content/posts/`. `src/lib/posts.ts` is the only code that reads them: it parses front matter, validates every post (a missing title, description, or `YYYY-MM-DD` date fails the build with the file name), renders the body with `marked`, and leaves out `draft: true` posts in `bascik --build`.

`src/pages/blog/[slug]/index.html` is a [dynamic route](https://bascik.dev/dynamic-routes): its routes script returns one route per post with the post as `data`, and the page's head script passes the post's fields to `seo()` and `article()`.

Rendered Markdown is styled by `src/pages/css/prose.css`, a global stylesheet, so plain selectors such as `.prose h2` match the generated HTML. In a component, an element selector only matches elements written in the component's template.

## Feed and llms.txt

`scripts/feed.ts` writes an Atom feed of the latest posts with absolute URLs, and fails a production build without `BASCIK_SITE_URL`. `scripts/llms-txt.ts` lists every indexable page with its title and description, grouped by section, and leaves an authored `src/pages/llms.txt` alone.

## Build and Check It

```sh
BASCIK_SITE_URL=https://example.com npx bascik --build
npx bascik --server
```

Before launch, check every page:

- Each page has a unique `<title>` and description and one `<h1>`.
- The skip link appears on Tab and jumps to the main content.
- Light and dark themes both have readable contrast, and a reload shows no theme flash.
- Images have `alt`, `width`, and `height`, and the largest image above the fold is not lazy-loaded.
- `dist/sitemap.xml` and `dist/robots.txt` list the real domain.
- An unknown URL shows the 404 page.

The agent skills include scripts that check the build output for broken links, SEO tags, and undeclared CSS tokens.
