# Server Scripts

`data-bascik-server` scripts are plain Node.js ESM modules. Bascik gives you the request context and injects stdout into the page. Everything else, helpers, database clients, template logic, is your own code.

These guides show common patterns. Adapt them to your project rather than treating them as required APIs.

## Shared helper file

The most useful pattern is a small `lib/server.mjs` file at your project root that holds utilities every server script can import.

```js
// lib/server.mjs
export { escapeHtml } from '@bascik/bascik';

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

> **Why `escapeHtml` is explicit.** Bascik does not auto-escape server script output because that would silently break any script that intentionally emits raw HTML markup. Escaping is explicit, local to your app, and `escapeHtml` is exported directly from `@bascik/bascik`.

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

> **Connection pooling.** `data-bascik-server` blocks execute in-process via Bascik's `ScriptRegistry`. For long-lived database connections, you can keep client or pool instances across requests or use an external pooler such as [PgBouncer](https://www.pgbouncer.org/).

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

## Placeholders that do not shift layout

Whatever you write before a `<script data-bascik-stream>` tag is on screen while the script runs. Bascik does not hide, replace, or style it. If you want the placeholder to give way to the result, you do that with your own HTML and CSS.

### Recipe A: Reserved box (Default pattern)

Wrap the script in a container that declares its final size so the result lands in already-reserved space. Use `min-block-size` for text blocks and `aspect-ratio` for media (see [aspect-ratio CSS](/performance#aspect-ratio-css-layout-stability-before-images-load)). Include `aria-busy="true"` on the container and `role="status"` on the placeholder text so screen readers announce the pending state. Place the markup in a component so the CSS is scoped automatically (page-level `<style>` is not scoped):

```html
<!-- src/components/account-panel.html -->
<style>
  .panel { min-block-size: 8rem; }
  .pending { color: var(--muted, #6b7280); }
</style>
<section class="panel" aria-busy="true">
  <p class="pending" role="status">Loading your account…</p>
  <script data-bascik-stream>
    export default async function ({ req }, { signal }) {
      const account = await loadAccount(req, signal);
      return `<article>${escapeHtml(account.name)}</article>`;
    }
  </script>
</section>
```

#### How visual swap works

Nothing already sent can be removed from the DOM without client JavaScript, and Bascik ships none. The result is inserted where the `<script>` tag was, directly after the placeholder in the same container. The visual swap is achieved entirely through author CSS:

**Pattern 1: Stack placeholder and result in one grid cell (Recommended).** The result paints on top of the placeholder in the same reserved cell:

```css
/* Stack placeholder and result in one grid cell; the result paints on top. */
.panel { display: grid; min-block-size: 9rem; }
.panel > * { grid-area: 1 / 1; }
.result { background: var(--surface, #fff); }
```

Pattern 1 needs no `:has()`, no class on the returned markup beyond a background, and works in every browser with CSS grid.

**Pattern 2: Hide the pending state once a result exists.** Use `:has()` to hide the placeholder element when the result arrives:

```css
/* Hide the pending state once a result exists. */
.panel:has(> .result) > .pending { display: none; }
```

In Pattern 2, the script's returned markup carries the `result` class (`return \`<article class="result">…</article>\``). Class arguments inside `:has()` are scoped normally. The scoping engine rewrites class names inside a component's server-script or stream-script source string in both readable and minified-identifier modes (authored `class="result"` becomes `class="bascik__swap-card__result"` unminified and the matching hashed class when minified). Classes built dynamically at request time (concatenation, database values) are not visible to the build and are not scoped.

Both patterns keep the reserved size so there is zero layout shift in either direction.

There is no `data-bascik-placeholder` attribute, because Bascik adds zero framework runtime. The placeholder is whatever element you author before the script; a class is the CSS hook.

### Recipe B: Skeleton shimmer

Apply a skeleton shimmer background to the reserved box while the content streams:

```css
.panel {
  min-block-size: 8rem;
  background-color: #f0f0f0;
  background-image: linear-gradient(
    90deg,
    #f0f0f0 25%,
    #e0e0e0 50%,
    #f0f0f0 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

The shimmer is pure author CSS and stops mattering once the result paints over it.

### Recipe C: Source order is delivery order, CSS decides visual order

Everything before the first server script is delivered immediately, and everything after a stream script waits for that script to resolve. Place slow stream scripts as late in the document as possible, then use CSS grid or flexbox to place those late blocks wherever the visual design requires.

For a dashboard where only the subscription card and the billing card require server computation:

```html
<!-- src/components/account-dashboard.html -->
<style>
  .dash {
    display: grid;
    grid-template-columns: 14rem 1fr;
    grid-template-areas:
      "nav subscription"
      "nav usage"
      "nav billing"
      "nav footer";
  }
  .nav          { grid-area: nav; }
  .usage        { grid-area: usage; }
  .foot         { grid-area: footer; }
  .subscription { grid-area: subscription; min-block-size: 9rem; }
  .billing      { grid-area: billing;      min-block-size: 12rem; }
  .pending      { color: var(--muted, #6b7280); }
</style>

<main class="dash">
  <!-- Static blocks first: all of these reach the browser in the first chunk. -->
  <nav class="nav"><!-- links --></nav>
  <section class="usage"><!-- static usage chart markup --></section>
  <footer class="foot"><!-- static footer --></footer>

  <!-- Server-dependent blocks last in source, positioned by grid-area above. -->
  <section class="subscription" aria-busy="true">
    <p class="pending" role="status">Loading subscription…</p>
    <script data-bascik-stream>
      export default async function ({ req }, { signal }) {
        const sub = await loadSubscription(req, signal);
        return `<h2>${escapeHtml(sub.plan)}</h2><p>Renews ${escapeHtml(sub.renewsOn)}</p>`;
      }
    </script>
  </section>

  <section class="billing" aria-busy="true">
    <p class="pending" role="status">Loading billing…</p>
    <script data-bascik-stream>
      export default async function ({ req }, { signal }) {
        const rows = await loadInvoices(req, signal);
        return `<ul>${rows.map(r => `<li>${escapeHtml(r.label)}</li>`).join('')}</ul>`;
      }
    </script>
  </section>
</main>
```

#### Timeline

1. The browser receives and paints `<main>`, the nav, the usage chart, the footer, and both placeholder cards in the first chunk (around 20ms).
2. The subscription card fills when its script resolves.
3. The billing card fills when its script resolves.
4. Because the grid areas and card children already reserve the space (`min-block-size`), there is zero layout shift when either result lands.

`grid-template-areas` and `grid-area` values pass through the scoping engine untouched, so this is vanilla author CSS.

To guarantee zero layout shift when building multi-row grids where items stream in sequentially, set explicit row sizing (e.g. `grid-template-rows: minmax(6rem, auto) auto minmax(6rem, auto) auto`) on the grid container along with `min-block-size` and `margin: 0` on card children. A card that has not yet arrived has no DOM box; without explicit row sizing or card `min-block-size`, its row would initially collapse to zero height.

#### Layout considerations

- An open, not-yet-closed `<main>` element renders incrementally in all modern browsers without errors because HTML parsing is incremental by specification. Closing tags arriving later is standard streaming behavior.
- Source order is delivery order: everything before the first stream tag is in the first chunk; content after a stream tag waits for that script. In sequential card streams, put the fastest or most important slow block first.
- Keyboard and screen-reader navigation follows DOM source order, not CSS grid order. Keep primary structure logical (nav, main content, footer) and only move slow dynamic widgets to the end. For simple vertical stacks, the CSS `order` property on flex or grid children provides a lightweight alternative to named areas.

Author the page so that source order is your priority order, then let CSS place it.

Placeholders are only ever visible for `data-bascik-stream` scripts. A `data-bascik-server` script resolves before the first byte is sent, so its placeholder is delivered in the exact same chunk as its result and is never visible on its own. Write placeholders for `data-bascik-stream` scripts.

> **Next:** See the [Production Server](/server) page for the full `data-bascik-server` API, rules, and server configuration, or read the [Server Scripts Testing Guide](/testing/server-scripts) to learn how to test server request handlers and database queries.
