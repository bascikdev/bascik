# Server Scripts

Server scripts let you run Node.js code on each incoming request to personalize pages, query databases, or render user-specific markup. The output is injected directly into the document flow without shipping client-side JavaScript.

## See it in action

This alert box demonstrates dynamic server script execution: in-process Node.js code personalizes content on each request without requiring client-side runtime libraries.

## data-bascik-server

Tag any `<script>` block with `data-bascik-server` to run it at request time on the server. Server scripts execute in-process as Node.js ESM modules. The script returns markup (or uses a default exported function) which replaces the script tag in the rendered page on every request.

```html
<script data-bascik-server>
  import { escapeHtml } from '@bascik/bascik';

  export default function({ req }) {
    const user = escapeHtml(req.headers['x-display-name'] ?? 'Guest');
    return `<p class="greeting">Hello, ${user}!</p>`;
  }
</script>
```

> **Why `escapeHtml` is explicit:** Bascik does not auto-escape server script output because that would silently break scripts that intentionally emit raw HTML markup. Escaping is explicit, local to your app, and `escapeHtml` is exported directly from `@bascik/bascik`.

## Request Context & Arguments

Every server script handler receives a request context object `{ req }` as its first argument and execution options `{ signal }` as its second argument:

| Field | Type | Description |
| :--- | :--- | :--- |
| `req.path` | `string` | URL path without query string, e.g. `"/dashboard"` |
| `req.method` | `string` | HTTP method in uppercase, e.g. `"GET"` |
| `req.headers` | `object` | Request headers as string-to-string. HTTP/2 pseudo-headers are excluded. |
| `req.searchParams` | `object` | Query parameters as string-to-string, e.g. `{ "page": "2" }` |

```html
<script data-bascik-server>
  export default function({ req }) {
    const page = parseInt(req.searchParams.page ?? '1', 10);
    const session = req.headers['cookie']?.match(/session=([^;]+)/)?.[1];
    return `<p>Page ${page} &bull; Session: ${session ?? 'anonymous'}</p>`;
  }
</script>
```

> **Backward compatibility:** Returning a string from a default export function is the standard pattern. For compatibility with earlier scripts, `console.log()`, `process.stdout.write()`, and `process.env.BASCIK_REQUEST` remain fully supported.

## Timeouts and Cancellation (`AbortSignal`)

Server script execution is bounded by `scripts.timeout` in `bascik.config.ts`. Pass the provided `signal` to `fetch()` or database clients so long-running async calls are canceled automatically when the deadline expires or the client disconnects:

```html
<script data-bascik-server>
  import { escapeHtml } from '@bascik/bascik';

  export default async function({ req }, { signal } = {}) {
    const res = await fetch('https://api.example.com/user', { signal });
    const data = await res.json();
    return `<div class="user-profile">User: ${escapeHtml(data.name)}</div>`;
  }
</script>
```

> **Event loop caveat:** Because server scripts run in-process, synchronous blocking code (such as `while(true) {}` or heavy CPU loops) blocks Node's single-threaded event loop and cannot be interrupted by timeouts. Always use asynchronous I/O and standard timers.

## Shared Helper Modules

Create a shared helper file such as `src/lib/server.ts` or `lib/server.mjs` for utilities used across server scripts:

```ts
// src/lib/server.ts
export { escapeHtml } from '@bascik/bascik';

export function getSessionUser(req: { headers: Record<string, string> }): string {
  return req.headers['x-user-name'] ?? 'Guest';
}
```

Import it from any server script using the `@/` import root alias:

```html
<script data-bascik-server>
  import { escapeHtml, getSessionUser } from '@/lib/server.ts';

  export default function({ req }) {
    const user = escapeHtml(getSessionUser(req));
    return `<p>Welcome back, ${user}</p>`;
  }
</script>
```

## Server-Rendered Pagination

Use `searchParams` to page through database records without client-side JavaScript:

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escapeHtml } from '@bascik/bascik';

  export default function({ req }) {
    const page = Math.max(1, Number(req.searchParams.page ?? 1));
    const db = new Database('./data/app.db');
    const items = db.prepare('SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
    const list = items.map(a => `<li>${escapeHtml(a.title)}</li>`).join('');
    return `<ul>${list}</ul>`;
  }
</script>
```

## Database Lookups

### SQLite

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escapeHtml } from '@bascik/bascik';

  export default function({ req }) {
    const sessionId = req.headers['cookie']?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return '<p>Not signed in.</p>';
    const db = new Database('./data/app.db');
    const row = db.prepare('SELECT name FROM users WHERE session_id = ?').get(sessionId);
    return row ? `<p>Hello, ${escapeHtml(row.name)}</p>` : '<p>Session expired.</p>';
  }
</script>
```

### PostgreSQL

Top-level `await` and ESM imports work seamlessly:

```html
<script data-bascik-server>
  import pg from 'pg';
  import { escapeHtml } from '@bascik/bascik';

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  export default async function({ req }, { signal }) {
    const { rows } = await pool.query('SELECT title FROM posts ORDER BY date DESC LIMIT 10');
    return `<ul>${rows.map(r => `<li>${escapeHtml(r.title)}</li>`).join('')}</ul>`;
  }
</script>
```

## Combining Build and Server Scripts

`<script data-bascik-build>` and `<script data-bascik-server>` compose cleanly on the same page:

```html
<!-- runs once at build time: static navigation -->
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  const links = JSON.parse(await readFile('./data/nav.json', 'utf8'));
  console.log(links.map(l => `<a href="${l.href}">${l.label}</a>`).join(''));
</script>

<!-- runs on every request: personalized greeting -->
<script data-bascik-server>
  import { escapeHtml } from '@bascik/bascik';

  export default function({ req }) {
    const user = escapeHtml(req.headers['x-display-name'] ?? 'Guest');
    return `<p class="greeting">Hello, ${user}</p>`;
  }
</script>
```

## Server Scripts vs API Routes

Both `data-bascik-server` script blocks and [API Routes](/api-routes) run in-process through Bascik's script registry at request time, but they serve different architectural purposes:

| Feature | Server Scripts (`data-bascik-server`) | API Routes (`src/api/*.ts`) |
| :--- | :--- | :--- |
| **Destination** | Injected directly into HTML pages | Standalone JSON, streaming, or binary HTTP endpoints |
| **Methods** | GET only (page render) | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD` |
| **Contract** | Returns HTML string markup | Takes WHATWG `Request` and returns WHATWG `Response` |
| **Response Control** | Cannot set HTTP status code or custom headers | Full control over status codes, response headers, and cookies |
| **Use Cases** | Page personalization, user greetings, auth state in UI | Form submissions, webhook receivers, authenticated REST APIs |

Use `data-bascik-server` when rendering HTML into the document flow. Use API routes when returning data, receiving client submissions, or controlling response headers.

## Rules and Behavior

- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are stripped and stored in `dist/.bascik/server-scripts.json`, leaving inert `<script type="text/bascik-server">` placeholders in the static HTML.
- Execution happens when served by `bascik` (dev server) or `bascik --server` (production server).
- On error, `scripts.onServerScriptError` controls behavior: `'error'` responds with HTTP 500, while `'warn'` logs to stderr and replaces the tag with an empty string. Stack traces remap to your original source file line and column.
- Directives (`data-bascik-server`, `data-bascik-stream`, `data-bascik-build`, `data-bascik-routes`) are mutually exclusive and cannot be combined on the same tag.

> **Next:** See [Stream Scripts](/stream-scripts) for chunked streaming scripts (`data-bascik-stream`), or consult the [Production Server](/production-server) reference for server runtime configuration.

<!-- demo:source-usage -->
```html
<script data-bascik-server>
  import { escapeHtml } from '@bascik/bascik';

  export default function({ req }) {
    const name = escapeHtml(req.headers['x-display-name'] ?? 'Guest');
    return `
      <aside class="alert-box">
        <strong class="alert-box-title">Session Active</strong>
        <p class="alert-box-message">Logged in as ${name}</p>
      </aside>
    `;
  }
</script>
```

<!-- demo:output-html -->
```html
<!-- The script tag is replaced by its returned markup per request -->
<aside class="alert-box">
  <strong class="alert-box-title">Session Active</strong>
  <p class="alert-box-message">Logged in as Jane Doe</p>
</aside>
```
