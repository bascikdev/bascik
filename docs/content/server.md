# Production Server

Bascik generates static output, HTML, CSS, and JS that a CDN or any file server can deliver. You only need `bascik --serve` when you want **per-request dynamic content**: personalized dashboards, user-specific data, server-rendered pagination, or anything that must be different for each visitor.

The mechanism is `data-bascik-server`: a script tag that runs on the server on every request and injects its stdout into the page. Everything else, layout, navigation, styles, components, is still compiled at build time. You get the performance of static assets with the flexibility of server-rendered sections exactly where you need them.

```sh
bascik --build   # compile to dist/ (static assets)
bascik --serve   # start the production HTTP server; runs data-bascik-server scripts per request
```

If your site has no `data-bascik-server` scripts, you do not need `bascik --serve`: any static host will do.

## Server scripts: `data-bascik-server`

Tag a `<script>` block with `data-bascik-server` to run it at **request time** on the server instead of at build time. The script's stdout is injected into the page in place of the script tag, on every request.

```html
<script data-bascik-server>
  const req = JSON.parse(process.env.BASCIK_REQUEST);
  const name = (req.headers['x-display-name'] ?? 'Guest')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  console.log(`<p>Welcome, ${name}!</p>`);
</script>
```

This lets you personalize pages per visitor, reading session cookies, querying a database, or rendering content based on query parameters, without a full server framework.

### Request context

Every server script receives `process.env.BASCIK_REQUEST`, a JSON string with four fields:

| Field | Type | Description |
| --- | --- | --- |
| `path` | `string` | URL path without the query string, e.g. `"/about"` |
| `method` | `string` | HTTP method in uppercase, e.g. `"GET"` |
| `headers` | `object` | Request headers as string-to-string. HTTP/2 pseudo-headers (`:path`, `:method`, etc.) are excluded. |
| `searchParams` | `object` | Query parameters as string-to-string, e.g. `{ "page": "2" }` |

```html
<script data-bascik-server>
  const { path, method, headers, searchParams } = JSON.parse(process.env.BASCIK_REQUEST);

  const page = parseInt(searchParams.page ?? '1', 10);
  const sessionId = headers['cookie']?.match(/session=([^;]+)/)?.[1];

  console.log(`<p>Page ${page} - session: ${sessionId ?? 'none'}</p>`);
</script>
```

### Using top-level `await` and `import`

Server scripts are run as Node.js ESM modules. Both top-level `await` and top-level `import` work:

```html
<script data-bascik-server>
  import { readFile } from 'node:fs/promises';

  const { path } = JSON.parse(process.env.BASCIK_REQUEST);
  const slug = path.split('/').pop();
  const content = await readFile(`./data/${slug}.json`, 'utf8');
  const { title, body } = JSON.parse(content);

  console.log(`<h1>${title}</h1><p>${body}</p>`);
</script>
```

The script's working directory is your project root (`process.cwd()`), so relative file paths work as expected.

### Combining build and server scripts

`data-bascik-build` and `data-bascik-server` are independent and compose freely on the same page:

```html
<!-- runs once at build time: injects a static nav from a data file -->
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  const links = JSON.parse(await readFile('./data/nav.json', 'utf8'));
  console.log(links.map(l => `<a href="${l.href}">${l.label}</a>`).join(''));
</script>

<!-- runs on every request: greets the signed-in user -->
<script data-bascik-server>
  const { headers } = JSON.parse(process.env.BASCIK_REQUEST);
  const user = headers['x-display-name'] ?? 'Guest';
  console.log(`<p class="greeting">Hello, ${user}</p>`);
</script>
```

### Rules and behavior

- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are **preserved as-is** in `dist/` and are NOT executed. Execution only happens when the page is served.
- On error, Bascik logs an error or warning to stderr and replaces the script tag with an empty string rather than aborting the request. Stack traces are remapped back to the original source HTML file and line offset (for example, `src/pages/dashboard.html:25`) so clicking the terminal reference opens your source file at the exact failure line.
- The script tag (including all its attributes and the closing `</script>` tag) is completely replaced by stdout output. Empty stdout means the tag slot becomes an empty string.
- Anything written to stderr from within the script is forwarded to the server's stderr.

### Escaping user-controlled output

The output of a server script is injected as raw HTML, so values from headers, cookies, query params, or database rows must be HTML-escaped before they are written to `stdout`. Bascik does not escape your output for you automatically, because that would get in the way of normal raw HTML output.

Use a small helper in your own script, or keep it inline if you only need it once.

```html
<script data-bascik-server>
  const { headers, searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const name = escapeHtml(headers['x-display-name'] ?? 'Guest');
  const tab = escapeHtml(searchParams.tab ?? 'overview');
  console.log(`<p>Hello ${name} - tab: ${tab}</p>`);
</script>
```

This keeps the escape logic explicit, local, and easy to customize for your app.

## Practical examples

> **Escape user-controlled output.** Any value from a request (cookies, query params, headers, database rows) must be HTML-escaped before writing with `console.log`. Keep the helper in your server script, or import a shared one, instead of relying on a hidden global.

### Reading request context

```html
<script data-bascik-server>
  const { headers, searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const user = escapeHtml(headers['x-display-name'] ?? 'Guest');
  const tab = escapeHtml(searchParams.tab ?? 'overview');
  console.log(`<p>Hello ${user} - tab: ${tab}</p>`);
</script>
```

### Querying a database

Read a session cookie, look up the user in SQLite, and render a greeting.

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  const { headers } = JSON.parse(process.env.BASCIK_REQUEST);
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sessionId = headers['cookie']?.match(/session=([^;]+)/)?.[1];
  const db = new Database('./data/app.db');
  const user = sessionId && db.prepare('SELECT name FROM users WHERE session_id = ?').get(sessionId);
  console.log(user ? `<p>Hello, ${escapeHtml(user.name)}</p>` : '<p>Not signed in.</p>');
</script>
```

### Paginating results

Use `searchParams` to drive server-rendered pagination with no client-side JavaScript needed.

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  const { searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const page = Math.max(1, Number(searchParams.page ?? 1));
  const db = new Database('./data/app.db');
  const items = db.prepare('SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
  console.log(`<ul>${items.map(a => `<li>${escapeHtml(a.title)}</li>`).join('')}</ul>`);
</script>
```

### Using PostgreSQL

For a Postgres database, use the `pg` client. Top-level `await` makes async queries straightforward. Postgres uses numbered parameters (`$1`, `$2`, etc.) in query strings.

```sh
npm install pg
```

```html
<script data-bascik-server>
  import pg from 'pg';
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await db.query('SELECT title FROM articles ORDER BY created_at DESC LIMIT 10');
  await db.end();
  console.log(`<ul>${rows.map(r => `<li>${escapeHtml(r.title)}</li>`).join('')}</ul>`);
</script>
```

> **Connection pooling.** Each `data-bascik-server` block runs in a fresh Node.js child process, so in-process pools cannot be shared across requests. For production Postgres use an external pooler such as [PgBouncer](https://www.pgbouncer.org/).

## Server configuration

Configure the production server in `bascik.config.ts` under the `prodServer` key.

```ts
// bascik.config.ts
export default {
  cacheHttp: true,     // default in --serve; false in dev
  prodServer: {
    port: 8080,         // default (8080 for HTTP, 8443 for HTTPS)
    hostname: 'localhost',  // default; use '0.0.0.0' to bind all interfaces
    enableTls: false,   // default; set to true for encrypted HTTP/2 (HTTPS)
    keyFile: 'bascik-privkey.pem',  // path to your TLS private key when enableTls: true
    certFile: 'bascik-cert.pem',    // path to your TLS certificate when enableTls: true
    logging: {
      level: 'info',   // silent | error | warn | info | debug
      requests: true,  // log each request line
    },
  },
};
```

The `prodServer.logging.level` setting controls the request log threshold, and `requests: false` disables the per-request `GET / ...` lines without suppressing warnings or errors.

Bascik increments the port automatically if the preferred port is already in use.

`cacheHttp` defaults to `true` in `--serve` mode and `false` in the dev server. When `true`, pages receive `ETag` headers and the server returns `304 Not Modified` when a client's cached copy is still fresh. Static assets also get `Cache-Control: public, max-age=3600`. Set `cacheHttp: false` to disable all of this if you are behind a CDN that manages caching itself.

## URL routing

Both the dev server and `bascik --serve` strip the `.html` extension and serve pages at the bare path. A file compiled to `dist/about.html` is available at `/about`, and `dist/blog/post.html` is available at `/blog/post`. The root page (`dist/index.html`) maps to `/`.

Requests for a path that has no matching page fall through to the `404` page if one exists (`dist/404.html`), otherwise the server returns a plain `404 Not Found`.

## What `--serve` does differently from `--build`

| Capability | `bascik --build` | `bascik --serve` |
| --- | --- | --- |
| Transpile pages to `dist/` | ✓ | ✕ (reads existing `dist/`) |
| Watch source files for changes | ✕ | ✕ |
| Live-reload SSE | ✕ | ✕ |
| Built-in HTTP server | ✕ | ✓ |
| Brotli compression | ✕ | ✓ |
| HTTP caching (ETags, 304) | ✕ | ✓ (default; see `cacheHttp`) |
| Rate limiting | ✕ | ✓ (per-IP) |
| Security response headers | ✕ | ✓ |
| Graceful shutdown | ✕ | ✓ (SIGTERM / SIGINT) |
| `data-bascik-server` scripts | ✕ (preserved) | ✓ (run per-request) |

## Production hardening

The Bascik HTTP server applies several hardening measures. Most of these are active in both the dev server (`bascik`) and the production server (`bascik --serve`); rate limiting is the only protection that is production-only.

### Security response headers

Every response includes these headers:

| Header | Value |
| --- | --- |
| `x-content-type-options` | `nosniff` |
| `x-frame-options` | `SAMEORIGIN` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `permissions-policy` | `interest-cohort=()` |

These are sent on HTML pages, static assets, and error responses in both dev and production. If you are terminating TLS at a proxy and want to add `Strict-Transport-Security`, add it there rather than in Bascik, the proxy already knows the scheme of the outer connection.

### Rate limiting

In `--serve` mode the server enforces a per-IP request limit of **500 requests per 10 seconds** by default. Clients that exceed the limit receive `429 Too Many Requests` with a `Retry-After` header. The limit resets automatically after the window expires. Rate limiting is not active in the dev server, and can be disabled on the production server by setting `prodServer: { rateLimit: false }` in `bascik.config.ts`.

### Graceful shutdown

The server listens for `SIGTERM` and `SIGINT` in both dev and production. On either signal it stops accepting new connections, destroys open HTTP/2 sessions (if running in HTTPS mode) and live-reload SSE connections, and exits once in-flight requests finish. If draining takes longer than 10 seconds, the process force-exits. This means `systemd` stop, `docker stop`, and Kubernetes pod eviction all wait for requests to complete before the process ends.

### Path traversal protection

Static asset URLs (requests with a file extension) are validated so the resolved path always stays inside the `dist/` directory. Requests that would escape it, via `/../` sequences or similar, receive `400 Bad Request` before any file I/O occurs. This applies in both dev and production.

## TLS certificates

On first start, Bascik looks for `bascik-cert.pem` and `bascik-privkey.pem` in the project root. If either is missing, it generates both automatically:

1. **mkcert:** preferred. Produces a CA-trusted cert (no browser warning). Run `mkcert -install` once to install the root CA before running Bascik. Install mkcert with `brew install mkcert` on macOS.
2. **openssl:** fallback. Produces a self-signed cert that browsers will warn about.

To use your own certificates (e.g. from Let's Encrypt), set `keyFile` and `certFile` in the `serve` config block and Bascik will use them instead of generating new ones.

> **Deploying.** For guidance on running the production server in containers, on a VPS, or behind a reverse proxy, see [Deploying](/deploying).
