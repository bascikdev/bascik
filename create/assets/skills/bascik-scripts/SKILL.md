---
name: bascik-scripts
description: Node.js scripts inside Bascik pages and components. Use when writing <script data-bascik-build> (build-time HTML from files, Markdown, JSON, or APIs), <script data-bascik-routes> with [slug].html dynamic routes, <script data-bascik-server> or <script data-bascik-stream> for per-request rendering, API routes in src/api/, @/ import aliases, BASCIK_* environment variables, the build script cache, escaping untrusted output, or a blog or other Markdown collection with front matter, tags, drafts, and a feed. Includes a new-post script.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Bascik Scripts

Bascik runs Node.js code inside special `<script>` tags. Each is a standard ESM module whose default export returns an HTML string that replaces the tag. Requires the `bascik` skill for project basics.

## Pick the right tag

| Need                                                                   | Tag                                              | Runs                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| HTML from files, Markdown, JSON, or an API, the same for every visitor | `data-bascik-build`                              | Build and dev, once per page compile (cached) |
| Many pages from one `[param].html` template                            | `data-bascik-routes`                             | Build and dev startup                         |
| Markup that depends on the request (cookies, headers, query)           | `data-bascik-server`                             | Every request, before the response starts     |
| A slow per-request block that should not delay the page shell          | `data-bascik-stream`                             | Every request, streamed in document order     |
| A JSON or HTTP endpoint                                                | `src/api/<name>.ts` exporting `GET`, `POST`, ... | Every request                                 |

Prefer build-time work. Server, stream, and API code needs `bascik --server` (or a serverless target such as Cloudflare); a plain static host cannot run it.

## Rules for every Node-side script

1. **Export a default function that returns an HTML string.** `console.log()` output goes to the terminal only; it never becomes markup.
2. **One directive per tag.** Combining `data-bascik-build`, `-routes`, `-server`, or `-stream` is a hard error.
3. **Imports:** top-level `import` and `await` work. Use `@/` for shared helpers: `import { renderMd } from '@/lib/md.ts'` resolves against `scripts.importRoot` (default `src`) from any depth. `./` and `../` resolve against the file containing the script. Bare npm packages work.
4. **Never import with a bare leading `/`.** `import x from '/lib/x.ts'` and `src="/lib/x.ts"` are hard errors. Use `@/lib/x.ts` or `./lib/x.ts`.
5. **Helpers import helpers with relative paths.** `@/` is rewritten only inside script tags; a `.ts` helper that imports another helper uses `./other.ts` (with the extension) and `import type` for type-only imports. tsconfig `paths` do not apply.
6. **Data paths are relative to the project root.** `readFile('./content/post.md')` resolves from `process.cwd()`, not from the page.
7. **Watch helpers.** Add `src/lib/` and data folders such as `content/` to `pipeline.watchPaths` so edits rebuild dependent pages in dev.
8. **Escape everything you interpolate.** Template strings do not escape. Write a small escaper in `src/lib/` or install `escape-html`; sanitize CMS or user HTML with an allowlist (for example `sanitize-html`).
9. **Directives in output never run.** If a script prints another `data-bascik-*` script, it is removed with a warning. Printed component tags do expand.

## Build scripts

```html
<script data-bascik-build>
  import { readFile } from "node:fs/promises";
  import { marked } from "marked";

  export default async function () {
    const md = await readFile("./content/intro.md", "utf8");
    return marked(md);
  }
</script>
```

- Runs before component resolution, so the returned HTML may contain component tags and is scoped like the surrounding template.
- Each uncached script runs in its own child process (about 50 to 150 ms). Output is cached on disk in `node_modules/.cache/bascik/script-cache/`.
- **Cache gotcha:** the cache key covers the script, its statically referenced local files, installed package versions, the page path, site URL, and base. It cannot see network responses, `readdir` results, or computed paths. Exclude scripts that read remote or directory data with `scripts.cache.exclude`, and declare environment variables a script reads in `scripts.cache.environment`.
- **Fetch once:** read data once per page in one script, then feed it to the parts that need it, instead of fetching per component instance.
- **Component gotcha:** a build script inside a component runs once for the whole site unless it is page-aware. If it calls a helper that reads `BASCIK_PAGE_PATH` (canonical URLs, active nav links), write `<script data-bascik-build="page">`. The value must be exactly `page`; `"pages"` runs once, and the linter reports it as `unknown-directive-value` (in the editor, and in `bascik --check` when `@bascik/language-server` is installed).
- Errors follow `scripts.onBuildScriptError` (`'error'` by default): dev shows the error on that page and keeps serving; `--build` fails.

Per-page values come from environment variables: `BASCIK_PAGE_PATH` (`/about`), `BASCIK_PAGE_FILE`, `BASCIK_SOURCE_FILE`, `BASCIK_PAGES_DIR`, `BASCIK_BUILD` (`"1"` in `--build`), `BASCIK_SITE_URL` (absent when unset), `BASCIK_BASE`, and `BASCIK_ROUTE` (dynamic routes). Details: `read-doc.mjs /build-scripts`, `/environment-variables`, `/how-to/page-aware-scripts`.

## Dynamic routes

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-routes>
  import { listPosts } from "@/lib/posts.ts";
  export default async function () {
    const posts = await listPosts();
    return posts.map((post) => ({ params: { slug: post.slug }, data: post }));
  }
</script>
<script data-bascik-build>
  import { escapeHtml } from "@/lib/escape.ts";
  export default function () {
    const { data } = JSON.parse(process.env.BASCIK_ROUTE || "{}");
    return `<h1>${escapeHtml(data.title)}</h1>`;
  }
</script>
```

Every bracket name needs a matching `params` key; a param cannot contain `/` (use one template per depth). Use `src/pages/blog/[slug]/index.html` for trailing-slash URLs. Never generate page files into `src/pages/`. Details: `read-doc.mjs /dynamic-routes`.

## Server and stream scripts

```html
<script data-bascik-server>
  import { escapeHtml } from "@/lib/escape.ts";
  export default function (request, context, { signal }) {
    const name = escapeHtml(request.headers.get("x-display-name") ?? "Guest");
    return `<p>Welcome, ${name}!</p>`;
  }
</script>
```

- `request` is a standard WHATWG `Request`; `context` is `{ remoteIp }`; `signal` aborts on timeout or disconnect.
- All `server` scripts resolve before any byte is sent. Swap to `data-bascik-stream` when the shell should paint first; a stream failure renders an empty slot instead of a 500.
- Source is moved to `dist/.bascik/server-scripts.json`; static `dist/` keeps an inert placeholder. They never run during `--build`.
- Never block the event loop with synchronous work; timeouts cannot interrupt it.

## API routes

```ts
// src/api/contact.ts  ->  POST /api/contact
export const POST = async (request: Request): Promise<Response> => {
  const data = await request.json();
  if (!data.name)
    return Response.json({ error: "name is required" }, { status: 400 });
  return Response.json({ ok: true }, { status: 201 });
};
```

Unexported methods return 405 with an `Allow` header; `HEAD` derives from `GET`; `OPTIONS` is automatic. Handlers receive `(request, { params, remoteIp, platform }, { signal })`. Details: `read-doc.mjs /api-routes`, `/server-scripts`, `/stream-scripts`. A handler that accepts both JSON and a no-JavaScript form post: `add-example.mjs starter-site/src/api/contact.ts`.

## Blogs and Markdown collections

There is no content API. A collection is a folder such as `content/posts/`, one helper in `src/lib/` that reads, validates, and sorts it, and pages that call the helper. Copy a working blog instead of writing one: `add-example.mjs starter-site/src/lib/posts.ts starter-site/src/pages/blog starter-site/scripts/feed.ts`, then merge the starter's `bascik.config.ts` settings.

1. **One reader.** Every page, the feed, and a home page "latest posts" list call the same helper.
2. **Fail loudly.** Validate front matter in the helper and throw with the file name, so a bad post fails `bascik --build`.
3. **Exclude every page that lists the folder from the cache** (`scripts.cache.exclude`), because the cache cannot see `readdir`; otherwise new posts do not appear. Add `content/` and `src/lib/` to `pipeline.watchPaths`.
4. **Dates stay `YYYY-MM-DD` strings** in route data, formatted with `timeZone: 'UTC'`.
5. **Drafts** are skipped when `process.env.BASCIK_BUILD === '1'`.
6. **Escape front matter values; sanitize Markdown from a CMS or users.** Your own repository's Markdown is trusted.
7. **Style rendered Markdown from a global stylesheet** (`.prose h2`). In a component, element selectors never match generated or slotted HTML.
8. **Feeds and other files are `post` exec scripts** that write to `BASCIK_OUT_DIR` and need `BASCIK_SITE_URL` for absolute URLs.

```sh
node <skills-dir>/bascik-scripts/scripts/new-post.mjs "Launching the new site" --tags news,release --description "What changed and why."
```

Details: `read-doc.mjs /how-to/markdown`, and the working blog in `add-example.mjs starter-site/src/pages/blog`.

## Look it up

| How do I...                                                | Read                                                |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Import helpers, use `@/`, or load TypeScript               | `/script-imports`                                   |
| Read the page's own path or source, set per-page head tags | `/how-to/page-aware-scripts`                        |
| Render Markdown, front matter, a collection                | `/how-to/markdown`                                  |
| Bundle npm packages for the browser                        | `/how-to/bundling-npm-packages`                     |
| Run scripts before or after the build                      | `/exec-scripts`                                     |
| Rebuild on changes outside pages and components            | `/watch-paths`                                      |
| Test build and server scripts                              | `/testing/build-scripts`, `/testing/server-scripts` |

`node <skills-dir>/bascik/scripts/read-doc.mjs <path>` prints any of these; `search-docs.mjs "server script timeout"` searches them.
