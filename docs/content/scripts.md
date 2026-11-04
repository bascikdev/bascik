# Overview

A Bascik page can run your own JavaScript or TypeScript on the server, in a `<script>` tag marked with a `data-bascik-*` directive. Part of a page can be written once when the site is built, part on every request, and part streamed in after the rest of the page has arrived. None of these scripts ships to the browser: the tag is replaced by what the script returns.

## Choosing a script

| Script                   | When it runs                                                                   | What it returns                                 | Guide                                                  |
| :----------------------- | :----------------------------------------------------------------------------- | :---------------------------------------------- | :----------------------------------------------------- |
| `data-bascik-build`      | At build time and on the dev server, once for each page that uses it           | HTML that replaces the tag                      | [Build Scripts](/scripts/build)                        |
| `data-bascik-build-once` | At build time and on the dev server, once for each file, whatever pages use it | HTML that replaces the tag, the same everywhere | [Build Scripts](/scripts/build#data-bascik-build-once) |
| `data-bascik-routes`     | At build time, once per dynamic route template                                 | An array of `{ params, data }` route objects    | [Dynamic Routes](/scripts/dynamic-routes)              |
| `data-bascik-server`     | On every request, before the response headers are sent                         | HTML that replaces the tag                      | [Server Scripts](/scripts/server)                      |
| `data-bascik-stream`     | On every request, after the page shell has been sent                           | HTML streamed into the tag's place              | [Stream Scripts](/scripts/stream)                      |

Build and routes scripts each run in their own Node.js process, and what they produce is fixed in `dist/`. Server and stream scripts run inside whatever answers the request: the [dev server](/development-server), the [production server](/production-server), or a serverless function such as the [Cloudflare Adapter](/deployment/cloudflare). A static host serves the build output and runs neither.

Two other kinds of server code sit beside these. [API Routes](/api-routes) are files in `src/api/` that answer a request with a `Response` of their own, and [Exec Scripts](/exec-scripts) run commands before, alongside, or after the build.

## See it in action

This book page uses a build script, a server script, and a stream script. The build script writes the chapter list once, when the site is built. The server script greets the visitor by reading `?name=` on every request. The stream script fetches the rating from a slow reviews service. The rest of the page is already on screen while it waits, and the rating replaces the "Loading rating" line when it arrives.

![An editor above a browser. The editor shows book.html with a build script, a server script, and a stream script. The browser loads /book?name=Ada: the title, the chapter list, and Welcome back, Ada. appear at once with Loading rating, and Rated 4.6 out of 5 replaces it a moment later. Loading /book?name=Grace greets Grace, and the rating streams in again](/assets/demos/scripts-page@2x.webp)

<!-- demo:scripts-page-usage -->

```html
<!-- src/pages/book.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Refactoring the Monolith</title>
    <style>
      .rating:has(.score) .pending {
        display: none;
      }
    </style>
  </head>
  <body>
    <h1>Refactoring the Monolith</h1>
    <script data-bascik-build type="text/typescript">
      import { html, type SafeHtml } from "@bascik/bascik/html";
      // Runs once, at build time. The list is part of the built page.
      const chapters: string[] = [
        "Find the seams",
        "Strangle the edges",
        "Ship in slices",
      ];
      export default (): SafeHtml =>
        html`<ol>
          ${chapters.map((chapter) => html`<li>${chapter}</li>`)}
        </ol>`;
    </script>
    <script data-bascik-server type="text/typescript">
      import { html, type SafeHtml } from "@bascik/bascik/html";
      // Runs on every request, before the response starts.
      export default (request: Request): SafeHtml => {
        const query = new URL(request.url).searchParams;
        const name = query.get("name") ?? "reader";
        return html`<p>Welcome back, ${name}.</p>`;
      };
    </script>
    <div class="rating">
      <p class="pending">Loading rating…</p>
      <script data-bascik-stream type="text/typescript">
        import { html, type SafeHtml } from "@bascik/bascik/html";
        // Runs on every request, after the page above has been sent.
        export default async (): Promise<SafeHtml> => {
          // Waits like a slow reviews service.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return html`<p class="score">Rated 4.6 out of 5</p>`;
        };
      </script>
    </div>
  </body>
</html>
```

The Output is the whole `<body>` that `bascik --server` sent for `GET /book?name=Ada`, reformatted for reading. Each script tag is gone, replaced by what it returned, and no script reaches the browser. There is no Preview because this docs site is static and runs no server or stream script.

<!-- demo:scripts-page-output-html -->

```html
<h1>Refactoring the Monolith</h1>
<ol>
  <li>Find the seams</li>
  <li>Strangle the edges</li>
  <li>Ship in slices</li>
</ol>
<p>Welcome back, Ada.</p>
<div class="rating">
  <p class="pending">Loading rating…</p>
  <p class="score">Rated 4.6 out of 5</p>
</div>
```

Run this on Cloudflare Workers: the [mixed server and stream page](https://cloudflare-adapter.bascik.dev/mixed) renders a server script before its headers are sent, then streams a stream script into the open connection.

## Rules for every script

- **A default export.** Bascik calls the module's default export and uses what it returns, or what its promise resolves to.
- **Imports.** Top-level `import` and `await` work. Relative imports resolve from the file the script is written in, `@/` resolves from the import root, and installed npm packages resolve as usual. See [Script Imports](/scripts/imports).
- **TypeScript.** A script is TypeScript when its tag is marked `type="text/typescript"` or its `src` names a `.ts` or `.mts` file. Bascik strips the types before it runs, so errors name your source lines. See [TypeScript](/scripts/build#typescript).
- **Escaping.** Build, server, and stream scripts return HTML. Build it with `html` from `@bascik/bascik/html`, which escapes each value for where it lands. See [Security](/scripts/security).
- **Errors.** A failure is reported with a stack trace that points at your source. What happens next is set per kind: `scripts.onBuildScriptError`, `scripts.onRoutesScriptError`, and `scripts.onServerScriptError` (server and stream scripts) each take `'error'`, `'warn'`, or `'ignore'`. See [`scripts`](/configuration#scripts).
- **Time limits.** Build and routes scripts are stopped after 60 seconds. Server and stream scripts are bounded by `scripts.timeout` (30 seconds by default) and receive an `AbortSignal` to pass to `fetch()` and database clients. See [Timeouts and Cancellation](/scripts/server#timeouts-and-cancellation-abortsignal).

## Environment variables

Every script reads its environment through `process.env`. On Node, values from your shell and from `./.env`, which Bascik loads at startup, are there in every kind. Bascik adds its own `BASCIK_*` variables, and which ones a script gets depends on where it runs:

| Script                                        | Bascik variables                                                                                                                                                          |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-bascik-build`                           | `BASCIK_PAGE_PATH`, `BASCIK_PAGE_FILE`, `BASCIK_SOURCE_FILE`, `BASCIK_PAGES_DIR`, `BASCIK_BASE`, `BASCIK_BUILD`, `BASCIK_SITE_URL`, and `BASCIK_ROUTE` in a dynamic route |
| `data-bascik-build-once`                      | The same, without page context: `BASCIK_PAGE_PATH` and `BASCIK_PAGE_FILE` are empty and `BASCIK_ROUTE` is unset                                                           |
| `data-bascik-routes`                          | `BASCIK_PAGE_PATH` (the template's path), `BASCIK_PAGE_FILE`, `BASCIK_SOURCE_FILE`, `BASCIK_PAGES_DIR`, `BASCIK_BUILD`, `BASCIK_SITE_URL`                                 |
| `data-bascik-server` and `data-bascik-stream` | `BASCIK_SERVER`, `BASCIK_BUILD`, and `BASCIK_SITE_URL`                                                                                                                    |

`BASCIK_SITE_URL` is present only when a site URL is set, with `--site-url`, the environment, or `.env`. Server and stream scripts read the environment of the server process, so they get no page variables: read the page from `request.url` instead. `BASCIK_SERVER` is `"1"` under `bascik --server` and `"0"` on the dev server.

On Cloudflare Workers, Bascik does not fill `process.env`. Read secrets and bindings from `context.platform.env`; see [Bindings and secrets](/deployment/cloudflare#bindings-and-secrets). On Netlify, environment variables stay in `process.env`.

> **Secrets.** A value a build script prints is baked into a page in `dist/`, where every visitor can read it. Read API keys and database credentials in server and stream scripts, or in [API Routes](/api-routes), and return only what the page should show.

Each variable is described in [Environment Variables](/environment-variables). A build script whose output depends on a variable of your own must list it in `scripts.cache.environment`, or a cached result from the previous value is reused; see [Declaring environment inputs](/scripts/build#declaring-environment-inputs).

## Returning component tags

Any script can return the tags of your own components, and Bascik renders each one with the component's markup, props, slots, and scoped CSS, the same way it renders a tag written in a page. A build script's tags render once at build time; a server or stream script's tags render on every request. There is nothing to import and nothing to configure. The example, rules, and limits below are for server and stream scripts, whose output renders per request.

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";
  import { searchBooks } from "@/lib/books.ts";

  export default async (request) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const books = await searchBooks(q);
    return html`${books.map(
      (book) =>
        html`<book-card
          data-bascik-prop-title="${book.title}"
          data-bascik-prop-author="${book.author}"
        ></book-card>`,
    )}`;
  };
</script>
```

Worked examples, with the Output each one sends: [Render a card per search result](/scripts/server#render-a-card-per-search-result) and [A card with its own server script](/scripts/server#a-card-with-its-own-server-script) on Server Scripts, and [Stream cards in batches](/scripts/stream#stream-cards-in-batches) on Stream Scripts.

> **See it live on Cloudflare Workers.** The [book catalog](https://cloudflare-adapter.bascik.dev/catalog?q=monolith) on the Cloudflare demo site searches with `?q=` and renders one `<book-card>` per match, next to a card with its own server script. The [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream) streams the same cards in batches.

### Security

Build the output with `html`. A value that slips through unescaped lets a visitor write any of your components' tags, with props, slots, and attributes of their choosing, and each component's own server and stream scripts then run with the current request. When the values are escaped, Bascik keeps them data on every host, and for the same tag written in a page at build time:

- **A prop is text.** It becomes element text or one attribute value, never markup.
- **Bindings are checked.** A prop bound to a URL attribute becomes `about:invalid` when it holds one of the script URLs such as `javascript:`, and a prop is never bound to an `on*` event handler, `srcdoc`, or a `style` that runs script. The checks can be turned off by name with [`security.blockScriptUrls`](/configuration#security) and [`security.blockCodeBindings`](/configuration#security).
- **Inherited attributes keep their quoting,** with one exception described in [Attributes That Become URLs on the Root](/attribute-inheritance#attributes-that-become-urls-on-the-root).
- **Nested scripts get no usage data, and markers cannot be forged.** A script inside a returned component receives the request, never the usage tag's props, slot, or attributes.
- **Hostile output fails fast,** within the budgets below.

[Security](/scripts/security) explains each guarantee and how a Content-Security-Policy covers components rendered at request time.

### Rules for returned tags

- **Script output is HTML.** Every component tag in it renders with the same power as your own markup. Escape each value you put into a prop or slot, and sanitize HTML from a CMS or an API before returning it.
- **Scripts inside a returned component run** once per rendered instance, with the same `request`, `context`, and `signal`, and with what is left of `scripts.timeout`. They get no props from the usage tag; pass per-instance values as props to the component's markup instead.
- **Budgets.** One script output may expand to 1000 component instances and 4 MiB of HTML, and one response may run 64 nested component scripts, 4 levels deep. Over a budget the script fails like one that throws, under `scripts.onServerScriptError`: `'error'` (the default) makes a server script's response a 500 and empties a stream script's slot, `'warn'` logs it and leaves the slot empty, and `'ignore'` leaves the slot empty without a log. Raise a budget in [`scripts.renderLimits`](/configuration#scriptsrenderlimits).
- **CSS is sent before the first instance.** Each component's stylesheet is one `<style>` block in the body, right before its first instance in document order, once per response.
- **Client scripts run in place,** inside the rendered instance. See [Where Component Scripts Run](/scoped-javascript#where-component-scripts-run).
- **Base paths are rewritten inside rendered components** only. Prefix the URLs in the rest of the output yourself.
- **Some tags are sent as written:** a `components.external` name with no component file, a tag inside `<script>`, `<style>`, `<textarea>`, a comment, or an attribute value, an escaped tag, a misspelled tag, and a component that cannot be rendered at request time. The dev server logs the last two once per route when at least one component can be rendered at request time, and `bascik --check` lists the components; see [Request-Time Component Rendering](/compatibility#request-time-component-rendering).
- **Directive scripts in the output never run.** A `data-bascik-server` script a script returns is sent as written.

Request-time rendering needs a host that runs server scripts: the [dev server](/development-server), the [production server](/production-server), or the [Cloudflare Adapter](/deployment/cloudflare). The Cloudflare demo renders the same shape live: a [book catalog](https://cloudflare-adapter.bascik.dev/catalog?q=monolith) and its [streamed version](https://cloudflare-adapter.bascik.dev/catalog-stream).
