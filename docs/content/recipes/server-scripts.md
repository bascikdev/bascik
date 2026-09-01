# Server Script Recipes

`data-bascik-server` scripts are plain Node.js ESM modules. Bascik gives you the request context and injects stdout into the page. Everything else, helpers, database clients, template logic, is your own code.

These recipes show common patterns. Adapt them to your project rather than treating them as required APIs.

## Shared helper file

The most useful pattern is a small `lib/server.mjs` file at your project root that holds utilities every server script can import.

```js
// lib/server.mjs
export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const parseRequest = () => JSON.parse(process.env.BASCIK_REQUEST);
```

Import it from any server script:

```html
<script data-bascik-server>
  import { escapeHtml, parseRequest } from './lib/server.mjs';

  const { headers } = parseRequest();
  const name = escapeHtml(headers['x-display-name'] ?? 'Guest');
  console.log(`<p>Hello, ${name}</p>`);
</script>
```

> **Why `escapeHtml` is not built in.** Bascik does not auto-escape server script output because that would silently break any script that intentionally emits raw HTML markup. Escaping is explicit, local to your app, and straightforward to add once in a shared file.

## Reading request context

```html
<script data-bascik-server>
  import { escapeHtml } from './lib/server.mjs';
  const { path, headers, searchParams } = JSON.parse(process.env.BASCIK_REQUEST);

  const tab = escapeHtml(searchParams.tab ?? 'overview');
  const user = escapeHtml(headers['x-display-name'] ?? 'Guest');
  console.log(`<p>${user} - ${tab}</p>`);
</script>
```

## Server-rendered pagination

Use `searchParams` to page through results with no client-side JavaScript.

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escapeHtml } from './lib/server.mjs';

  const { searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const page = Math.max(1, Number(searchParams.page ?? 1));
  const db = new Database('./data/app.db');
  const items = db.prepare('SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
  console.log(`<ul>${items.map(a => `<li>${escapeHtml(a.title)}</li>`).join('')}</ul>`);
</script>
```

## SQLite lookup

Read a session cookie and query a local SQLite database.

```html
<script data-bascik-server>
  import Database from 'better-sqlite3';
  import { escapeHtml } from './lib/server.mjs';

  const { headers } = JSON.parse(process.env.BASCIK_REQUEST);
  const sessionId = headers['cookie']?.match(/session=([^;]+)/)?.[1];
  const db = new Database('./data/app.db');
  const row = sessionId && db.prepare('SELECT name FROM users WHERE session_id = ?').get(sessionId);
  console.log(row ? `<p>Hello, ${escapeHtml(row.name)}</p>` : '<p>Not signed in.</p>');
</script>
```

## PostgreSQL

For Postgres, use the `pg` client. Top-level `await` works because server scripts run as ESM modules.

```sh
npm install pg
```

```html
<script data-bascik-server>
  import pg from 'pg';
  import { escapeHtml } from './lib/server.mjs';

  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await db.query('SELECT title FROM articles ORDER BY created_at DESC LIMIT 10');
  await db.end();
  console.log(`<ul>${rows.map(r => `<li>${escapeHtml(r.title)}</li>`).join('')}</ul>`);
</script>
```

> **Connection pooling.** Each `data-bascik-server` block runs in a fresh Node.js child process, so in-process pools are not shared across requests. For production Postgres, use an external pooler such as [PgBouncer](https://www.pgbouncer.org/).

## Combining build and server scripts

`data-bascik-build` and `data-bascik-server` compose freely on the same page:

```html
<!-- runs once at build time -->
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  const links = JSON.parse(await readFile('./data/nav.json', 'utf8'));
  console.log(links.map(l => `<a href="${l.href}">${l.label}</a>`).join(''));
</script>

<!-- runs on every request -->
<script data-bascik-server>
  import { escapeHtml } from './lib/server.mjs';
  const { headers } = JSON.parse(process.env.BASCIK_REQUEST);
  const user = escapeHtml(headers['x-display-name'] ?? 'Guest');
  console.log(`<p class="greeting">Hello, ${user}</p>`);
</script>
```

> **Next:** See the [Production Server](/server) page for the full `data-bascik-server` API, rules, and server configuration, or read the [Server Scripts Testing Guide](/testing/server-scripts) to learn how to test server request handlers and database queries.
