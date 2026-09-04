# Server Scripts

Server scripts let you run Node.js code on each incoming request to personalize pages, query databases, or render user-specific markup. The output is injected directly into the document flow without shipping client-side JavaScript.

## See it in action

This alert box demonstrates dynamic server script execution: in-process Node.js code personalizes content on each request without requiring client-side runtime libraries.

## data-bascik-server

Tag any `<script>` block with `data-bascik-server` to run it at request time on the server. Server scripts execute in-process as Node.js ESM modules. The script returns markup from a default exported function, which replaces the script tag in the rendered page on every request.

```html
<script data-bascik-server>
  export default function (request) {
    const name = request.headers.get('x-display-name') ?? 'Guest';
    return `<p class="greeting">Hello, ${name}!</p>`;
  }
</script>
```

> This example interpolates a header without escaping so the mechanics are visible. Real scripts must escape; see Escaping and injection.

## Handler Signature

Every server script handler uses the standard signature:

```ts
export default async function (request, context, { signal })
```

- `request`: A standard WHATWG [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), identical to API routes. Access `request.method`, `new URL(request.url).pathname`, `new URL(request.url).searchParams.get('page')`, or `request.headers.get('cookie')`. Note that `request.url` carries the real scheme and host of the incoming request. See MDN documentation for [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers), [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL), and [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams).
- `context`: `{ remoteIp }`. This object holds data that has no standard home on `Request`; it is the same shape API routes receive minus `params`.
- `{ signal }`: An [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) triggered when the request times out or the client disconnects.

```html
<script data-bascik-server>
  export default function (request) {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const session = request.headers.get('cookie')?.match(/session=([^;]+)/)?.[1];
    return `<p>Page ${page} &bull; Session: ${session ?? 'anonymous'}</p>`;
  }
</script>
```

## Escaping and injection

The return value of a server script is HTML by contract. Auto-escaping it would render every `<li>` as literal text. So escaping can only ever apply to individual interpolated values.

Which interpolations need escaping, and how, depends on where each one lands:

| Sink | Correct treatment |
| :--- | :--- |
| Text between tags | HTML entity escape (`& < > " '`) |
| Quoted attribute value (`title="..."`) | HTML entity escape |
| Unquoted attribute (`class=...`) | Never do this; quote the attribute |
| `href`, `src`, `action` | Validate the URL: `new URL(v, base)` and allow-list `http:` / `https:`. Entity escaping does not stop `javascript:` |
| Inline `<script>` body | Never interpolate untrusted data. Put it in a `data-*` attribute and read it from a static client script |
| `on*` event handler attributes | Never interpolate untrusted data |
| `<style>` body or `style=""` | Never interpolate untrusted data |
| Already-rendered HTML (Markdown output, CMS rich text) | An HTML sanitizer at the data layer; entity escaping would destroy it |

A framework cannot know which row a given `${x}` is in. A single escaper function is therefore only correct for the first two rows, and shipping it as "the" helper teaches authors that one function makes output safe.

Write this five-line escaper once in your project or install an npm escaper such as `escape-html`:

```ts
// src/lib/server.ts
export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
```

### Trusted vs untrusted data

- **Untrusted data:** Anything from `request` (headers, URL, query parameters, cookies), any database column that was ever user input, and any third-party API response is untrusted.
- **Trusted data:** Markup you wrote directly in the template literal is trusted.

Escape once, at output. Do not store escaped strings.

Bascik exports nothing for use inside a server script. There is no helper to import and nothing is injected into scope. What your script can see is `request`, `context`, `signal`, and whatever you import yourself.

## Timeouts and Cancellation (`AbortSignal`)

Server script execution is bounded by `scripts.timeout` in `bascik.config.ts`. Pass the provided `signal` to `fetch()` or database clients so long-running async calls are canceled automatically when the deadline expires or the client disconnects:

```html
<script data-bascik-server>
  import { escape } from '@/lib/server.ts';

  export default async function (request, context, { signal }) {
    const res = await fetch('https://api.example.com/user', { signal });
    const data = await res.json();
    return `<div class="user-profile">User: ${escape(data.name)}</div>`;
  }
</script>
```

> **Event loop caveat:** Because server scripts run in-process, synchronous blocking code (such as `while(true) {}` or heavy CPU loops) blocks Node's single-threaded event loop and cannot be interrupted by timeouts. Always use asynchronous I/O and standard timers.

## Shared Helper Modules

Create a shared helper file such as `src/lib/server.ts` or `lib/server.mjs` for utilities used across server scripts:

```ts
// src/lib/server.ts
export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function getSessionUser(request: Request): string {
  return request.headers.get('x-user-name') ?? 'Guest';
}
```

Import it from any server script using the `@/` import root alias:

```html
<script data-bascik-server>
  import { escape, getSessionUser } from '@/lib/server.ts';

  export default function (request) {
    const user = escape(getSessionUser(request));
    return `<p>Welcome back, ${user}</p>`;
  }
</script>
```

## Server-Rendered Pagination

Use `new URL(request.url).searchParams` to page through database records without client-side JavaScript:

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escape } from '@/lib/server.ts';

  export default function (request) {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const db = new Database('./data/app.db');
    const items = db.prepare('SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
    const list = items.map(a => `<li>${escape(a.title)}</li>`).join('');
    return `<ul>${list}</ul>`;
  }
</script>
```

## Database Lookups

### SQLite

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escape } from '@/lib/server.ts';

  export default function (request) {
    const sessionId = request.headers.get('cookie')?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return '<p>Not signed in.</p>';
    const db = new Database('./data/app.db');
    const row = db.prepare('SELECT name FROM users WHERE session_id = ?').get(sessionId);
    return row ? `<p>Hello, ${escape(row.name)}</p>` : '<p>Session expired.</p>';
  }
</script>
```

### PostgreSQL

Top-level `await` and ESM imports work seamlessly:

```html
<script data-bascik-server>
  import pg from 'pg';
  import { escape } from '@/lib/server.ts';

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  export default async function (request, context, { signal }) {
    const { rows } = await pool.query('SELECT title FROM posts ORDER BY date DESC LIMIT 10');
    return `<ul>${rows.map(r => `<li>${escape(r.title)}</li>`).join('')}</ul>`;
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
  import { escape } from '@/lib/server.ts';

  export default function (request) {
    const user = escape(request.headers.get('x-display-name') ?? 'Guest');
    return `<p class="greeting">Hello, ${user}</p>`;
  }
</script>
```

## Server Scripts vs API Routes

Both `data-bascik-server` script blocks and [API Routes](/api-routes) run in-process through Bascik's script registry at request time, receiving the same `Request` object, but they serve different architectural purposes:

| Feature | Server Scripts (`data-bascik-server`) | API Routes (`src/api/*.ts`) |
| :--- | :--- | :--- |
| **Destination** | Injected directly into HTML pages | Standalone JSON, streaming, or binary HTTP endpoints |
| **Methods** | GET only (page render) | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD` |
| **Contract** | Takes WHATWG `Request`, returns HTML string | Takes WHATWG `Request`, returns WHATWG `Response` |
| **Response Control** | Cannot set HTTP status code or custom headers | Full control over status codes, response headers, and cookies |
| **Use Cases** | Page personalization, user greetings, auth state in UI | Form submissions, webhook receivers, authenticated REST APIs |

Use `data-bascik-server` when rendering HTML into the document flow. Use API routes when returning data, receiving client submissions, or controlling response headers.

## Rules and Behavior

- A server script must `export default` a function. A script without one is a located build error naming the file and line.
- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are stripped and stored in `dist/.bascik/server-scripts.json`, leaving inert `<script type="text/bascik-server">` placeholders in the static HTML.
- Execution happens when served by `bascik` (dev server) or `bascik --server` (production server).
- On error, `scripts.onServerScriptError` controls behavior: `'error'` responds with HTTP 500, while `'warn'` logs to stderr and replaces the tag with an empty string. Stack traces remap to your original source file line and column.
- Directives (`data-bascik-server`, `data-bascik-stream`, `data-bascik-build`, `data-bascik-routes`) are mutually exclusive and cannot be combined on the same tag.

> **Next:** See [Stream Scripts](/stream-scripts) for chunked streaming scripts (`data-bascik-stream`), or consult the [Production Server](/production-server) reference for server runtime configuration.

<!-- demo:source-usage -->
```html
<script data-bascik-server>
  import { escape } from '@/lib/server.ts';

  export default function (request) {
    const name = escape(request.headers.get('x-display-name') ?? 'Guest');
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
