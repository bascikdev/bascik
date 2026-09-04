# Environment Variables

Bascik automatically populates a collection of dedicated environment variables inside child processes when executing build scripts, dynamic route generators, and lifecycle tasks. These variables give your scripts direct access to the active page path, filesystem locations, site configuration, dynamic route parameters, and compiler execution modes without requiring manual configuration or boilerplate.

You access these variables using standard Node.js `process.env.<VARIABLE_NAME>`.

## Environment Variable Reference

| Variable | Available In | Description |
| --- | --- | --- |
| `BASCIK_PAGE_PATH` | `data-bascik-build`, `data-bascik-routes` | Normalized root-relative URL path for the page being transpiled (e.g. `/getting-started`, `/switch/from-vue`, `/`, `/blog/hello-world`). |
| `BASCIK_SOURCE_FILE` | `data-bascik-build`, `data-bascik-routes` | Absolute filesystem path to the file currently executing the script (points to the component template in components, or the page file in pages). |
| `BASCIK_PAGE_FILE` | `data-bascik-build`, `data-bascik-routes` | Absolute filesystem path to the top-level HTML page shell currently being compiled. Always points to the page shell even when inside nested components. |
| `BASCIK_SITE_URL` | `data-bascik-build`, `data-bascik-routes` | The site URL resolved from `--site-url`, the `BASCIK_SITE_URL` environment variable, or a `.env` file (e.g. `https://bascik.dev`). Absent when unset, never an empty string. |
| `BASCIK_PAGES_DIR` | `data-bascik-build`, `data-bascik-routes` | Absolute filesystem path to the configured pages directory (`directory.pages`, defaults to `<root>/src/pages`). |
| `BASCIK_ROUTE` | `data-bascik-build` (dynamic routes) | JSON string of `{ params, data }` for the current route instance in parameterized page templates like `[slug].html`. |
| `BASCIK_BUILD` | All build scripts, worker threads, and exec scripts | `"1"` when running static compilation (`bascik --build`), `"0"` during local development (`bascik`). |
| `BASCIK_SERVER` | Server scripts and worker threads | `"1"` when running the production server (`bascik --server`), `"0"` otherwise.  |
| `BASCIK_BUILD_LOG` | CLI runtime | Absolute filesystem path to the build log destination when invoked with `--log`. |

## Build-Time Scripts (`data-bascik-build`)

Every `<script data-bascik-build>` block runs inside an isolated Node.js child process with access to page, file, and configuration variables.

### `BASCIK_PAGE_PATH`

The normalized root-relative URL path corresponding to the page being generated.

- `src/pages/index.html` → `/`
- `src/pages/getting-started.html` → `/getting-started`
- `src/pages/blog/index.html` → `/blog/`
- `src/pages/blog/[slug].html` with param `{ slug: 'first-post' }` → `/blog/first-post`

```ts
// Example: Active navigation link detection
const currentPath = process.env.BASCIK_PAGE_PATH;
const isCurrent = currentPath === '/components';
```

### `BASCIK_SOURCE_FILE` vs `BASCIK_PAGE_FILE`

When a build script runs directly inside a page (`src/pages/about.html`), both `BASCIK_SOURCE_FILE` and `BASCIK_PAGE_FILE` point to `/absolute/path/to/src/pages/about.html`.

When a component (`src/components/author-bio/author-bio.html`) contains a page-aware build script (`<script data-bascik-build="page">`), the variables provide distinct locations:

- `BASCIK_SOURCE_FILE`: The path to the component file `/absolute/path/to/src/components/author-bio/author-bio.html`.
- `BASCIK_PAGE_FILE`: The path to the page shell importing the component `/absolute/path/to/src/pages/about.html`.

```ts
import { readFile } from 'node:fs/promises';

// Read metadata directly from the page shell that included this component
const pageMarkup = await readFile(process.env.BASCIK_PAGE_FILE!, 'utf8');
```

### `BASCIK_SITE_URL` and `BASCIK_PAGES_DIR`

`BASCIK_SITE_URL` provides the deployment origin set via `--site-url`, the environment, or a `.env` file, while `BASCIK_PAGES_DIR` provides the resolved directory containing page templates. Together with `BASCIK_PAGE_PATH`, they enable automatic canonical URL and structured data generation:

```ts
// src/lib/canonical.ts
export function getCanonicalUrl(): string {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  const path = process.env.BASCIK_PAGE_PATH ?? '/';
  return siteUrl ? `${siteUrl}${path}` : path;
}
```

### `BASCIK_ROUTE`

When rendering dynamic pages from parameterized templates (such as `src/pages/posts/[slug].html`), Bascik executes the page once for each route returned by `<script data-bascik-routes>`. During each execution, `BASCIK_ROUTE` contains the JSON-serialized route context:

```html
<!-- src/pages/posts/[slug].html -->
<script data-bascik-build>
  const { params, data } = JSON.parse(process.env.BASCIK_ROUTE);
  console.log(`<h1>${params.slug}</h1>`);
  console.log(`<article>${data.contentHtml}</article>`);
</script>
```

> **Dynamic Route Safety.** `process.env.BASCIK_ROUTE` is only defined when transpiling dynamic routes. For static pages, the variable is omitted from the environment.

## Dynamic Route Scripts (`data-bascik-routes`)

`<script data-bascik-routes>` blocks execute once during discovery to generate the list of parameters and optional data for route expansion.

```html
<!-- src/pages/products/[category]/[id].html -->
<script data-bascik-routes>
  // Access template file location and pages directory
  const templatePath = process.env.BASCIK_SOURCE_FILE;

  const routes = await fetchProductManifest();
  console.log(JSON.stringify(routes));
</script>
```

Dynamic route scripts receive:
- `BASCIK_SOURCE_FILE` and `BASCIK_PAGE_FILE`: Path to the template file.
- `BASCIK_PAGE_PATH`: Raw template route path (e.g. `/products/[category]/[id]`).
- `BASCIK_PAGES_DIR`: Absolute pages directory.
- `BASCIK_SITE_URL`: Configured site URL.
- `BASCIK_BUILD`: `"1"` in build mode, `"0"` in dev mode.

## Compiler & Runtime Flags

### `BASCIK_BUILD`

Set to `"1"` when running static site compilation (`bascik --build`), and `"0"` when running the local development server (`bascik`).

Use `BASCIK_BUILD` to skip heavy computations or live API queries during fast local development while enforcing full generation during production builds:

```ts
const isBuild = process.env.BASCIK_BUILD === '1';

if (isBuild) {
  // Fetch fresh dataset from remote API for production distribution
  await syncAllProducts();
} else {
  // Use fast local mock data in dev server
}
```

### `BASCIK_BUILD_LOG`

When running the CLI with `--log [path]`, `process.env.BASCIK_BUILD_LOG` contains the absolute path to the output log file (defaults to `<cwd>/.bascik/build.log`).

## Unit Testing & Mocking

Because Bascik scripts rely on standard `process.env` properties, writing unit tests for your helper functions is straightforward with Vitest or Node test runner:

```ts
import { describe, it, expect } from 'vitest';
import { getCanonicalUrl } from './canonical.ts';

describe('canonical helper', () => {
  it('generates canonical link from environment variables', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_PAGE_PATH = '/blog/hello-world';

    expect(getCanonicalUrl()).toBe('https://example.com/blog/hello-world');
  });
});
```
