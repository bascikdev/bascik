# Dynamic Routes

Dynamic routes allow you to generate multiple static HTML pages from a single template file at build time. By combining bracket syntax in filenames with a route generation script, you can prerender blogs, product catalogs, documentation sets, and localized sites with zero runtime JavaScript overhead.

## How It Works

When Bascik processes your `src/pages` directory, any file containing square brackets in its name, such as `src/pages/blog/[slug].html` or `src/pages/[category]/[id].html`, is treated as a dynamic route template.

During the build or development startup:

1. Bascik discovers the dynamic route template and extracts all parameter placeholders inside brackets.
2. Bascik executes the `<script data-bascik-routes>` script inside the template.
3. The script outputs a JSON list of route objects defining parameters and optional payload data.
4. Bascik expands the single template into multiple concrete HTML files, writing them to `dist/` and updating the sitemap.

## data-bascik-routes

To define the routes to generate, place a `<script data-bascik-routes>` element inside the template file. The script runs in Node.js at build time and must print a valid JSON array to standard output using `console.log()`.

```html
<script data-bascik-routes>
  const posts = [
    { slug: 'hello-world', title: 'Hello World', date: '2026-01-15' },
    { slug: 'second-post', title: 'Second Post', date: '2026-02-01' }
  ];

  const routes = posts.map(post => ({
    params: { slug: post.slug },
    data: post
  }));

  console.log(JSON.stringify(routes));
</script>
```

### Route Object Format

Each element in the emitted array must be an object with:

- `params` (required): An object whose keys match the bracket names in the template filename. For `[slug].html`, `params` must contain `{ slug: "..." }`. Values are automatically converted to strings.
- `data` (optional): Any serializable value (object, array, string, number, or boolean) to pass directly to build scripts without re-fetching.

```json
[
  {
    "params": { "slug": "getting-started" },
    "data": { "title": "Getting Started", "author": "Alice" }
  },
  {
    "params": { "slug": "advanced-patterns" },
    "data": { "title": "Advanced Patterns", "author": "Bob" }
  }
]
```

> **Strict validation.** Every required bracket parameter in the filename must be present in `params`. If a bracket name is missing, or if the output is not a valid JSON array, the build halts with a descriptive error.

## Accessing Route Data in Build Scripts

Inside your template, `<script data-bascik-build>` blocks can read the current route parameters and associated data from the `BASCIK_ROUTE` environment variable.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <script data-bascik-build>
    const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');
    const { title } = route.data || {};
    console.log(`<title>${title || 'Blog'} - My Site</title>`);
  </script>
</head>
<body>
  <article>
    <script data-bascik-build>
      const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');
      const { params, data } = route;
      console.log(`<h1>${data.title}</h1>`);
      console.log(`<p class="slug">Slug: ${params.slug}</p>`);
      console.log(`<p class="date">Published: ${data.date}</p>`);
    </script>
  </article>
</body>
</html>
```

## Coexistence with Server Scripts

Dynamic route templates can contain both `<script data-bascik-build>` and `<script data-bascik-server>` blocks.

- The `<script data-bascik-routes>` script expands the template into concrete HTML files at build time (for example, `dist/blog/hello-world.html` and `dist/blog/second-post.html`).
- The `<script data-bascik-server>` blocks remain in the generated HTML files and execute per request when served by the Bascik production server.
- Note that `<script data-bascik-routes>` cannot be combined with `<script data-bascik-build>` or `<script data-bascik-server>` on the same script tag.

## Cache Invalidation

Bascik caches build script executions to optimize build performance. When compiling dynamic routes, the current `BASCIK_ROUTE` environment payload is incorporated into the build script cache key.

This ensures that build scripts in the same template re-execute accurately for each unique route without returning stale cached content from preceding routes.

## Worker Pool Parallelization

When compiling large sets of dynamic routes, Bascik distributes page rendering jobs across all available worker threads in the worker pool.

Each route job receives its specific parameters and data payload, enabling fast parallel static generation across multi-core CPUs.

## Sitemap Integration

Dynamic routes automatically integrate into Bascik's built-in sitemap generator (`sitemap.xml` and `robots.txt`).

- Concrete generated paths (such as `/blog/hello-world` and `/blog/second-post`) are included in `sitemap.xml`.
- The template file with literal brackets (like `/blog/[slug]`) is never added to the sitemap.
- Non-ASCII or special characters in route parameters are percent-encoded according to the XML sitemap standard.

## Error Handling and Diagnostics

Bascik validates routes scripts, route parameters, and output destinations during the build:

- **Collision Detection:** If a dynamic route and a static page resolve to the same output path (e.g. `src/pages/blog/hello.html` and `src/pages/blog/[slug].html` with `slug: "hello"`), or if two dynamic templates produce colliding paths, Bascik fails the build with an error naming both sources.
- **URL-Safe Route Parameters:** Route parameter values must be valid filename and URL tokens. Characters such as `#`, `%`, `&`, `'`, `+`, spaces, leading dots, and Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) are rejected with descriptive warnings.
- **Zero Routes:** If a routes script returns an empty array `[]`, Bascik emits a warning indicating the template produced 0 routes.
- **Missing Parameters:** If a template is named `[category]/[id].html` and a route object only provides `{ category: "news" }`, Bascik throws an error indicating that parameter `id` was not supplied.
- **Invalid Output Format:** If the script prints text that is not valid JSON or does not resolve to an array of objects with `params`, Bascik throws a descriptive error detailing the received output.
- **Conflicting Directives:** Specifying `data-bascik-routes` alongside `data-bascik-build` or `data-bascik-server` on a single script tag is prevented with a validation error.

## Common How-to Examples

### 1. Markdown Blog Posts

Generate blog posts from local Markdown files:

```html
<script data-bascik-routes>
  import { readdir, readFile } from 'node:fs/promises';
  import { join } from 'node:path';

  const files = await readdir('./content/posts');
  const posts = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const slug = file.replace(/\.md$/, '');
    const content = await readFile(join('./content/posts', file), 'utf8');
    posts.push({
      params: { slug },
      data: { content }
    });
  }

  console.log(JSON.stringify(posts));
</script>
```

### 2. Product Catalog from an API

Fetch product listings from a CMS or REST API:

```html
<script data-bascik-routes>
  const res = await fetch('https://api.example.com/products');
  const products = await res.json();

  const routes = products.map(product => ({
    params: { id: String(product.id) },
    data: product
  }));

  console.log(JSON.stringify(routes));
</script>
```

### 3. Multi-Language / i18n Pages

Generate localized pages using multiple parameters in filenames such as `src/pages/[lang]/[page].html`:

```html
<script data-bascik-routes>
  const languages = ['en', 'es', 'fr', 'de'];
  const pages = ['about', 'pricing', 'contact'];

  const routes = [];
  for (const lang of languages) {
    for (const page of pages) {
      routes.push({
        params: { lang, page },
        data: { lang, page }
      });
    }
  }

  console.log(JSON.stringify(routes));
</script>
```
