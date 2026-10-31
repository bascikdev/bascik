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
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const name = request.headers.get("x-display-name") ?? "Guest";
    return html`<p class="greeting">Hello, ${name}!</p>`;
  }
</script>
```

`html` from `@bascik/bascik/html` escapes each value for where it lands, so a header that holds markup comes back as text. See [Escaping and injection](#escaping-and-injection).

This recording shows a real dev server running a server script that lives in a component. Every request runs the script again: a new query string renders a new name, and reloading the same URL renders a new time. Nothing is rebuilt between requests:

![An editor above a browser. The editor shows hello-user.html, a component holding one data-bascik-server script that reads a name from the query string, escapes it, and returns a heading and the current time. The browser loads /greet?name=Ada and shows Hello, Ada!, then loads /greet?name=Grace and shows Hello, Grace!, then reloads and shows a later time](/assets/demos/server-request@2x.webp)

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

The Output is the `<body>` that `bascik --server` sent for `GET /hello?name=Ada`, built with minification off. There is no Preview because this docs site is static and runs no server script.

<!-- demo:ts-server-output-html -->

```html
<p>Hello, Ada</p>
```

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

A nested `html` value, or an array of them, is inserted as it is, so `${items.map((item) => html`<li>${item}</li>`)}` needs no `.join("")`. `null`, `undefined` and `false` render as nothing. The [Security](/security) page explains what Bascik guarantees and what is yours, and [HTML Helpers](/html-helpers) lists every context, helper and error.

### Trusted vs untrusted data

- **Untrusted data:** Anything from `request` (headers, URL, query parameters, cookies), any database column that was ever user input, and any third-party API response is untrusted.
- **Trusted data:** Markup you wrote directly in the template is trusted.

Escape once, at output. Do not store escaped strings.

The helpers are plain functions you import; nothing is injected into scope. Besides `html`, `@bascik/bascik/html` exports `raw` (trusted HTML), `esc` (an escaped string), `safeUrl` (a checked URL) and `json` (JSON for a JSON `<script>`). Your script still sees only `request`, `context`, `signal`, and what it imports.

> **Without html.** Code that builds markup as plain strings must escape each text or quoted-attribute value itself, with `esc(value)` from the same module or a five-character escaper such as `String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])`, and check each URL with `safeUrl(value)`. An escaper does nothing for a `javascript:` URL, an event handler, a `<script>` body or an unquoted attribute, which is why `html` reads where each value lands.

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

Import it from any server script using the `@/` import root alias (see [Script Imports](/script-imports)):

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

A server script can return the tags of your own components. Bascik renders each tag at request time with the component's markup, props, slots, and scoped CSS, the same way it renders a tag written in a page. There is nothing to import and nothing to configure: a site with any server or stream script gets this automatically.

> **See it live on Cloudflare Workers.** The [product catalog](https://cloudflare-adapter.bascik.dev/catalog?q=frother) on the Cloudflare demo site searches with `?q=` and renders one `<product-card>` per match, next to a card with its own server script. The [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream) streams the same cards in batches.

### Render a card per search result

A common case is a search page that renders the site's shared card for each result. The card is an ordinary component: two props, a default slot for its badge, a companion stylesheet, and a client script for its Save button.

The search page's server script returns one `<product-card>` per match, built with `html`, which escapes the product's values into the props and the slot. A product with no badge leaves the slot empty, so its card keeps the `Standard` fallback. A real site would read the products from a database or an API; here they are inline so the page works as pasted. The first line of each block names the file's path. The page, HTML, and JS path comments are ordinary comments, so they also appear in the Output; the CSS comment is dropped.

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
      <input type="search" name="q" aria-label="Search products" />
      <button>Search</button>
    </form>
    <div class="results">
      <script data-bascik-server>
        // html escapes each value for where it lands: /server-scripts#escaping-and-injection
        import { html } from "@bascik/bascik/html";

        const catalog = [
          { name: "Milk frother", price: "$129", badge: "Best seller" },
          { name: "Pour-over kettle", price: "$48", badge: "New" },
          { name: "Glass carafe", price: "$31" },
        ];

        export default function (request) {
          const q = (new URL(request.url).searchParams.get("q") ?? "")
            .trim()
            .toLowerCase();
          const products = catalog.filter((p) =>
            p.name.toLowerCase().includes(q),
          );
          if (products.length === 0) {
            return html`<p>No products match "${q}".</p>`;
          }
          return html`${products.map(
            (p) =>
              html`<product-card
                data-bascik-prop-name="${p.name}"
                data-bascik-prop-price="${p.price}"
                >${p.badge}</product-card
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
<!-- src/components/product-card/product-card.html -->
<article class="card" data-testid="product-card">
  <h3 class="name" data-bascik-prop-name>Unnamed product</h3>
  <p class="price" data-bascik-prop-price>Price on request</p>
  <span class="badge"><span data-bascik-slot>Standard</span></span>
  <button
    class="save"
    type="button"
    aria-pressed="false"
    data-testid="product-card-save"
  >
    Save
  </button>
</article>
<script src="product-card.js"></script>
```

<!-- demo:rtc-search-source-css -->

```css
/* src/components/product-card/product-card.css */
.card {
  display: grid;
  gap: 6px;
  padding: 16px;
  border: 1px solid #3a3d40;
  border-radius: 12px;
  background: #242628;
  color: #f0f1f2;
}

.name {
  margin: 0;
  font-size: 1rem;
}

.price {
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
// src/components/product-card/product-card.js
// One click listener serves every card on the page. The text is the same in
// every instance (no scoped id), so one CSP hash covers cards a server script
// renders at request time too.
if (!document.documentElement.hasAttribute("data-product-card-save")) {
  document.documentElement.setAttribute("data-product-card-save", "");
  document.addEventListener("click", (event) => {
    const save = event.target.closest(".save");
    if (save === null) return;
    const saved = save.getAttribute("aria-pressed") !== "true";
    save.setAttribute("aria-pressed", String(saved));
    save.textContent = saved ? "Saved" : "Save";
  });
}
```

A request for `/search` with no query matches all three products. The Output is the body `bascik --server` sent for `GET /search`, reformatted for reading. It was built with minification off, as every output example in these docs is; with the defaults, the markup is minified and the class names are short hashes. The card's stylesheet arrives once, as one `<style>` right before the first card, and one click listener serves every Save button, finding the card it belongs to with `closest`. The script has no scoped id, so its text is the same in every card, and one [Content-Security-Policy](/how-to/content-security-policy#components-rendered-at-request-time) hash covers the cards a server script renders. A request for `/search?q=frother` gets the Milk frother card alone.

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  minify: { html: false, css: false, js: false, identifiers: false },
});
```

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
      <input type="search" name="q" aria-label="Search products" />
      <button>Search</button>
    </form>
    <div class="results">
      <style>
        .bascik__product-card__card {
          display: grid;
          gap: 6px;
          padding: 16px;
          border: 1px solid #3a3d40;
          border-radius: 12px;
          background: #242628;
          color: #f0f1f2;
        }

        .bascik__product-card__name {
          margin: 0;
          font-size: 1rem;
        }

        .bascik__product-card__price {
          margin: 0;
          color: #8d929e;
        }

        .bascik__product-card__badge {
          justify-self: start;
          padding: 2px 10px;
          border-radius: 999px;
          background: rgba(211, 255, 141, 0.15);
          color: #d3ff8d;
          font-size: 0.75rem;
          font-weight: 600;
        }

        .bascik__product-card__save {
          justify-self: start;
          padding: 4px 12px;
          border: 1px solid #3a3d40;
          border-radius: 8px;
          background: transparent;
          color: #f0f1f2;
          cursor: pointer;
        }

        .bascik__product-card__save[aria-pressed="true"] {
          border-color: rgba(211, 255, 141, 0.6);
          color: #d3ff8d;
        }</style
      ><!-- src/components/product-card/product-card.html -->
      <article class="bascik__product-card__card" data-testid="product-card">
        <h3 class="bascik__product-card__name">Milk frother</h3>
        <p class="bascik__product-card__price">$129</p>
        <span class="bascik__product-card__badge">Best seller</span>
        <button
          class="bascik__product-card__save"
          type="button"
          aria-pressed="false"
          data-testid="product-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/product-card/product-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (
            !document.documentElement.hasAttribute("data-product-card-save")
          ) {
            document.documentElement.setAttribute("data-product-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__product-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/product-card/product-card.js
      </script>
      <!-- src/components/product-card/product-card.html -->
      <article class="bascik__product-card__card" data-testid="product-card">
        <h3 class="bascik__product-card__name">Pour-over kettle</h3>
        <p class="bascik__product-card__price">$48</p>
        <span class="bascik__product-card__badge">New</span>
        <button
          class="bascik__product-card__save"
          type="button"
          aria-pressed="false"
          data-testid="product-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/product-card/product-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (
            !document.documentElement.hasAttribute("data-product-card-save")
          ) {
            document.documentElement.setAttribute("data-product-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__product-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/product-card/product-card.js
      </script>
      <!-- src/components/product-card/product-card.html -->
      <article class="bascik__product-card__card" data-testid="product-card">
        <h3 class="bascik__product-card__name">Glass carafe</h3>
        <p class="bascik__product-card__price">$31</p>
        <span class="bascik__product-card__badge">Standard</span>
        <button
          class="bascik__product-card__save"
          type="button"
          aria-pressed="false"
          data-testid="product-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/product-card/product-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (
            !document.documentElement.hasAttribute("data-product-card-save")
          ) {
            document.documentElement.setAttribute("data-product-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__product-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/product-card/product-card.js
      </script>
    </div>
  </body>
</html>
```

The Preview is drawn by this docs site's static build from the same three `<product-card>` tags, because the docs site has no server to run the script. A tag renders the same way at build time and at request time.

Run this on Cloudflare Workers: [/catalog?q=frother](https://cloudflare-adapter.bascik.dev/catalog?q=frother).

### A card with its own server script

A returned component can carry its own `data-bascik-server` script. Here the featured page returns one `<product-card>` whose badge slot holds a `<stock-line>`, a component made of a server script and a stylesheet. Bascik runs the stock line's script once per rendered instance at request time, with the same `request`, `context`, and `signal` as the page script and with what is left of the page script's `scripts.timeout`. The script receives no props from the usage tag, so it reads only the request; pass per-instance values as props to a component's markup instead. Its output is spliced into the card before the response is sent, and its `stock` class is scoped like the card's.

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
          return `<product-card data-bascik-prop-name="Milk frother" data-bascik-prop-price="$129"><stock-line></stock-line></product-card>`;
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
    const text = `In stock · checked for ${path} at request time`;
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
        .bascik__product-card__card {
          display: grid;
          gap: 6px;
          padding: 16px;
          border: 1px solid #3a3d40;
          border-radius: 12px;
          background: #242628;
          color: #f0f1f2;
        }

        .bascik__product-card__name {
          margin: 0;
          font-size: 1rem;
        }

        .bascik__product-card__price {
          margin: 0;
          color: #8d929e;
        }

        .bascik__product-card__badge {
          justify-self: start;
          padding: 2px 10px;
          border-radius: 999px;
          background: rgba(211, 255, 141, 0.15);
          color: #d3ff8d;
          font-size: 0.75rem;
          font-weight: 600;
        }

        .bascik__product-card__save {
          justify-self: start;
          padding: 4px 12px;
          border: 1px solid #3a3d40;
          border-radius: 8px;
          background: transparent;
          color: #f0f1f2;
          cursor: pointer;
        }

        .bascik__product-card__save[aria-pressed="true"] {
          border-color: rgba(211, 255, 141, 0.6);
          color: #d3ff8d;
        }</style
      ><style>
        .bascik__stock-line__stock {
          color: #d3ff8d;
          font-weight: 600;
        }</style
      ><!-- src/components/product-card/product-card.html -->
      <article class="bascik__product-card__card" data-testid="product-card">
        <h3 class="bascik__product-card__name">Milk frother</h3>
        <p class="bascik__product-card__price">$129</p>
        <span class="bascik__product-card__badge"
          ><!-- src/components/stock-line/stock-line.html -->
          <span class="bascik__stock-line__stock"
            >In stock · checked for /featured at request time</span
          >
        </span>
        <button
          class="bascik__product-card__save"
          type="button"
          aria-pressed="false"
          data-testid="product-card-save"
        >
          Save
        </button>
      </article>
      <script>
        (function () {
          // src/components/product-card/product-card.js
          // One click listener serves every card on the page. The text is the same in
          // every instance (no scoped id), so one CSP hash covers cards a server script
          // renders at request time too.
          if (
            !document.documentElement.hasAttribute("data-product-card-save")
          ) {
            document.documentElement.setAttribute("data-product-card-save", "");
            document.addEventListener("click", (event) => {
              const save = event.target.closest(".bascik__product-card__save");
              if (save === null) return;
              const saved = save.getAttribute("aria-pressed") !== "true";
              save.setAttribute("aria-pressed", String(saved));
              save.textContent = saved ? "Saved" : "Save";
            });
          }
        })();
        //# sourceURL=src/components/product-card/product-card.js
      </script>
    </div>
  </body>
</html>
```

Run this on Cloudflare Workers: the [live card on /catalog](https://cloudflare-adapter.bascik.dev/catalog).

### Security

An escaping bug in a script that returns component tags reaches further than one in a script that returns plain HTML. A visitor whose text lands in the output unescaped can write any of your components' tags, with props, slots, and attributes of their choosing, and each component's own server and stream scripts then run with the current request. Build the output with `html`, as in [Escaping and injection](#escaping-and-injection), and see [Security](/security) for the whole picture.

When the values are escaped, Bascik guarantees the following, on the dev server, `bascik --server`, and Cloudflare Workers alike, and for the same tag written in a page at build time. The binding checks can be turned off by name with [`security.blockScriptUrls`](/configuration#security) and [`security.blockCodeBindings`](/configuration#security), recorded at build time, and the budgets are set with [`scripts.renderLimits`](/configuration#scriptsrenderlimits):

- **A prop is text.** Its value is decoded once (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&#x27;`) and escaped again where it lands, so it becomes element text or one attribute value, never markup. A prop receiver on a `<script>` or `<style>` is never filled, because no escaping keeps a value from running as code there.
- **Bindings are checked for where they land.** A prop bound to a URL attribute becomes `about:invalid` when it holds one of the script URLs such as `javascript:`, or a non-image `data:` URL (an image slot such as `<img src>` keeps a `data:image/...` one). This is the same rule `html` applies. Any other URL, on your site or another, is kept as the browser would take it, including where the page runs or applies what it loads (`<script src>`, `<base href>`, a stylesheet `<link href>`); see [Loading scripts and styles from other sites](/security#loading-scripts-and-styles-from-other-sites) for how to restrict those. SVG animation values (`to`, `from`, `by`, `values`) get the URL check too. A prop is never bound to an `on*` event handler, `srcdoc`, a `<meta http-equiv>` value, or the attribute an SVG animation sets, nor to a `style` that runs script or imports CSS. See [Put a Prop in an Attribute](/props#put-a-prop-in-an-attribute).
- **Inherited attributes keep their quoting.** A usage attribute escaped for its own quote character stays one attribute on the component's root, whatever quote the root uses. Values are inherited as written, with one exception described in [Attributes That Become URLs on the Root](/attribute-inheritance#attributes-that-become-urls-on-the-root).
- **Slot content is HTML.** It is your markup, like the rest of the output, so escape the text you put in a slot.
- **Nested scripts get no usage data.** A script inside a returned component receives the request, never the usage tag's props, slot, or attributes, so a visitor cannot hand it a URL to fetch. It runs within the budgets below: 64 nested scripts and 4 levels per response, inside the page script's remaining timeout.
- **Markers cannot be forged.** Only the markers Bascik creates for the current request run nested scripts. A placeholder, marker, or escaped tag spelled in the output is text.
- **Hostile output fails fast.** Tags nested hundreds of levels deep around long text, or left unclosed ahead of a closing tag of the same name, usually unescaped visitor text, make the renderer read the output again once per nested tag. (Tags cut off mid-tag cost no rereading: each instance is spliced in where the cut leaves it.) Rereading is limited to 16 times the output's length plus 33,554,432 characters per script output (a fraction of a second of work); past that the script fails like any other budget.

With [`generate.cspHashes`](/how-to/content-security-policy#server-and-stream-scripts), a hash-only Content-Security-Policy still blocks a `<script>` or `<style>` a visitor writes. A route with a server or stream script, though, lists the hashes of every component that can be rendered at request time, since any of them can be returned. A component tag injected through an escaping bug therefore runs that component's own client script, with its usual text, on elements whose props, classes, and inherited attributes the visitor chose. Write component scripts that treat their own markup as data, never as code.

### Rules for returned tags

These rules apply to every tag a server script returns:

- **Script output is HTML, rendered with the same power as your own markup.** Every component tag in it is expanded, and the component's own server and stream scripts run with the current request. Escape each value you put into a prop or slot, and sanitize HTML from a CMS or an API before returning it: a tag in that HTML renders your component, and an ordinary `<script>` or `on*` attribute in it reaches the browser.
- **Scripts inside a returned component run.** A `data-bascik-server` or `data-bascik-stream` script inside the component runs once per rendered instance, with the same `request`, `context`, and `signal`, and with what is left of the page script's `scripts.timeout`. It receives no props from the usage tag; pass per-instance values as props to the component's markup instead. Its errors follow `scripts.onServerScriptError` like the page's own scripts: under `'error'` the response is a 500, and under `'warn'` or `'ignore'` that script's slot is empty and the rest of the card is kept.
- **Budgets.** One script output may expand to 1000 component instances and 4 MiB (4,194,304 characters) of rendered HTML, and may make the renderer reread at most 16 times its length plus 33,554,432 characters (see [Security](#security)). One response may run 64 nested component scripts, nested at most 4 levels deep (a script returning a component whose script returns a component, and so on). Over a budget, the script fails with a message naming the route and the component file. The failure follows `scripts.onServerScriptError` like a script that throws: under `'error'` (the default) a server script's response is a 500 and a stream script's slot is empty with the error logged, `'warn'` logs it and leaves the slot empty, and `'ignore'` leaves the slot empty without a log. Nothing of the over-budget output is sent: the whole slot of the page's script is empty, nested components included. Output with no component tag in it is never measured. Each budget is a server setting in [`scripts.renderLimits`](/configuration#scriptsrenderlimits), and its message names the key to raise.
- **CSS is emitted in the body, before the first instance.** Each component's stylesheet is sent as one `<style>` block right before the output that holds its first instance in document order, once per response, whatever order the scripts finish in. A page with both server and stream scripts may send it once for each. A component that is also used in the page's own markup gets a second, identical block. A component whose CSS embeds the instance id (`url(#id)`, or `scoping.deduplicateCss: false`) gets one block per instance. Because the block sits in the body, unscoped rules in such a component (`body`, `*`, `@import`) restyle the whole page.
- **Client scripts run in place.** A component's `<script>` stays inside its rendered instance, as in the dev server. With `minify.html` on it moves to the end of the outermost rendered instance, never to the end of the document, so look up elements outside the component inside an event handler. See [Where Component Scripts Run](/scoped-javascript#where-component-scripts-run).
- **Base paths are rewritten inside rendered components.** With a non-root [`base`](/configuration#base), URLs in the component's markup, its props, and its slot content are rewritten as at build time. The rest of the script's output is sent as written, so prefix your own URLs.
- **`components.external` names are sent as written.** A tag listed in `components.external` with no component file, such as a third-party web component, is never expanded or logged. A component file with the same name still renders, as it does at build time.
- **Only markup is rendered.** A tag inside `<script>`, `<style>`, `<textarea>`, a comment, or an attribute value, or an escaped one (`&lt;product-card&gt;`), stays text. A `data-bascik-server` or other directive script in the output never runs on the server; it is sent as written, like the rest of the output.
- **Unsupported components and misspelled tags are left as written.** A few component shapes cannot be rendered at request time, such as a component that binds a prop to its `class` or `id` with `data-bascik-attr-*`. Their tags, and tags with no component file, reach the browser unexpanded. When at least one component can be rendered at request time, the dev server logs each one once per route and tag. After a build, `bascik --check` lists the unsupported components with the reason; it does not see misspelled tags, which exist only in a script's output at request time. See [Request-Time Component Rendering](/compatibility#request-time-component-rendering) for each reason and how to restructure the component.

Request-time rendering needs a host that runs server scripts: the [dev server](/development-server), the [production server](/production-server), or the [Cloudflare Adapter](/deployment/cloudflare). The Cloudflare demo renders the same shape live: a [product catalog](https://cloudflare-adapter.bascik.dev/catalog?q=frother) and its [streamed version](https://cloudflare-adapter.bascik.dev/catalog-stream). [Stream scripts](/stream-scripts#returning-component-tags) return component tags under the same rules.

## Server Scripts vs API Routes

Both `data-bascik-server` script blocks and [API Routes](/api-routes) run in-process through Bascik's script registry at request time, receiving the same `Request` object, but they serve different architectural purposes:

| Feature              | Server Scripts (`data-bascik-server`)                  | API Routes (`src/api/*.ts`)                                   |
| :------------------- | :----------------------------------------------------- | :------------------------------------------------------------ |
| **Destination**      | Injected directly into HTML pages                      | Standalone JSON, streaming, or binary HTTP endpoints          |
| **Methods**          | `GET` and `HEAD` (page render)                         | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`    |
| **Contract**         | Takes WHATWG `Request`, returns HTML string            | Takes WHATWG `Request`, returns WHATWG `Response`             |
| **Response Control** | Cannot set HTTP status code or custom headers          | Full control over status codes, response headers, and cookies |
| **Use Cases**        | Page personalization, user greetings, auth state in UI | Form submissions, webhook receivers, authenticated REST APIs  |

Use `data-bascik-server` when rendering HTML into the document flow. Use API routes when returning data, receiving client submissions, or controlling response headers.

## Rules and Behavior

- A server script must `export default` a function. Any ES module form counts: `export default handler`, `export { handler as default }`, `export { default } from "./helper.ts"`. A script without one is a located build error naming the file and line.
- Scripts run on **every request** and are **never cached:** the output is always fresh.
- During `bascik --build`, server script tags are stripped and stored in `.bascik/dist/server-scripts.json`, leaving inert `<script type="text/bascik-server">` placeholders in the static HTML.
- Execution happens when served by `bascik` (dev server), `bascik --server` (production server), or a generated serverless function built with a `--target` such as the [Cloudflare Adapter](/deployment/cloudflare). A static-only host leaves the placeholders inert.
- On error, `scripts.onServerScriptError` controls behavior: `'error'` responds with HTTP 500, `'warn'` logs to stderr and replaces the tag with an empty string, and `'ignore'` replaces it with an empty string without a log. Stack traces remap to your original source file line and column.
- Directives (`data-bascik-server`, `data-bascik-stream`, `data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`) are mutually exclusive and cannot be combined on the same tag.

> **Next:** See [Stream Scripts](/stream-scripts) for chunked streaming scripts (`data-bascik-stream`), or consult the [Production Server](/production-server) reference for server runtime configuration.

<!-- demo:source-usage -->

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default function (request) {
    const name = request.headers.get("x-display-name") ?? "Guest";
    return html`
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
