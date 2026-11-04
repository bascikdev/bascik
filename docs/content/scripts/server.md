# Server Scripts

Server scripts let you run Node.js code on each incoming request to personalize pages, query databases, or render user-specific markup. The output is injected directly into the document flow without shipping client-side JavaScript.

## See it in action

This alert box demonstrates dynamic server script execution: in-process Node.js code personalizes content on each request without requiring client-side runtime libraries.

> **See it live on Cloudflare Workers.** These pages render server scripts per request on a deployed Bascik site:
>
> - [Server script request context](https://cloudflare-adapter.bascik.dev/server?name=collin&role=Architect): query parameters, headers, and the platform context rendered before headers commit.
> - [Mixed server and stream page](https://cloudflare-adapter.bascik.dev/mixed): a server script runs first, then a [stream script](/scripts/stream) flushes into the open connection.

## data-bascik-server

Tag any `<script>` block with `data-bascik-server` to run it at request time on the server. Server scripts execute in-process as Node.js ESM modules. The script returns markup from a default exported function, which replaces the script tag in the rendered page on every request.

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const name = request.headers.get("x-display-name") ?? "Guest";
    return html`<p class="greeting">Hello, ${name}!</p>`;
  }
</script>
```

`html` from `@bascik/bascik/html` escapes each value for where it lands, so a header that holds markup comes back as text. See [Escaping and injection](#escaping-and-injection).

This recording shows a real dev server running a server script that lives in a component. Every request runs the script again: a new query string renders a new name, and reloading the same URL renders a new time. Nothing is rebuilt between requests:

![An editor above a browser. The editor shows hello-user.html, a component holding one data-bascik-server script that reads a name from the query string and returns a heading and the current time built with html, which escapes the name. The browser loads /greet?name=Ada and shows Hello, Ada!, then loads /greet?name=Grace and shows Hello, Grace!, then reloads and shows a later time](/assets/demos/server-request@2x.webp)

## Handler Signature

Every server script handler uses the standard signature:

```ts
export default async function (request, context, { signal });
```

- `request`: A standard WHATWG [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), identical to API routes. Access `request.method`, `new URL(request.url).pathname`, `new URL(request.url).searchParams.get('page')`, or `request.headers.get('cookie')`. Note that `request.url` carries the real scheme and host of the incoming request. See MDN documentation for [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request), [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers), [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL), and [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams).
- `context`: `{ remoteIp, platform }`. This object holds data that has no standard home on `Request`; it is the same shape API routes receive minus `params`. `platform` is `{ name: "node" }` on the built-in server and carries the Worker's bindings on Cloudflare (see [Bindings and secrets](/deployment/cloudflare#bindings-and-secrets)); a script that ignores it runs unchanged on every host.
- `{ signal }`: An [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) triggered when the request times out or the client disconnects.

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const session = request.headers
      .get("cookie")
      ?.match(/session=([^;]+)/)?.[1];
    return html`<p>Page ${page} &bull; Session: ${session ?? "anonymous"}</p>`;
  }
</script>
```

### TypeScript

Write a server script in TypeScript with a `src=` `.ts` or `.mts` module, or mark an inline block `type="text/typescript"`. Bascik strips the types before the script runs, on Node in dev and production and in the [Cloudflare adapter](/deployment/cloudflare)'s Worker bundle. Stripping keeps every line and column, so a stack trace names the page's own lines. A `src=` module is imported as a file and Node strips its types; a [`scripts.typescript`](/configuration#scriptstypescript) function compiles both forms instead. An unmarked inline block is JavaScript. A tag with both `src=` and an inline body is rejected: move the body into the file or remove `src=`.

Both forms are compiled and parsed when the page is built, in dev and by `bascik --build`, so a syntax error, an `enum`, or a redeclared variable fails the build naming the file, line, and column, not the first request. The Node build and the Cloudflare build print the same message.

<!-- demo:ts-server-usage -->

```html
<!-- src/pages/hello.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Hello</title>
  </head>
  <body>
    <script data-bascik-server type="text/typescript">
      import { html, type SafeHtml } from "@bascik/bascik/html";

      export default (request: Request): SafeHtml => {
        const name: string =
          new URL(request.url).searchParams.get("name") ?? "visitor";
        return html`<p>Hello, ${name}</p>`;
      };
    </script>
  </body>
</html>
```

The Output is the `<body>` that `bascik --server` sent for `GET /hello?name=collin`. There is no Preview because this docs site is static and runs no server script.

<!-- demo:ts-server-output-html -->

```html
<p>Hello, collin</p>
```

## Return Values

The value the default export returns, or resolves to, replaces the script tag. A server script returns markup, so a string is inserted as it is; build it with [`html`](/html-helpers) so the values in it are escaped. Every other value follows the rules `html` uses for a text hole:

| Returned value                                      | Printed                                     |
| :-------------------------------------------------- | :------------------------------------------ |
| string                                              | As it is (it is markup)                     |
| `html` or `raw()` value                             | Its markup                                  |
| number, bigint, `true`                              | `String(value)`                             |
| `null`, `undefined`, `false`                        | Nothing                                     |
| Array (up to 1000 levels deep)                      | Each item by these rules, with no separator |
| An object with its own `toString` (a `Date`)        | Its `toString()` text                       |
| A plain object, `Map`, `Response`, function, symbol | Refused (see below)                         |
| An `Error` (`return e` in a `catch`)                | Refused (see below)                         |
| An array holding a Promise                          | Refused (see below)                         |

Because an array is joined with no separator, `.map` needs no `.join("")`:

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function () {
    const books = [
      { title: "Refactoring the Monolith" },
      { title: "Practical Type Systems" },
    ];
    return books.map((b) => html`<li>${b.title}</li>`);
  }
</script>
```

A returned value that is not markup is a mistake `String()` would print as `[object Object]`, `[object Response]` or `[object Promise]`, so Bascik refuses it instead. The usual causes are returning the data instead of markup built from it, returning a `Response` (that belongs in an [API route](/api-routes)), returning a caught `Error` (its text is an internal message, so throw it instead), and an `async` callback in `.map`, which makes an array of Promises: write `return await Promise.all(items.map(async (item) => ...))`. A Promise returned on its own is awaited, so it never reaches the page. The linter catches a returned `Response` as you type ([`server-script-returns-response`](/tools/linter#server-script-returns-response)).

- **Dev server (`bascik`).** A refused value is a server script error, handled by `scripts.onServerScriptError` like a throw: under `'error'` (the default) the page is a 500 (a stream script's slot is empty instead, as for any stream failure), `'warn'` logs and leaves the slot empty, and `'ignore'` leaves it empty without a log. The message names the route, the script's file and line, and what was returned, such as `The server script in src/pages/shop.html:12 returned an array holding a Promise at [0]`.
- **Production (`bascik --server` and the Cloudflare adapter).** A refused value never fails the page: the slot is empty, and the same message is logged once per script, as a warning, until the server restarts (the Worker logs it once per isolate). `'ignore'` silences it.

## Escaping and injection

The return value of a server script is HTML. Every value you put into it from a request, a database or an API is data, and it must reach the page as text, never as markup or code. Write the markup with `html` from `@bascik/bascik/html`: a tagged template that reads the markup around each `${...}` and escapes the value for that place.

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return html`<p>You searched for ${q}</p>
      <a href="${q}">Search again</a>`;
  }
</script>
```

A request for `?q=<img src=x onerror=alert(1)>` returns `You searched for &lt;img src=x onerror=alert(1)&gt;`, and `?q=javascript:alert(1)` makes the link `href="about:invalid"`.

What `html` does depends on where the value lands:

| Where the value lands                                  | What `html` does                                                                                           |
| :----------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Text between tags                                      | Escapes `& < > " '`                                                                                        |
| Quoted attribute value (`title="..."`, props)          | Escapes `& < > " '`                                                                                        |
| URL attribute (`href`, `src`, `action`, `srcset`, ...) | Replaces script URLs such as `javascript:` (and non-image `data:` URLs) with `about:invalid`, then escapes |
| Unquoted attribute (`class=${x}`)                      | Throws: quote the attribute                                                                                |
| `on*` event handler, `style` attribute                 | Throws: put the value in a `data-*` attribute                                                              |
| Inline `<script>` or `<style>` body                    | Throws, except `json(value)` as the only content of `<script type="application/json">`                     |
| Already-rendered HTML (Markdown output, CMS rich text) | Sanitize it at the data layer, then insert it with `raw(value)`                                            |

A nested `html` value, or an array of them, is inserted as it is, so `${items.map((item) => html`<li>${item}</li>`)}` needs no `.join("")`. `null`, `undefined` and `false` render as nothing. The [Security](/scripts/security) page explains what Bascik guarantees and what is yours, and [HTML Helpers](/html-helpers) lists every context, helper and error.

### Trusted vs untrusted data

- **Untrusted data:** Anything from `request` (headers, URL, query parameters, cookies), any database column that was ever user input, and any third-party API response is untrusted.
- **Trusted data:** Markup you wrote directly in the template is trusted.

Escape once, at output. Do not store escaped strings.

The helpers are plain functions you import; nothing is injected into scope. Besides `html`, `@bascik/bascik/html` exports `raw` (trusted HTML), `esc` (an escaped string), `safeUrl` (a checked URL) and `json` (JSON for a JSON `<script>`). Your script still sees only `request`, `context`, `signal`, and what it imports.

> **Without html.** Code that builds markup as plain strings must escape each text or quoted-attribute value with `esc(value)` from the same module and check each URL with `safeUrl(value)`. Do not write an escaper of your own. `esc` does nothing for a `javascript:` URL, an event handler, a `<script>` body or an unquoted attribute, which is why `html` reads where each value lands and is the way to build markup in every script and helper.

## Timeouts and Cancellation (`AbortSignal`)

Server script execution is bounded by `scripts.timeout` in `bascik.config.ts`. Pass the provided `signal` to `fetch()` or database clients so long-running async calls are canceled automatically when the deadline expires or the client disconnects:

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default async function (request, context, { signal }) {
    const res = await fetch("https://api.example.com/user", { signal });
    const data = await res.json();
    return html`<div class="user-profile">User: ${data.name}</div>`;
  }
</script>
```

Once the deadline passes, the result is a timeout even if the script settles afterwards, including a script that returns a value from inside its own `abort` listener. The timeout is then handled by `scripts.onServerScriptError` like any other timeout. A script that returned before the deadline keeps its output. When the client disconnects instead, the script's output is discarded without a report.

> **Event loop caveat:** Because server scripts run in-process, synchronous blocking code (such as `while(true) {}` or heavy CPU loops) blocks Node's single-threaded event loop and cannot be interrupted by timeouts, so every concurrent request waits until it finishes. Always use asynchronous I/O and standard timers, and move CPU-heavy work to a worker thread.

## Shared Helper Modules

Create a shared helper file such as `src/lib/server.ts` or `lib/server.mjs` for utilities used across server scripts:

```ts
// src/lib/server.ts
import { html } from "@bascik/bascik/html";

export function getSessionUser(request: Request): string {
  return request.headers.get("x-user-name") ?? "Guest";
}

/** A card any page's script can nest: html fragments from two modules nest as they are. */
export const userBadge = (name: string) =>
  html`<span class="user-badge">${name}</span>`;
```

Import it from any server script using the `@/` import root alias (see [Script Imports](/scripts/imports)):

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";
  import { getSessionUser, userBadge } from "@/lib/server.ts";

  export default function (request) {
    return html`<p>Welcome back, ${userBadge(getSessionUser(request))}</p>`;
  }
</script>
```

> **Live reload of helpers.** In development, editing a helper (or a helper of a helper) under the import root reloads it and every `src=` server script or API route that imports it on the next request. Inline `data-bascik-server` scripts are different: the edited helper is picked up when the page that contains the script recompiles (an edit to that page, or a rebuild triggered by one of its build-time dependencies), not on the next request by itself. If the page is not recompiled, restart the dev server or move the script to a `src=` file. Bare package imports keep their identity until the dev server restarts, and module-level state in a previous version of a helper stays in memory until the process exits. See the Dependency Generations section of the [Server Internals](/internals/server#in-process-script-module-registry).

## Server-Rendered Pagination

Use `new URL(request.url).searchParams` to page through database records without client-side JavaScript:

```html
<script data-bascik-server>
  import Database from "better-sqlite3";
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const db = new Database("./data/app.db");
    const items = db
      .prepare(
        "SELECT title FROM articles ORDER BY created_at DESC LIMIT 20 OFFSET ?",
      )
      .all((page - 1) * 20);
    return html`<ul>
      ${items.map((a) => html`<li>${a.title}</li>`)}
    </ul>`;
  }
</script>
```

## Database Lookups

### SQLite

```html
<script data-bascik-server>
  import Database from "better-sqlite3";
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const sessionId = request.headers
      .get("cookie")
      ?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return "<p>Not signed in.</p>";
    const db = new Database("./data/app.db");
    const row = db
      .prepare("SELECT name FROM users WHERE session_id = ?")
      .get(sessionId);
    return row ? html`<p>Hello, ${row.name}</p>` : "<p>Session expired.</p>";
  }
</script>
```

### PostgreSQL

Top-level `await` and ESM imports work seamlessly:

```html
<script data-bascik-server>
  import pg from "pg";
  import { html } from "@bascik/bascik/html";

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  export default async function (request, context, { signal }) {
    const { rows } = await pool.query(
      "SELECT title FROM posts ORDER BY date DESC LIMIT 10",
    );
    return html`<ul>
      ${rows.map((r) => html`<li>${r.title}</li>`)}
    </ul>`;
  }
</script>
```

## Combining Build and Server Scripts

`<script data-bascik-build>` and `<script data-bascik-server>` compose cleanly on the same page:

```html
<!-- src/pages/account.html: the build script runs once at build time for static navigation -->
<script data-bascik-build>
  import { readFile } from "node:fs/promises";
  import { html } from "@bascik/bascik/html";

  export default async function () {
    const links = JSON.parse(await readFile("./data/nav.json", "utf8"));
    return html`${links.map((l) => html`<a href="${l.href}">${l.label}</a>`)}`;
  }
</script>

<!-- runs on every request: personalized greeting -->
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const user = request.headers.get("x-display-name") ?? "Guest";
    return html`<p class="greeting">Hello, ${user}</p>`;
  }
</script>
```

### Passing Request Data to Client Scripts (Hydration)

When browser JavaScript needs request-specific context (such as an authenticated user profile, session token, cart preview, or feature flags), return a `<script type="application/json">` block from your server script.

This parallels Next.js `getServerSideProps` client hydration, but emits clean standard HTML without an external framework runtime or synthetic bundle:

```html
<!-- src/pages/dashboard.html -->
<script data-bascik-server>
  import { html, json } from "@bascik/bascik/html";
  import { getUserFromRequest } from "@/lib/auth.ts";

  export default async function (request) {
    const user = await getUserFromRequest(request);
    const session = {
      id: user?.id ?? null,
      name: user?.name ?? "Guest",
      roles: user?.roles ?? [],
    };

    // json() escapes <, >, & and the line separators, so the data cannot end the script.
    return html`<script type="application/json" id="session-data">
      ${json(session)}
    <\/script>`;
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

A server script can return the tags of your own components, such as one `<book-card>` per search result, and Bascik renders each tag at request time with the component's markup, props, slots, and scoped CSS. The security guarantees and the rules every returned tag follows are in [Returning component tags](/scripts#returning-component-tags) on the scripts overview. The two examples below put them to work.

> **See it live on Cloudflare Workers.** The [book catalog](https://cloudflare-adapter.bascik.dev/catalog?q=monolith) on the Cloudflare demo site searches with `?q=` and renders one `<book-card>` per match, next to a card with its own server script. The [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream) streams the same cards in batches.

### Render a card per search result

A common case is a search page that renders the site's shared card for each result. The card is an ordinary component: two props, a default slot for its badge, a companion stylesheet, and a client script for its Save button.

The search page's server script returns one `<book-card>` per match, built with `html`, which escapes the book's values into the props and the slot. A book with no badge leaves the slot empty, so its card keeps the `Paperback` fallback. A real site would read the books from a database or an API; here they are inline so the page works as pasted. The first line of each block names the file's path. The page, HTML, and JS path comments are ordinary comments, so they also appear in the Output; the CSS comment is dropped.

<!-- demo:rtc-search-source-usage -->

```html
<!-- src/pages/search.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Search</title>
  </head>
  <body>
    <form method="get" action="/search">
      <input type="search" name="q" aria-label="Search books" />
      <button>Search</button>
    </form>
    <div class="results">
      <script data-bascik-server>
        // html escapes each value for where it lands: /scripts/server#escaping-and-injection
        import { html } from "@bascik/bascik/html";

        const catalog = [
          {
            title: "Refactoring the Monolith",
            author: "Grace Lin",
            badge: "Best seller",
          },
          {
            title: "Practical Type Systems",
            author: "Ada Okafor",
            badge: "New",
          },
          { title: "Shipping Small Changes", author: "Sam Rivera" },
        ];

        export default function (request) {
          const q = (new URL(request.url).searchParams.get("q") ?? "")
            .trim()
            .toLowerCase();
          const books = catalog.filter((b) =>
            b.title.toLowerCase().includes(q),
          );
          if (books.length === 0) {
            return html`<p>No books match "${q}".</p>`;
          }
          return html`${books.map(
            (b) =>
              html`<book-card
                data-bascik-prop-title="${b.title}"
                data-bascik-prop-author="${b.author}"
                >${b.badge}</book-card
              >`,
          )}`;
        }
      </script>
    </div>
  </body>
</html>
```

<!-- demo:rtc-search-source-html -->

```html
<!-- src/components/book-card/book-card.html -->
<article class="card" data-testid="book-card">
  <h3 class="title" data-bascik-prop-title>Untitled book</h3>
  <p class="author" data-bascik-prop-author>Unknown author</p>
  <span class="badge"><span data-bascik-slot>Paperback</span></span>
  <button
    class="save"
    type="button"
    aria-pressed="false"
    data-testid="book-card-save"
  >
    Save
  </button>
</article>
<script src="book-card.js"></script>
```

<!-- demo:rtc-search-source-css -->

```css
/* src/components/book-card/book-card.css */
.card {
  display: grid;
  gap: 6px;
  padding: 16px;
  border: 1px solid #3a3d40;
  border-radius: 12px;
  background: #242628;
  color: #f0f1f2;
}

.title {
  margin: 0;
  font-size: 1rem;
}

.author {
  margin: 0;
  color: #8d929e;
}

.badge {
  justify-self: start;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(211, 255, 141, 0.15);
  color: #d3ff8d;
  font-size: 0.75rem;
  font-weight: 600;
}

.save {
  justify-self: start;
  padding: 4px 12px;
  border: 1px solid #3a3d40;
  border-radius: 8px;
  background: transparent;
  color: #f0f1f2;
  cursor: pointer;
}

.save[aria-pressed="true"] {
  border-color: rgba(211, 255, 141, 0.6);
  color: #d3ff8d;
}
```

<!-- demo:rtc-search-source-js -->

```js
// src/components/book-card/book-card.js
// One click listener serves every card on the page. The text is the same in
// every instance (no scoped id), so one CSP hash covers cards a server script
// renders at request time too.
if (!document.documentElement.hasAttribute("data-book-card-save")) {
  document.documentElement.setAttribute("data-book-card-save", "");
  document.addEventListener("click", (event) => {
    const save = event.target.closest(".save");
    if (save === null) return;
    const saved = save.getAttribute("aria-pressed") !== "true";
    save.setAttribute("aria-pressed", String(saved));
    save.textContent = saved ? "Saved" : "Save";
  });
}
```

A request for `/search` with no query matches all three books. The Output is the body `bascik --server` sent for `GET /search`, reformatted for reading. The card's stylesheet arrives once, as one `<style>` right before the first card, and one click listener serves every Save button, finding the card it belongs to with `closest`. The script has no scoped id, so its text is the same in every card, and one [Content-Security-Policy](/how-to/content-security-policy#components-rendered-at-request-time) hash covers the cards a server script renders. A request for `/search?q=monolith` gets the Refactoring the Monolith card alone.

<!-- demo:rtc-search-output-html -->

```html
<!-- src/pages/search.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Search</title>
  </head>
  <body>
    <form method="get" action="/search">
      <input type="search" name="q" aria-label="Search books" />
      <button>Search</button>
    </form>
    <div class="results">
      <style>
        .bascik__book-card__card {
          display: grid;
          gap: 6px;
          padding: 16px;
          border: 1px solid #3a3d40;
          border-radius: 12px;
          background: #242628;
          color: #f0f1f2;
        }

        .bascik__book-card__title {
          margin: 0;
          font-size: 1rem;
        }

        .bascik__book-card__author {
          margin: 0;
          color: #8d929e;
        }

        .bascik__book-card__badge {
          justify-self: start;
          padding: 2px 10px;
          border-radius: 999px;
          background: rgba(211, 255, 141, 0.15);
          color: #d3ff8d;
          font-size: 0.75rem;
          font-weight: 600;
        }

        .bascik__book-card__save {
          justify-self: start;
          padding: 4px 12px;
          border: 1px solid #3a3d40;
          border-radius: 8px;
          background: transparent;
          color: #f0f1f2;
          cursor: pointer;
        }

        .bascik__book-card__save[aria-pressed="true"] {
          border-color: rgba(211, 255, 141, 0.6);
          color: #d3ff8d;
        }</style
      ><!-- src/components/book-card/book-card.html -->
      <article class="bascik__book-card__card" data-testid="book-card">
        <h3 class="bascik__book-card__title">Refactoring the Monolith</h3>
        <p class="bascik__book-card__author">Grace Lin</p>
        <span class="bascik__book-card__badge">Best seller</span>
        <button
          class="bascik__book-card__save"
          type="button"
          aria-pressed="false"
          data-testid="book-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/book-card/book-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (!document.documentElement.hasAttribute("data-book-card-save")) {
            document.documentElement.setAttribute("data-book-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__book-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/book-card/book-card.js
      </script>
      <!-- src/components/book-card/book-card.html -->
      <article class="bascik__book-card__card" data-testid="book-card">
        <h3 class="bascik__book-card__title">Practical Type Systems</h3>
        <p class="bascik__book-card__author">Ada Okafor</p>
        <span class="bascik__book-card__badge">New</span>
        <button
          class="bascik__book-card__save"
          type="button"
          aria-pressed="false"
          data-testid="book-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/book-card/book-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (!document.documentElement.hasAttribute("data-book-card-save")) {
            document.documentElement.setAttribute("data-book-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__book-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/book-card/book-card.js
      </script>
      <!-- src/components/book-card/book-card.html -->
      <article class="bascik__book-card__card" data-testid="book-card">
        <h3 class="bascik__book-card__title">Shipping Small Changes</h3>
        <p class="bascik__book-card__author">Sam Rivera</p>
        <span class="bascik__book-card__badge">Paperback</span>
        <button
          class="bascik__book-card__save"
          type="button"
          aria-pressed="false"
          data-testid="book-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/book-card/book-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (!document.documentElement.hasAttribute("data-book-card-save")) {
            document.documentElement.setAttribute("data-book-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__book-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/book-card/book-card.js
      </script>
    </div>
  </body>
</html>
```

The Preview is drawn by this docs site's static build from the same three `<book-card>` tags, because the docs site has no server to run the script. A tag renders the same way at build time and at request time.

Run this on Cloudflare Workers: [/catalog?q=monolith](https://cloudflare-adapter.bascik.dev/catalog?q=monolith).

### A card with its own server script

A returned component can carry its own `data-bascik-server` script. Here the featured page returns one `<book-card>` whose badge slot holds a `<stock-line>`, a component made of a server script and a stylesheet. Bascik runs the stock line's script once per rendered instance at request time, with the same `request`, `context`, and `signal` as the page script and with what is left of the page script's `scripts.timeout`. The script receives no props from the usage tag, so it reads only the request; pass per-instance values as props to a component's markup instead. Its output is spliced into the card before the response is sent, and its `stock` class is scoped like the card's.

Keep such a script class-only: a script body that names one of the component's ids cannot serve every instance, so the component is left unexpanded (see [Request-Time Component Rendering](/compatibility#request-time-component-rendering)).

<!-- demo:rtc-live-source-usage -->

```html
<!-- src/pages/featured.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Featured</title>
  </head>
  <body>
    <div class="featured">
      <script data-bascik-server>
        export default function () {
          return `<book-card data-bascik-prop-title="Refactoring the Monolith" data-bascik-prop-author="Grace Lin"><stock-line></stock-line></book-card>`;
        }
      </script>
    </div>
  </body>
</html>
```

<!-- demo:rtc-live-source-html -->

```html
<!-- src/components/stock-line/stock-line.html -->
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const path = new URL(request.url).pathname;
    const text = `3 copies left · checked for ${path} at request time`;
    return html`<span class="stock">${text}</span>`;
  }
</script>
```

<!-- demo:rtc-live-source-css -->

```css
/* src/components/stock-line/stock-line.css */
.stock {
  color: #d3ff8d;
  font-weight: 600;
}
```

The Output is the body `bascik --server` sent for `GET /featured`, built with the same config. There is no Preview: the stock line exists only per request, and this docs site cannot run a server script.

<!-- demo:rtc-live-output-html -->

```html
<!-- src/pages/featured.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Featured</title>
  </head>
  <body>
    <div class="featured">
      <style>
        .bascik__book-card__card {
          display: grid;
          gap: 6px;
          padding: 16px;
          border: 1px solid #3a3d40;
          border-radius: 12px;
          background: #242628;
          color: #f0f1f2;
        }

        .bascik__book-card__title {
          margin: 0;
          font-size: 1rem;
        }

        .bascik__book-card__author {
          margin: 0;
          color: #8d929e;
        }

        .bascik__book-card__badge {
          justify-self: start;
          padding: 2px 10px;
          border-radius: 999px;
          background: rgba(211, 255, 141, 0.15);
          color: #d3ff8d;
          font-size: 0.75rem;
          font-weight: 600;
        }

        .bascik__book-card__save {
          justify-self: start;
          padding: 4px 12px;
          border: 1px solid #3a3d40;
          border-radius: 8px;
          background: transparent;
          color: #f0f1f2;
          cursor: pointer;
        }

        .bascik__book-card__save[aria-pressed="true"] {
          border-color: rgba(211, 255, 141, 0.6);
          color: #d3ff8d;
        }</style
      ><style>
        .bascik__stock-line__stock {
          color: #d3ff8d;
          font-weight: 600;
        }</style
      ><!-- src/components/book-card/book-card.html -->
      <article class="bascik__book-card__card" data-testid="book-card">
        <h3 class="bascik__book-card__title">Refactoring the Monolith</h3>
        <p class="bascik__book-card__author">Grace Lin</p>
        <span class="bascik__book-card__badge"
          ><!-- src/components/stock-line/stock-line.html -->
          <span class="bascik__stock-line__stock"
            >3 copies left · checked for /featured at request time</span
          >
        </span>
        <button
          class="bascik__book-card__save"
          type="button"
          aria-pressed="false"
          data-testid="book-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/book-card/book-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (!document.documentElement.hasAttribute("data-book-card-save")) {
            document.documentElement.setAttribute("data-book-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__book-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/book-card/book-card.js
      </script>
    </div>
  </body>
</html>
```

Run this on Cloudflare Workers: the [live card on /catalog](https://cloudflare-adapter.bascik.dev/catalog).

## Server Scripts vs API Routes

Both `data-bascik-server` script blocks and [API Routes](/api-routes) run in-process through Bascik's script registry at request time, receiving the same `Request` object, but they serve different architectural purposes:

| Feature              | Server Scripts (`data-bascik-server`)                  | API Routes (`src/api/*.ts`)                                   |
| :------------------- | :----------------------------------------------------- | :------------------------------------------------------------ |
| **Destination**      | Injected directly into HTML pages                      | Standalone JSON, streaming, or binary HTTP endpoints          |
| **Methods**          | `GET` and `HEAD` (page render)                         | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`    |
| **Contract**         | Takes WHATWG `Request`, returns markup                 | Takes WHATWG `Request`, returns WHATWG `Response`             |
| **Response Control** | Cannot set HTTP status code or custom headers          | Full control over status codes, response headers, and cookies |
| **Use Cases**        | Page personalization, user greetings, auth state in UI | Form submissions, webhook receivers, authenticated REST APIs  |

Use `data-bascik-server` when rendering HTML into the document flow. Use API routes when returning data, receiving client submissions, or controlling response headers.

## Rules and Behavior

- A server script must `export default` a function. Any ES module form counts: `export default handler`, `export { handler as default }`, `export { default } from "./helper.ts"`. A script without one is a located build error naming the file and line.
- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are stripped and stored in `.bascik/dist/server-scripts.json`, leaving inert `<script type="text/bascik-server">` placeholders in the static HTML.
- Execution happens when served by `bascik` (dev server), `bascik --server` (production server), or a generated serverless function built with a `--target` such as the [Cloudflare Adapter](/deployment/cloudflare). A static-only host leaves the placeholders inert.
- On error, `scripts.onServerScriptError` controls behavior: `'error'` responds with HTTP 500, `'warn'` logs to stderr and replaces the tag with an empty string, and `'ignore'` replaces it with an empty string without a log. Stack traces remap to your original source file line and column.
- A returned array is joined with no separator. A return that is not markup (a plain object, a `Response`, a function, an array holding a Promise) is an empty slot with a located report: an error under the policy in dev, a once-per-script warning in production. See [Return Values](#return-values).
- Directives (`data-bascik-server`, `data-bascik-stream`, `data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`) are mutually exclusive and cannot be combined on the same tag.

> **Next:** See [Stream Scripts](/scripts/stream) for chunked streaming scripts (`data-bascik-stream`), or consult the [Production Server](/production-server) reference for server runtime configuration.

<!-- demo:source-usage -->

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const name = request.headers.get("x-display-name") ?? "Guest";
    return html`
      <aside>
        <strong>Session Active</strong>
        <p>Logged in as ${name}</p>
      </aside>
    `;
  }
</script>
```

<!-- demo:output-html -->

```html
<!-- The script tag is replaced by its returned markup per request -->
<aside>
  <strong>Session Active</strong>
  <p>Logged in as Jane Doe</p>
</aside>
```
