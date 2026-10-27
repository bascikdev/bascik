# Server Scripts

Server scripts let you run Node.js code on each incoming request to personalize pages, query databases, or render user-specific markup. The output is injected directly into the document flow without shipping client-side JavaScript.

## See it in action

This alert box demonstrates dynamic server script execution: in-process Node.js code personalizes content on each request without requiring client-side runtime libraries.

> **See it live on Cloudflare Workers.** These pages render server scripts per request on a deployed Bascik site:
>
> - [Server script request context](https://cloudflare-adapter.bascik.dev/server?user=Jane&role=Architect): query parameters, headers, and the platform context rendered before headers commit.
> - [Mixed server and stream page](https://cloudflare-adapter.bascik.dev/mixed): a server script runs first, then a [stream script](/stream-scripts) flushes into the open connection.

## data-bascik-server

Tag any `<script>` block with `data-bascik-server` to run it at request time on the server. Server scripts execute in-process as Node.js ESM modules. The script returns markup from a default exported function, which replaces the script tag in the rendered page on every request.

```html
<script data-bascik-server>
  export default function (request) {
    const name = request.headers.get("x-display-name") ?? "Guest";
    return `<p class="greeting">Hello, ${name}!</p>`;
  }
</script>
```

> This example interpolates a header without escaping so the mechanics are visible. Real scripts must escape; see Escaping and injection.

This recording shows a real dev server running a server script that lives in a component. Every request runs the script again: a new query string renders a new name, and reloading the same URL renders a new time. Nothing is rebuilt between requests:

![An editor above a browser. The editor shows hello-user.html, a component holding one data-bascik-server script that reads a name from the query string, escapes it, and returns a heading and the current time. The browser loads /greet?name=Ada and shows Hello, Ada!, then loads /greet?name=Grace and shows Hello, Grace!, then reloads and shows a later time](/assets/demos/server-request@2x.webp)

## Handler Signature

Every server script handler uses the standard signature:

```ts
export default async function (request, context, { signal });
```

- `request`: A standard WHATWG [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), identical to API routes. Access `request.method`, `new URL(request.url).pathname`, `new URL(request.url).searchParams.get('page')`, or `request.headers.get('cookie')`. Note that `request.url` carries the real scheme and host of the incoming request. See MDN documentation for [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers), [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL), and [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams).
- `context`: `{ remoteIp }`. This object holds data that has no standard home on `Request`; it is the same shape API routes receive minus `params`.
- `{ signal }`: An [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) triggered when the request times out or the client disconnects.

```html
<script data-bascik-server>
  export default function (request) {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const session = request.headers
      .get("cookie")
      ?.match(/session=([^;]+)/)?.[1];
    return `<p>Page ${page} &bull; Session: ${session ?? "anonymous"}</p>`;
  }
</script>
```

## Escaping and injection

The return value of a server script is HTML by contract. Auto-escaping it would render every `<li>` as literal text. So escaping can only ever apply to individual interpolated values.

Which interpolations need escaping, and how, depends on where each one lands:

| Sink                                                   | Correct treatment                                                                                                   |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| Text between tags                                      | HTML entity escape (`& < > " '`)                                                                                    |
| Quoted attribute value (`title="..."`)                 | HTML entity escape                                                                                                  |
| Unquoted attribute (`class=...`)                       | Never do this; quote the attribute                                                                                  |
| `href`, `src`, `action`                                | Validate the URL: `new URL(v, base)` and allow-list `http:` / `https:`. Entity escaping does not stop `javascript:` |
| Inline `<script>` body                                 | Never interpolate untrusted data. Put it in a `data-*` attribute and read it from a static client script            |
| `on*` event handler attributes                         | Never interpolate untrusted data                                                                                    |
| `<style>` body or `style=""`                           | Never interpolate untrusted data                                                                                    |
| Already-rendered HTML (Markdown output, CMS rich text) | An HTML sanitizer at the data layer; entity escaping would destroy it                                               |

A framework cannot know which row a given `${x}` is in. A single escaper function is therefore only correct for the first two rows, and shipping it as "the" helper teaches authors that one function makes output safe.

Write this five-line escaper once in your project or install an npm escaper such as `escape-html`:

```ts
// src/lib/server.ts
export const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
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
  import { escape } from "@/lib/server.ts";

  export default async function (request, context, { signal }) {
    const res = await fetch("https://api.example.com/user", { signal });
    const data = await res.json();
    return `<div class="user-profile">User: ${escape(data.name)}</div>`;
  }
</script>
```

Once the deadline passes, the result is a timeout even if the script settles afterwards, including a script that returns a value from inside its own `abort` listener. The timeout is then handled by `scripts.onServerScriptError` like any other timeout. A script that returned before the deadline keeps its output. When the client disconnects instead, the script's output is discarded without a report.

> **Event loop caveat:** Because server scripts run in-process, synchronous blocking code (such as `while(true) {}` or heavy CPU loops) blocks Node's single-threaded event loop and cannot be interrupted by timeouts. Always use asynchronous I/O and standard timers.

## Shared Helper Modules

Create a shared helper file such as `src/lib/server.ts` or `lib/server.mjs` for utilities used across server scripts:

```ts
// src/lib/server.ts
export const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function getSessionUser(request: Request): string {
  return request.headers.get("x-user-name") ?? "Guest";
}
```

Import it from any server script using the `@/` import root alias (see [Script Imports](/script-imports)):

```html
<script data-bascik-server>
  import { escape, getSessionUser } from "@/lib/server.ts";

  export default function (request) {
    const user = escape(getSessionUser(request));
    return `<p>Welcome back, ${user}</p>`;
  }
</script>
```

> **Live reload of helpers.** In development, editing a helper (or a helper of a helper) under the import root reloads it and every `src=` server script or API route that imports it on the next request. Inline `data-bascik-server` scripts are different: the edited helper is picked up when the page that contains the script recompiles (an edit to that page, or a rebuild triggered by one of its build-time dependencies), not on the next request by itself. If the page is not recompiled, restart the dev server or move the script to a `src=` file. Bare package imports keep their identity until the dev server restarts, and module-level state in a previous version of a helper stays in memory until the process exits. See the Dependency Generations section of the [Server Internals](/internals/server#in-process-script-module-registry).

## Server-Rendered Pagination

Use `new URL(request.url).searchParams` to page through database records without client-side JavaScript:

```html
<script data-bascik-server>
  import Database from "better-sqlite3";
  import { escape } from "@/lib/server.ts";

  export default function (request) {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const db = new Database("./data/app.db");
    const items = db
      .prepare(
        "SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?",
      )
      .all((page - 1) * 20);
    const list = items.map((a) => `<li>${escape(a.title)}</li>`).join("");
    return `<ul>${list}</ul>`;
  }
</script>
```

## Database Lookups

### SQLite

```html
<script data-bascik-server>
  import Database from "better-sqlite3";
  import { escape } from "@/lib/server.ts";

  export default function (request) {
    const sessionId = request.headers
      .get("cookie")
      ?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return "<p>Not signed in.</p>";
    const db = new Database("./data/app.db");
    const row = db
      .prepare("SELECT name FROM users WHERE session_id = ?")
      .get(sessionId);
    return row
      ? `<p>Hello, ${escape(row.name)}</p>`
      : "<p>Session expired.</p>";
  }
</script>
```

### PostgreSQL

Top-level `await` and ESM imports work seamlessly:

```html
<script data-bascik-server>
  import pg from "pg";
  import { escape } from "@/lib/server.ts";

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  export default async function (request, context, { signal }) {
    const { rows } = await pool.query(
      "SELECT title FROM posts ORDER BY date DESC LIMIT 10",
    );
    return `<ul>${rows.map((r) => `<li>${escape(r.title)}</li>`).join("")}</ul>`;
  }
</script>
```

## Combining Build and Server Scripts

`<script data-bascik-build>` and `<script data-bascik-server>` compose cleanly on the same page:

```html
<!-- runs once at build time: static navigation -->
<script data-bascik-build>
  import { readFile } from "node:fs/promises";

  export default async function () {
    const links = JSON.parse(await readFile("./data/nav.json", "utf8"));
    return links.map((l) => `<a href="${l.href}">${l.label}</a>`).join("");
  }
</script>

<!-- runs on every request: personalized greeting -->
<script data-bascik-server>
  import { escape } from "@/lib/server.ts";

  export default function (request) {
    const user = escape(request.headers.get("x-display-name") ?? "Guest");
    return `<p class="greeting">Hello, ${user}</p>`;
  }
</script>
```

### Passing Request Data to Client Scripts (Hydration)

When browser JavaScript needs request-specific context (such as an authenticated user profile, session token, cart preview, or feature flags), return a `<script type="application/json">` block from your server script.

This parallels Next.js `getServerSideProps` client hydration, but emits clean standard HTML without an external framework runtime or synthetic bundle:

```html
<!-- src/pages/dashboard.html -->
<script data-bascik-server>
  import { getUserFromRequest } from "@/lib/auth.ts";

  export default async function (request) {
    const user = await getUserFromRequest(request);
    const session = {
      id: user?.id ?? null,
      name: user?.name ?? "Guest",
      roles: user?.roles ?? [],
    };

    // Escape < to prevent any closing script tag breakout
    const safeJson = JSON.stringify(session).replaceAll("<", () => "\\u003c");
    return `<script type="application/json" id="session-data">${safeJson}<\/script>`;
  }
</script>

<script>
  // Browser client script reads the per-request session
  const session = JSON.parse(
    document.getElementById("session-data").textContent,
  );

  if (session.id) {
    console.log("Logged in as", session.name);
  }
</script>
```

> **Build vs. Server Hydration.** Use `<script data-bascik-build>` when hydrating static content that stays identical across all visitors. Use `<script data-bascik-server>` when the hydrated client data depends on the incoming request, cookies, headers, or real-time database state.

## Returning component tags

A server script can return the tags of your own components. Bascik renders each tag at request time with the component's markup, props, slots, and scoped CSS, the same way it renders a tag written in a page. There is nothing to import and nothing to configure: a site with any server or stream script gets this automatically.

A common case is a search page that renders the site's shared card for each result. The card is an ordinary component:

```html
<!-- src/components/product-card/product-card.html -->
<style>
  .card {
    border: 1px solid #d0d4dc;
    border-radius: 8px;
    padding: 1rem;
  }
  .price {
    color: #2f6f3e;
  }
</style>
<article class="card">
  <h3 data-bascik-prop-name>Unnamed product</h3>
  <p class="price" data-bascik-prop-price>Price on request</p>
  <div data-bascik-slot></div>
</article>
```

The search page's server script returns one `<product-card>` per match, with the product's values escaped into the props and the slot:

```html
<!-- src/pages/search.html -->
<form method="get" action="/search">
  <input type="search" name="q" aria-label="Search products" />
  <button>Search</button>
</form>
<div class="results">
  <script data-bascik-server>
    import { escape } from "@/lib/server.ts";
    import { searchProducts } from "@/lib/products.ts";

    export default async function (request) {
      const q = new URL(request.url).searchParams.get("q") ?? "";
      const products = await searchProducts(q);
      if (products.length === 0) {
        return `<p>No products match "${escape(q)}".</p>`;
      }
      return products
        .map(
          (p) =>
            `<product-card data-bascik-prop-name="${escape(p.name)}" data-bascik-prop-price="${escape(p.price)}">` +
            (p.badge ? `<span>${escape(p.badge)}</span>` : "") +
            `</product-card>`,
        )
        .join("");
    }
  </script>
</div>
```

A request for `/search?q=grinder` receives the rendered card. This is `bascik --server` output with `minify.identifiers: false`, reformatted for reading; with the default `true`, the class names are short hashes:

```html
<div class="results">
  <style>
    .bascik__product-card__card {
      border: 1px solid #d0d4dc;
      border-radius: 8px;
      padding: 1rem;
    }
    .bascik__product-card__price {
      color: #2f6f3e;
    }
  </style>
  <article class="bascik__product-card__card">
    <h3>Burr grinder</h3>
    <p class="bascik__product-card__price">$129</p>
    <span>Best seller</span>
  </article>
</div>
```

The rules that come with it:

- **Script output is HTML, rendered with the same power as your own markup.** Every component tag in it is expanded, and the component's own server and stream scripts run with the current request. Escape each value you put into a prop or slot, and sanitize HTML from a CMS or an API before returning it: a tag in that HTML renders your component, and an ordinary `<script>` or `on*` attribute in it reaches the browser.
- **Scripts inside a returned component run.** A `data-bascik-server` or `data-bascik-stream` script inside the component runs once per rendered instance, with the same `request`, `context`, and `signal`, and with what is left of the page script's `scripts.timeout`. It receives no props from the usage tag; pass per-instance values as props to the component's markup instead. Its errors follow `scripts.onServerScriptError` like the page's own scripts: under `'error'` the response is a 500, and under `'warn'` or `'ignore'` that script's slot is empty and the rest of the card is kept.
- **Budgets.** One script output may expand to 1000 component instances and 4 MiB (4,194,304 characters) of rendered HTML. One response may run 64 nested component scripts, nested at most 4 levels deep (a script returning a component whose script returns a component, and so on). Over a budget, the script fails with a message naming the route and the component file. For a server script the response is a 500: `scripts.onServerScriptError` does not apply to these render failures in this release, so `'warn'` and `'ignore'` do not turn them into an empty slot. A stream script leaves its slot empty. Output with no component tag in it is never measured.
- **CSS is emitted in the body, before the first instance.** Each component's stylesheet is sent as one `<style>` block right before the output that holds its first instance in document order, once per response, whatever order the scripts finish in. A page with both server and stream scripts may send it once for each. A component that is also used in the page's own markup gets a second, identical block. A component whose CSS embeds the instance id (`url(#id)`, or `scoping.deduplicateCss: false`) gets one block per instance. Because the block sits in the body, unscoped rules in such a component (`body`, `*`, `@import`) restyle the whole page.
- **Client scripts run in place.** A component's `<script>` stays inside its rendered instance, as in the dev server. With `minify.html` on it moves to the end of the outermost rendered instance, never to the end of the document, so look up elements outside the component inside an event handler. See [Where Component Scripts Run](/scoped-javascript#where-component-scripts-run).
- **Base paths are rewritten inside rendered components.** With a non-root [`base`](/configuration#base), URLs in the component's markup, its props, and its slot content are rewritten as at build time. The rest of the script's output is sent as written, so prefix your own URLs.
- **`components.external` names are sent as written.** A tag listed in `components.external` with no component file, such as a third-party web component, is never expanded or logged. A component file with the same name still renders, as it does at build time.
- **Only markup is rendered.** A tag inside `<script>`, `<style>`, `<textarea>`, a comment, or an attribute value, or an escaped one (`&lt;product-card&gt;`), stays text. A `data-bascik-server` or other directive script in the output never runs on the server; it is sent as written, like the rest of the output.
- **Unsupported components and misspelled tags are left as written.** A few component shapes cannot be rendered at request time, such as a component that binds a prop to its `class` or `id` with `data-bascik-attr-*`. Their tags, and tags with no component file, reach the browser unexpanded. When at least one component can be rendered at request time, the dev server logs each one once per route and tag. After a build, `bascik --check` lists the unsupported components with the reason; it does not see misspelled tags, which exist only in a script's output at request time. See [Request-Time Component Rendering](/compatibility#request-time-component-rendering) for each reason and how to restructure the component.

Request-time rendering needs a host that runs server scripts: the [dev server](/development-server), the [production server](/production-server), or the [Cloudflare Adapter](/deployment/cloudflare). The Cloudflare demo renders the same shape live: a [product catalog](https://cloudflare-adapter.bascik.dev/catalog?q=grinder) and its [streamed version](https://cloudflare-adapter.bascik.dev/catalog-stream). [Stream scripts](/stream-scripts#returning-component-tags) return component tags under the same rules.

## Server Scripts vs API Routes

Both `data-bascik-server` script blocks and [API Routes](/api-routes) run in-process through Bascik's script registry at request time, receiving the same `Request` object, but they serve different architectural purposes:

| Feature              | Server Scripts (`data-bascik-server`)                  | API Routes (`src/api/*.ts`)                                   |
| :------------------- | :----------------------------------------------------- | :------------------------------------------------------------ |
| **Destination**      | Injected directly into HTML pages                      | Standalone JSON, streaming, or binary HTTP endpoints          |
| **Methods**          | GET only (page render)                                 | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`    |
| **Contract**         | Takes WHATWG `Request`, returns HTML string            | Takes WHATWG `Request`, returns WHATWG `Response`             |
| **Response Control** | Cannot set HTTP status code or custom headers          | Full control over status codes, response headers, and cookies |
| **Use Cases**        | Page personalization, user greetings, auth state in UI | Form submissions, webhook receivers, authenticated REST APIs  |

Use `data-bascik-server` when rendering HTML into the document flow. Use API routes when returning data, receiving client submissions, or controlling response headers.

## Rules and Behavior

- A server script must `export default` a function. A script without one is a located build error naming the file and line.
- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are stripped and stored in `dist/.bascik/server-scripts.json`, leaving inert `<script type="text/bascik-server">` placeholders in the static HTML.
- Execution happens when served by `bascik` (dev server), `bascik --server` (production server), or a generated serverless function built with a `--target` such as the [Cloudflare Adapter](/deployment/cloudflare). A static-only host leaves the placeholders inert.
- On error, `scripts.onServerScriptError` controls behavior: `'error'` responds with HTTP 500, while `'warn'` logs to stderr and replaces the tag with an empty string. Stack traces remap to your original source file line and column.
- Directives (`data-bascik-server`, `data-bascik-stream`, `data-bascik-build`, `data-bascik-routes`) are mutually exclusive and cannot be combined on the same tag.

> **Next:** See [Stream Scripts](/stream-scripts) for chunked streaming scripts (`data-bascik-stream`), or consult the [Production Server](/production-server) reference for server runtime configuration.

<!-- demo:source-usage -->

```html
<script data-bascik-server>
  import { escape } from "@/lib/server.ts";

  export default function (request) {
    const name = escape(request.headers.get("x-display-name") ?? "Guest");
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
