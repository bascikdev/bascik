# Environment Variables

Bascik automatically populates a collection of dedicated environment variables for your scripts: build scripts, dynamic route generators, and exec scripts get them in their own processes, and server and stream scripts read them from the server's environment. These variables give your scripts direct access to the active page path, filesystem locations, site configuration, dynamic route parameters, and compiler execution modes without requiring manual configuration or boilerplate.

You access these variables using standard Node.js `process.env.<VARIABLE_NAME>`. [Environment variables](/scripts#environment-variables) on the scripts overview shows which ones each kind of script gets.

## Environment Variable Reference

| Variable             | Available In                                                                       | Description                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASCIK_PAGE_PATH`   | `data-bascik-build`, `data-bascik-routes`                                          | Normalized root-relative URL path for the page being transpiled (e.g. `/getting-started`, `/switch/from-vue`, `/`, `/blog/hello-world`).                                     |
| `BASCIK_SOURCE_FILE` | `data-bascik-build`, `data-bascik-routes`                                          | Absolute filesystem path to the file currently executing the script (points to the component template in components, or the page file in pages).                             |
| `BASCIK_PAGE_FILE`   | `data-bascik-build`, `data-bascik-routes`                                          | Absolute filesystem path to the top-level HTML page shell currently being compiled. Always points to the page shell even when inside nested components.                      |
| `BASCIK_SITE_URL`    | `data-bascik-build`, `data-bascik-routes`, exec scripts, server and stream scripts | The site URL resolved from `--site-url`, the `BASCIK_SITE_URL` environment variable, or a `.env` file (e.g. `https://bascik.dev`). Absent when unset, never an empty string. |
| `BASCIK_PAGES_DIR`   | `data-bascik-build`, `data-bascik-routes`, exec scripts                            | Absolute filesystem path to the configured pages directory (`directory.pages`, defaults to `<root>/src/pages`).                                                              |
| `BASCIK_BASE`        | `data-bascik-build`, exec scripts                                                  | The normalized [`base`](/configuration#base) deployment prefix, always present (defaults to `/`).                                                                            |
| `BASCIK_OUT_DIR`     | Exec scripts                                                                       | Absolute filesystem path to the configured output directory (`directory.out`, defaults to `<root>/dist`).                                                                    |
| `BASCIK_ROUTE`       | `data-bascik-build` (dynamic routes)                                               | JSON string of `{ params, data }` for the current route instance in parameterized page templates like `[slug].html`.                                                         |
| `BASCIK_BUILD`       | All scripts, worker threads, and exec scripts                                      | `"1"` when running static compilation (`bascik --build`), `"0"` during local development (`bascik`).                                                                         |
| `BASCIK_SERVER`      | Server and stream scripts, worker threads                                          | `"1"` when running the production server (`bascik --server`), `"0"` otherwise.                                                                                               |
| `BASCIK_BUILD_LOG`   | CLI runtime                                                                        | Absolute filesystem path to the build log destination when invoked with `--log`.                                                                                             |

`data-bascik-build-once` scripts do not receive page or route context, because their output is shared wherever the file is used. `BASCIK_SOURCE_FILE` names the file the script is written in; `BASCIK_PAGE_FILE` and `BASCIK_PAGE_PATH` are empty, and `BASCIK_ROUTE` is unset.

## Build-Time Scripts (`data-bascik-build`)

Every `<script data-bascik-build>` block runs inside an isolated Node.js child process with access to page, file, and configuration variables. A build script in a component runs when that component is expanded into a page, so it receives that page's context for each use.

### `BASCIK_PAGE_PATH`

The normalized root-relative URL path corresponding to the page being generated.

- `src/pages/index.html` → `/`
- `src/pages/getting-started.html` → `/getting-started`
- `src/pages/blog/index.html` → `/blog/`
- `src/pages/blog/[slug].html` with param `{ slug: 'first-post' }` → `/blog/first-post`

```ts
// Example: Active navigation link detection
const currentPath = process.env.BASCIK_PAGE_PATH;
const isCurrent = currentPath === "/components";
```

Component scripts can read this variable directly or through an imported helper; they always run in the context of the page that uses the component.

This applies to `data-bascik-build`. A `data-bascik-build-once` script has no page path, because one run serves every use of a component and every route of a dynamic template; use it only when its output is identical everywhere. [Why there is no page path](/scripts/build#why-there-is-no-page-path) shows what would go wrong otherwise.

### `BASCIK_SOURCE_FILE` vs `BASCIK_PAGE_FILE`

When a build script runs directly inside a page (`src/pages/about.html`), both `BASCIK_SOURCE_FILE` and `BASCIK_PAGE_FILE` point to `/absolute/path/to/src/pages/about.html`.

When a component (`src/components/author-bio/author-bio.html`) contains a build script, the variables provide distinct locations:

- `BASCIK_SOURCE_FILE`: The path to the component file `/absolute/path/to/src/components/author-bio/author-bio.html`.
- `BASCIK_PAGE_FILE`: The path to the page shell importing the component `/absolute/path/to/src/pages/about.html`.

```ts
import { readFile } from "node:fs/promises";

// Read metadata directly from the page shell that included this component
const pageMarkup = await readFile(process.env.BASCIK_PAGE_FILE!, "utf8");
```

### `BASCIK_SITE_URL` and `BASCIK_PAGES_DIR`

`BASCIK_SITE_URL` provides the deployment origin set via `--site-url`, the environment, or a `.env` file. When none of them sets it, the variable is absent rather than an empty string, so `"BASCIK_SITE_URL" in process.env` tells the two apart. `BASCIK_PAGES_DIR` provides the resolved directory containing page templates. Together with `BASCIK_PAGE_PATH`, they enable automatic canonical URL and structured data generation:

```ts
// src/lib/canonical.ts
export function getCanonicalUrl(): string {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? "").replace(/\/$/, "");
  const path = process.env.BASCIK_PAGE_PATH ?? "/";
  return siteUrl ? `${siteUrl}${path}` : path;
}
```

### `BASCIK_BASE`

Bascik forwards the normalized [`base`](/configuration#base) config value to every build script and exec script as `BASCIK_BASE`. It is always present and defaults to `/`. This is useful when build output must expose the deployment prefix to client code, because Bascik deliberately does not rewrite URLs assembled inside JavaScript:

```html
<!-- src/pages/index.html: emit the base at build time into a data attribute. In a component on every page, use data-bascik-build-once. -->
<script data-bascik-build>
  export default () => `data-base="${process.env.BASCIK_BASE ?? "/"}"`;
</script>
```

Client code can read the emitted data attribute and prefix a runtime URL.

### `BASCIK_ROUTE`

When rendering dynamic pages from parameterized templates (such as `src/pages/posts/[slug].html`), Bascik executes the page once for each route returned by `<script data-bascik-routes>`. During each execution, `BASCIK_ROUTE` contains the JSON-serialized route context:

```html
<!-- src/pages/posts/[slug].html -->
<script data-bascik-build>
  import { html, raw } from "@bascik/bascik/html";

  export default function () {
    const { params, data } = JSON.parse(process.env.BASCIK_ROUTE);
    // contentHtml is rendered from your own Markdown, so raw() inserts it as it is.
    return html`<h1>${params.slug}</h1>
      <article>${raw(data.contentHtml)}</article>`;
  }
</script>
```

> **Dynamic Route Safety.** `process.env.BASCIK_ROUTE` is only defined when transpiling dynamic routes. For static pages, the variable is omitted from the environment.

> **Large payloads.** `data` can be any size, such as a whole post body. Above 32 KB, Bascik passes the value through a temporary file and sets `process.env.BASCIK_ROUTE` before your script and its imports run, so reading it is unchanged. Returning `data.contentHtml` from a CMS places that HTML in the page as is; sanitize it first (see [Printing HTML You Did Not Write](/scripts/build#printing-html-you-did-not-write)).

## Dynamic Route Scripts (`data-bascik-routes`)

`<script data-bascik-routes>` blocks execute once during discovery to generate the list of parameters and optional data for route expansion.

```html
<!-- src/pages/products/[category]/[id].html -->
<script data-bascik-routes>
  export default async function () {
    // Access template file location and pages directory
    const templatePath = process.env.BASCIK_SOURCE_FILE;

    const routes = await fetchProductManifest();
    return routes;
  }
</script>
```

Dynamic route scripts receive:

- `BASCIK_SOURCE_FILE` and `BASCIK_PAGE_FILE`: Path to the template file.
- `BASCIK_PAGE_PATH`: Raw template route path (e.g. `/products/[category]/[id]`).
- `BASCIK_PAGES_DIR`: Absolute pages directory.
- `BASCIK_SITE_URL`: Configured site URL.
- `BASCIK_BUILD`: `"1"` in build mode, `"0"` in dev mode.

## Server and Stream Scripts (`data-bascik-server`, `data-bascik-stream`)

Server and stream scripts run inside the server that answers the request, so `process.env` is that server's environment: your shell, `./.env` (or the file passed to `--env-file`), and these Bascik variables:

- `BASCIK_SERVER`: `"1"` under the production server (`bascik --server`), `"0"` on the dev server.
- `BASCIK_BUILD`: `"0"`, because no build is running.
- `BASCIK_SITE_URL`: the configured site URL, when one is set.

They get no page variables (`BASCIK_PAGE_PATH`, `BASCIK_PAGE_FILE`, `BASCIK_ROUTE`): the same process serves every page, so read the page from `request.url` instead. This is where secrets belong, such as a `DATABASE_URL` or an API token, because a value a server script reads never reaches the browser unless the script returns it.

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default async function (request, context, { signal }) {
    const response = await fetch("https://api.example.com/stock", {
      headers: { authorization: `Bearer ${process.env.STOCK_API_TOKEN}` },
      signal,
    });
    const { count } = await response.json();
    return html`<p>${count} in stock</p>`;
  }
</script>
```

On Cloudflare Workers, Bascik does not fill `process.env`. Read secrets and bindings from `context.platform.env` instead; see [Bindings and secrets](/deployment/cloudflare#bindings-and-secrets). On Netlify, environment variables stay in `process.env`.

## Compiler & Runtime Flags

### `BASCIK_BUILD`

Set to `"1"` when running static site compilation (`bascik --build`), and `"0"` when running the local development server (`bascik`).

Use `BASCIK_BUILD` to skip heavy computations or live API queries during fast local development while enforcing full generation during production builds:

```ts
const isBuild = process.env.BASCIK_BUILD === "1";

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
import { describe, it, expect } from "vitest";
import { getCanonicalUrl } from "./canonical.ts";

describe("canonical helper", () => {
  it("generates canonical link from environment variables", () => {
    process.env.BASCIK_SITE_URL = "https://example.com";
    process.env.BASCIK_PAGE_PATH = "/blog/hello-world";

    expect(getCanonicalUrl()).toBe("https://example.com/blog/hello-world");
  });
});
```
