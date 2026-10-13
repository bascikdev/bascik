---
name: bascik-scripts
description: Node.js scripts inside Bascik pages and components. Use when writing <script data-bascik-build> (build-time HTML from files, Markdown, JSON, or APIs), <script data-bascik-routes> with [slug].html dynamic routes, <script data-bascik-server> or <script data-bascik-stream> for per-request rendering, API routes in src/api/, @/ import aliases, BASCIK_* environment variables, the build script cache, or escaping untrusted output.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Bascik Scripts

Bascik runs Node.js code inside special `<script>` tags. Each is a standard ESM module whose default export returns an HTML string that replaces the tag. Requires the `bascik` skill for project basics.

## Pick the right tag

| Need | Tag | Runs |
|---|---|---|
| HTML from files, Markdown, JSON, or an API, the same for every visitor | `data-bascik-build` | Build and dev, once per page compile (cached) |
| Many pages from one `[param].html` template | `data-bascik-routes` | Build and dev startup |
| Markup that depends on the request (cookies, headers, query) | `data-bascik-server` | Every request, before the response starts |
| A slow per-request block that should not delay the page shell | `data-bascik-stream` | Every request, streamed in document order |
| A JSON or HTTP endpoint | `src/api/<name>.ts` exporting `GET`, `POST`, ... | Every request |

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
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';

  export default async function () {
    const md = await readFile('./content/intro.md', 'utf8');
    return marked(md);
  }
</script>
```

- Runs before component resolution, so the returned HTML may contain component tags and is scoped like the surrounding template.
- Each uncached script runs in its own child process (about 50 to 150 ms). Output is cached on disk in `node_modules/.cache/bascik/script-cache/`.
- **Cache gotcha:** the cache key covers the script, its statically referenced local files, installed package versions, the page path, site URL, and base. It cannot see network responses, `readdir` results, or computed paths. Exclude scripts that read remote or directory data with `scripts.cache.exclude`, and declare environment variables a script reads in `scripts.cache.environment`.
- **Fetch once:** read data once per page in one script, then feed it to the parts that need it, instead of fetching per component instance.
- Errors follow `scripts.onBuildScriptError` (`'error'` by default): dev shows the error on that page and keeps serving; `--build` fails.

Per-page values come from environment variables: `BASCIK_PAGE_PATH` (`/about`), `BASCIK_PAGE_FILE`, `BASCIK_SOURCE_FILE`, `BASCIK_PAGES_DIR`, `BASCIK_BUILD` (`"1"` in `--build`), `BASCIK_SITE_URL` (absent when unset), `BASCIK_BASE`, and `BASCIK_ROUTE` (dynamic routes). Details, caching, Markdown styling, and page-aware head tags: [references/build-scripts.md](references/build-scripts.md).

## Dynamic routes

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-routes>
  import { listPosts } from '@/lib/posts.ts';
  export default async function () {
    const posts = await listPosts();
    return posts.map((post) => ({ params: { slug: post.slug }, data: post }));
  }
</script>
<script data-bascik-build>
  import { escapeHtml } from '@/lib/escape.ts';
  export default function () {
    const { data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
    return `<h1>${escapeHtml(data.title)}</h1>`;
  }
</script>
```

Every bracket name needs a matching `params` key; a param cannot contain `/` (use one template per depth). Use `src/pages/blog/[slug]/index.html` for trailing-slash URLs. Never generate page files into `src/pages/`. Details: [references/dynamic-routes.md](references/dynamic-routes.md).

## Server and stream scripts

```html
<script data-bascik-server>
  import { escapeHtml } from '@/lib/escape.ts';
  export default function (request, context, { signal }) {
    const name = escapeHtml(request.headers.get('x-display-name') ?? 'Guest');
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
  if (!data.name) return Response.json({ error: 'name is required' }, { status: 400 });
  return Response.json({ ok: true }, { status: 201 });
};
```

Unexported methods return 405 with an `Allow` header; `HEAD` derives from `GET`; `OPTIONS` is automatic. Handlers receive `(request, { params, remoteIp, platform }, { signal })`. Details, escaping rules, and streaming: [references/request-scripts.md](references/request-scripts.md).

## Look it up

```sh
node <skills-dir>/bascik/scripts/read-doc.mjs /build-scripts
node <skills-dir>/bascik/scripts/read-doc.mjs /script-imports
node <skills-dir>/bascik/scripts/search-docs.mjs "server script timeout"
```

## References

- [references/build-scripts.md](references/build-scripts.md): environment variables, cache keys and exclusions, Markdown, page-aware scripts, `data-bascik-dev`, error output
- [references/dynamic-routes.md](references/dynamic-routes.md): `data-bascik-routes` rules, params, collisions, sitemap
- [references/request-scripts.md](references/request-scripts.md): `data-bascik-server`, `data-bascik-stream`, API routes, escaping, module lifetime
