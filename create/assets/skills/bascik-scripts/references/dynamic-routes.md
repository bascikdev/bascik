# Dynamic Routes Reference

A page file with bracketed segments is a template. Its `<script data-bascik-routes>` returns the list of concrete routes to build.

```text
src/pages/blog/[slug].html                 /blog/<slug>
src/pages/blog/[slug]/index.html           /blog/<slug>/   (trailing slash)
src/pages/[category]/[id].html             /<category>/<id>
src/pages/[year]/[month]/[slug]/index.html one bracket per segment
```

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-routes>
  export default async function () {
    const posts = [
      { slug: 'hello-world', title: 'Hello World' },
      { slug: 'second-post', title: 'Second Post' },
    ];
    return posts.map((post) => ({ params: { slug: post.slug }, data: post }));
  }
</script>

<script data-bascik-build>
  export default function () {
    const { params, data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
    return `<h1>${data.title}</h1>`;
  }
</script>
```

The titles are literals here; escape any value that comes from content or an API.

## Rules

- The default export returns an array of `{ params, data? }`. `params` must provide every bracket name in the path. Return `[]` for zero routes.
- Params must be URL-safe tokens. `/`, `#`, `%`, `&`, `'`, `+`, spaces, leading dots, and Windows device names are rejected. A param never spans segments: use one template per depth.
- Inside the template, build scripts read the current route from `process.env.BASCIK_ROUTE` (`{ params, data }`).
- Templates are expanded during `bascik --build` and at dev server startup. A route that collides with a static page or another template is a build error.
- Concrete routes are added to `sitemap.xml`, percent-encoded.
- `data-bascik-routes` cannot share a tag with any other directive.
- Do not generate `.html` files into `src/pages/` as a substitute. Templates are the supported mechanism.
- Unknown slugs return 404 (static hosts serve `404.html`).

## Paged archives

Each pagination depth is its own template: `src/pages/blog/page/[page]/index.html` returning `{ params: { page: '2' } }` and so on. Category and tag archives follow the same pattern (`category/[term]/index.html`).

## Data from an API

Fetch once in an exec script (`phase: 'pre'`) that writes a JSON snapshot to `BASCIK_OUT_DIR` or a cache directory, then have the routes and build scripts read that snapshot. Network responses are invisible to the build script cache, so scripts that fetch directly must be listed in `scripts.cache.exclude`.
