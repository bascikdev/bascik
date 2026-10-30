# Stream Scripts

Imagine a dashboard or product page where the navigation, header, and sidebar are ready immediately, but live account metrics or customer reviews depend on a slower database query. Stream scripts let you flush the static page shell and placeholder markup to the browser right away, streaming the resolved HTML chunks into the open response as asynchronous backend tasks finish.

## See it in action

This is a recording of a real page served by the Bascik dev server. The skeleton and the page shell paint first, and the metric card replaces the skeleton in place when the slow work finishes (the page waits two seconds on purpose, so the swap is easy to see). There is no layout shift and no client-side fetching:

![A browser loading a dashboard page. A Loading live metrics skeleton is shown first, and after about two seconds a card reading 99.99% uptime across 3 regions replaces it in place](/assets/demos/stream@2x.webp)

The preview below cycles through the streaming lifecycle: the static header and pending placeholder paint immediately in the initial chunk (Stage 1), and the streamed result replaces the placeholder once the asynchronous backend task resolves (Stage 2).

> **See it live on Cloudflare Workers.** These pages stream real chunked HTTP responses from a deployed Bascik site. Reload them and watch the placeholders resolve:
>
> - [In-place skeleton swap](https://cloudflare-adapter.bascik.dev/stream): skeletons and the footer paint first, then each card replaces its skeleton as it arrives.
> - [Progressive append](https://cloudflare-adapter.bascik.dev/stream-append): no placeholders, cards stream straight into the open response.
> - [Mixed server and stream page](https://cloudflare-adapter.bascik.dev/mixed): a server script runs before headers commit, then a stream script flushes into the open connection.

## data-bascik-stream

When people first see this in action, the natural reaction is: _Wait, how does dynamic loading work without client-side JavaScript or a framework runtime?_

Here is the secret: browsers have natively supported incremental HTML parsing since the 1990s. When a web server sends standard chunked HTTP data, the browser immediately constructs the DOM, downloads stylesheets, and paints the initial HTML markup, all while keeping the network connection open.

When you tag a `<script>` with `data-bascik-stream`, Bascik leverages this native browser capability:

1. **Immediate Initial Paint:** Bascik flushes the HTTP 200 headers and all static HTML preceding the stream tag immediately. The visitor sees the full page shell and your pending placeholder state instantly.
2. **Asynchronous Edge/Server Execution:** The server or edge Worker executes your script asynchronously (querying databases, calling microservices, or fetching third-party APIs).
3. **Progressive Document Flush:** As soon as the async task resolves, Bascik flushes the generated HTML chunk across the open connection.
4. **Pure CSS Transition:** Standard modern CSS (like `:has(.result)` or container states) automatically hides the placeholder and displays the streamed HTML the moment the chunk arrives.

Zero client JavaScript is needed. No React runtime, no hydration phase, no virtual DOM diffing, and no client-side `fetch()` polling. It is standard HTML delivered over standard HTTP streams in source order.

```html
<section class="feed-panel" aria-busy="true">
  <p class="pending" role="status">Loading live activity…</p>
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";

    export default async function (request, context, { signal }) {
      const response = await fetch("https://api.example.com/feed", { signal });
      const items = await response.json();
      return html`<div class="result">
        ${items.map((item) => html`<p>${item.text}</p>`)}
      </div>`;
    }
  </script>
</section>
```

Developers familiar with [React Server Components (RSC)](https://react.dev/reference/rsc/server-components) or [progressive streaming SSR](https://react.dev/reference/react-dom/server/renderToPipeableStream#streaming-more-content-as-it-loads) will recognize the value of progressive delivery. Unlike client-hydrated component trees or client-side DOM reconciliation runtimes, Bascik streams ordinary vanilla HTML in one document response in source order. No Bascik client library is injected into the browser.

> **Choosing script execution modes:**
>
> - [Build scripts](/build-scripts) run once at build time (`data-bascik-build`) for static content.
> - [Server scripts](/server-scripts) run on each request (`data-bascik-server`) and buffer output before committing headers, returning an HTTP 500 error page if an error occurs.
> - [Stream scripts](/stream-scripts) flush headers and the static shell immediately, then stream HTML chunks progressively over an open connection.
>
> _Note:_ Request-time streaming requires something that executes code per request: the Bascik [dev server](/development-server), the [production server](/production-server), or a serverless function generated by a build `--target` such as the [Cloudflare Adapter](/deployment/cloudflare). A static-only CDN serving pre-rendered HTML cannot stream anything. For security guidelines when interpolating user data, see [Escaping and injection](/server-scripts#escaping-and-injection).

A stream script can be TypeScript the way a [server script](/server-scripts#typescript) can: a `src=` `.ts` module, or an inline block marked `type="text/typescript"`. Bascik strips the types before it runs, on Node and in the Cloudflare Worker, and errors keep the source's lines. A TypeScript mistake fails the build, not the request.

## Execution Model & Request Flow

Stream scripts share the standard server handler signature: `(request, context, { signal })`. With stream scripts, one key architectural difference applies: the server does not wait for stream scripts before committing HTTP response headers.

```html
<script data-bascik-stream>
  import { html } from "@bascik/bascik/html";

  export default async function (request, context, { signal }) {
    const res = await fetch("https://api.example.com/user", {
      headers: { cookie: request.headers.get("cookie") || "" },
      signal,
    });
    const user = await res.json();
    return html`<article><h3>Welcome back, ${user.name}</h3></article>`;
  }
</script>
```

### The Mixed-Page Ordering Rule

When a page contains both `data-bascik-server` and `data-bascik-stream` blocks:

1. **Phase 1 (Preparation):** All `data-bascik-server` scripts on the page execute first. If any `server` script fails under `scripts.onServerScriptError: 'error'`, the response is aborted and an HTTP 500 status is returned.
2. **Phase 2 (Commit & Early Flush):** HTTP headers and all static HTML bytes up to the first `data-bascik-stream` tag are committed and sent immediately to the browser.
3. **Phase 3 (Streaming Output):** Static segments and stream script outputs are emitted in strict document source order. While the server executes stream jobs concurrently with bounded concurrency, chunks are flushed sequentially so the HTML stream remains valid.

> **Placement tip:** A slow `data-bascik-server` script on a page delays the initial response commit for the entire page. If a data operation is slow or latency-sensitive, use `data-bascik-stream` instead. See a live demonstration of this execution flow on our [mixed server and stream demo](https://cloudflare-adapter.bascik.dev/mixed).

## Placeholders That Do Not Shift Layout

Whatever HTML you write before a `<script data-bascik-stream>` tag is sent in the initial chunk and displayed while the script executes. Bascik does not inject synthetic wrappers or client loaders. The placeholder gives way to the streaming result through standard HTML and CSS.

### Recipe A: Reserved Box (Default Pattern)

Wrap the placeholder and script in a container that reserves its typical dimensions using `min-block-size` for text blocks or `aspect-ratio` for media elements. Include `aria-busy="true"` on the container and `role="status"` on the placeholder text so assistive technologies announce the pending state:

```html
<!-- src/components/account-panel.html -->
<style>
  .panel {
    display: grid;
    min-block-size: 8rem;
  }
  .panel > * {
    grid-area: 1 / 1;
  }
  .pending {
    color: var(--text-muted, #6b7280);
  }
  .result {
    background: var(--surface, #ffffff);
  }
</style>

<section class="panel" aria-busy="true">
  <p class="pending" role="status">Loading account details…</p>
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";

    export default async function (request, context, { signal }) {
      const response = await fetch("https://api.example.com/account", {
        signal,
      });
      const account = await response.json();
      return html`<article class="result"><h3>${account.name}</h3></article>`;
    }
  </script>
</section>
```

#### How Visual Swap Works

Because Bascik adds no client runtime, previously flushed DOM nodes cannot be removed without client code. The streaming result is appended where the `<script>` tag lived in the DOM. The visual swap is achieved with author CSS:

- **Pattern 1: One-Cell CSS Grid Stack (Recommended):** Set `display: grid` and place children in `grid-area: 1 / 1`. The arrived `.result` paints directly over the `.pending` placeholder.
- **Pattern 2: CSS `:has()` Parent Selector:** Use `.panel:has(> .result) > .pending { display: none; }` to hide the placeholder element once the `.result` child arrives in the DOM.

> **Accessibility consideration:** CSS visual overlay or `:has()` hiding visually swaps elements, but CSS alone cannot change the container's `aria-busy` attribute. For static streaming where no client script is desired, avoid leaving an indefinite `aria-busy="true"` container if assistive technology requires state settlement, or add a small progressive enhancement script to toggle attributes once loaded.

### Recipe B: Skeleton Shimmer

Add a loading animation with pure CSS keyframes, accounting for [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion):

```html
<style>
  @keyframes shimmer {
    0% {
      opacity: 0.5;
    }
    50% {
      opacity: 0.85;
    }
    100% {
      opacity: 0.5;
    }
  }
  .skeleton-container {
    min-block-size: 6rem;
  }
  .skeleton {
    min-block-size: 6rem;
    background: var(--surface-subtle, #f3f4f6);
    border-radius: 6px;
  }
  @media (prefers-reduced-motion: no-preference) {
    .skeleton {
      animation: shimmer 1.5s ease-in-out infinite;
    }
  }
  /* Automatically hide the skeleton once the streamed result chunk arrives */
  .skeleton-container:has(.result) .skeleton {
    display: none;
  }
</style>

<div class="skeleton-container" aria-busy="true">
  <div class="skeleton" role="status" aria-label="Loading data"></div>
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";

    export default async function (request, context, { signal }) {
      const res = await fetch("https://api.example.com/details", { signal });
      const data = await res.json();
      return html`<div class="result"><p>${data.details}</p></div>`;
    }
  </script>
</div>
```

### Recipe C: Priority Source Order with CSS Positioning (The Early-Paint Footer Trick)

In Bascik streaming, source order is network delivery order: all markup before the first `<script data-bascik-stream>` tag arrives in the initial chunk (Time-to-First-Byte), while streaming scripts resolve subsequently.

Because of this, you can send your entire static page shell, including the navigation, hero, sidebar, and even the **footer**, in the very first byte flush before any slow backend stream script begins. You then use modern CSS (Flexbox `order` or CSS Grid `grid-template-areas`) to visually position the footer at the bottom of the layout.

The browser paints the complete page container and footer immediately, with placeholder skeletons in between, while background streams fill in the gaps without any layout jump or client-side JavaScript.

Ensure that visual reordering maintains an intuitive reading and focus order according to the [W3C CSS Grid Placement](https://www.w3.org/TR/css-grid-1/#order-accessibility) specification.

#### Option 1: Multi-Slot Grid with In-Place Skeleton Swapping (Recommended)

When rendering multiple independent streaming sections (like cards in a dashboard), place **all skeleton placeholders first** in the initial HTML chunk before the streaming script slots, and assign them to named CSS grid areas. As each stream chunk resolves, its arrived card lands in the corresponding grid area, and CSS `:has()` swaps out only that specific skeleton:

```html
<!-- src/pages/dashboard.html -->
<style>
  .dash-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-areas: "slot1 slot2 slot3";
    gap: 1rem;
  }
  .cell-1 {
    grid-area: slot1;
  }
  .cell-2 {
    grid-area: slot2;
  }
  .cell-3 {
    grid-area: slot3;
  }

  /* In-place swap: when result markup arrives in a slot, hide its matching skeleton */
  .dash-grid:has(.result-1) .cell-1.skeleton {
    display: none;
  }
  .dash-grid:has(.result-2) .cell-2.skeleton {
    display: none;
  }
  .dash-grid:has(.result-3) .cell-3.skeleton {
    display: none;
  }
</style>

<div class="dash-grid">
  <!-- All 3 skeletons delivered in the very first byte flush -->
  <div class="skeleton cell-1" role="status"><p>Loading Metrics…</p></div>
  <div class="skeleton cell-2" role="status"><p>Loading Feed…</p></div>
  <div class="skeleton cell-3" role="status"><p>Loading Database…</p></div>

  <!-- Streaming scripts resolve independently in source order -->
  <div class="cell-1">
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";
      export default async function (request, context, { signal }) {
        const stats = await fetchMetrics({ signal });
        return html`<article class="card result-1">
          <h3>${stats.uptime}</h3>
        </article>`;
      }
    </script>
  </div>

  <div class="cell-2">
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";
      export default async function (request, context, { signal }) {
        const feed = await fetchFeed({ signal });
        return html`<article class="card result-2">
          <h3>${feed.rate}</h3>
        </article>`;
      }
    </script>
  </div>

  <div class="cell-3">
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";
      export default async function (request, context, { signal }) {
        const db = await fetchDb({ signal });
        return html`<article class="card result-3">
          <h3>${db.status}</h3>
        </article>`;
      }
    </script>
  </div>
</div>
```

#### Option 2: Full Dashboard Layout (Grid Template Areas)

```html
<!-- src/pages/dashboard-layout.html -->
<style>
  .dash-layout {
    display: grid;
    grid-template-columns: 14rem 1fr;
    grid-template-areas:
      "nav metrics"
      "nav billing"
      "nav footer";
  }
  .nav {
    grid-area: nav;
  }
  .metrics {
    grid-area: metrics;
    min-block-size: 8rem;
  }
  .billing {
    grid-area: billing;
    min-block-size: 12rem;
  }
  .foot {
    grid-area: footer;
  }
</style>

<div class="dash-layout">
  <!-- Fast, static elements delivered in the initial chunk -->
  <nav class="nav"><a href="/dashboard">Dashboard</a></nav>
  <footer class="foot"><p>&copy; 2026 Acme Corp</p></footer>

  <!-- Heavy streaming sections placed later in HTML source -->
  <section class="metrics" aria-busy="true">
    <p class="pending" role="status">Loading live metrics…</p>
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";

      export default async function (request, context, { signal }) {
        const res = await fetch("https://api.example.com/metrics", { signal });
        const stats = await res.json();
        return html`<div class="result"><p>${stats.summary}</p></div>`;
      }
    </script>
  </section>

  <section class="billing" aria-busy="true">
    <p class="pending" role="status">Loading billing history…</p>
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";

      export default async function (request, context, { signal }) {
        const res = await fetch("https://api.example.com/billing", { signal });
        const bills = await res.json();
        return html`<div class="result"><p>${bills.total}</p></div>`;
      }
    </script>
  </section>
</div>
```

#### Option 3: Flexbox Column Order

```html
<!-- src/pages/report.html -->
<style>
  body {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  header {
    order: 1;
  }
  main {
    order: 2;
  }
  footer {
    order: 3;
    margin-top: auto;
  }
</style>

<!-- Header AND Footer are delivered in the first chunk -->
<header><h1>Quarterly Analytics</h1></header>
<footer class="site-footer"><p>Generated by Bascik</p></footer>

<main>
  <!-- Streaming content delivers asynchronously into the middle slot -->
  <section class="revenue" aria-busy="true">
    <div class="skeleton" role="status">Loading revenue figures…</div>
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";

      export default async function (request, context, { signal }) {
        const res = await fetch("https://api.example.com/revenue", { signal });
        const data = await res.json();
        return html`<div class="result"><h2>${data.total}</h2></div>`;
      }
    </script>
  </section>
</main>
```

#### Option 4: Zero-Placeholder Progressive Append Flow

If you want content to append progressively as it streams in without showing placeholders upfront, simply omit the placeholder markup before the `<script data-bascik-stream>` tags. The browser constructs and renders each element as soon as its stream chunk is flushed:

```html
<!-- src/pages/feed.html -->
<div class="feed-grid">
  <!-- Items stream and append into the grid in arrival order with no placeholders -->
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";
    import { fetchPrimaryFeed } from "@/lib/feeds.ts";

    export default async function (request, context, { signal }) {
      const item = await fetchPrimaryFeed({ signal });
      return html`<article class="feed-card"><h3>${item.title}</h3></article>`;
    }
  </script>
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";
    import { fetchSecondaryFeed } from "@/lib/feeds.ts";

    export default async function (request, context, { signal }) {
      const item = await fetchSecondaryFeed({ signal });
      return html`<article class="feed-card"><h3>${item.title}</h3></article>`;
    }
  </script>
</div>
```

## Returning component tags

A stream script can return the tags of your own components, exactly like a [server script](/server-scripts#returning-component-tags). Each tag is rendered at request time with the component's markup, props, slots, and scoped CSS, and the result is streamed into its slot. Nothing is imported or configured.

> **See it live on Cloudflare Workers.** The [streamed catalog](https://cloudflare-adapter.bascik.dev/catalog-stream) on the Cloudflare demo site streams `<product-card>` tiles in batches, and the [product catalog](https://cloudflare-adapter.bascik.dev/catalog?q=frother) renders the same cards from a server script.

### Stream cards in batches

This page streams the `<product-card>` from the [server script guide](/server-scripts#render-a-card-per-search-result) in two batches, one per `data-bascik-stream` script. Bascik flushes the slots in source order. The card's stylesheet is sent once, as one `<style>` at the start of the first slot in document order that renders a card, so the second batch carries none. Every card's client script has the same text, so one Content-Security-Policy hash covers both batches. Here each batch returns at once so the Output is the same on every run; a real batch arrives when its data resolves, such as a search API that takes a moment.

<!-- demo:rtc-stream-source-usage -->

```html
<!-- src/pages/new-arrivals.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>New arrivals</title>
  </head>
  <body>
    <div class="results">
      <script data-bascik-stream>
        export default async function () {
          return (
            `<product-card data-bascik-prop-name="Milk frother" data-bascik-prop-price="$129">Best seller</product-card>` +
            `<product-card data-bascik-prop-name="Pour-over kettle" data-bascik-prop-price="$48">New</product-card>`
          );
        }
      </script>
      <script data-bascik-stream>
        export default async function () {
          return `<product-card data-bascik-prop-name="Glass carafe" data-bascik-prop-price="$31"></product-card>`;
        }
      </script>
    </div>
  </body>
</html>
```

The Source tabs show the page and the card's files. The Output is the whole body `bascik --server` streamed for `GET /new-arrivals`, built with minification off as in the server script guide and reformatted for reading. The Preview is drawn by this docs site's static build from the same three tags, because the docs site has no server to run a stream script.

<!-- demo:rtc-stream-output-html -->

```html
<!-- src/pages/new-arrivals.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>New arrivals</title>
  </head>
  <body>
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

Run this on Cloudflare Workers: [/catalog-stream](https://cloudflare-adapter.bascik.dev/catalog-stream).

### Security

Escaping bugs in a stream script that returns component tags mean component injection, exactly as for server scripts: a visitor's unescaped text can write any of your components' tags, and their own scripts run with the request. The guarantees are the same as for server scripts: props are text, bindings to URL, event-handler, `srcdoc`, and `style` attributes are checked, inherited attributes keep their quoting, nested scripts get no usage data, markers cannot be forged, and hostile output fails fast. A failure leaves the stream slot empty rather than sending a 500. See [Security](/server-scripts#security) for the details and the note on `generate.cspHashes`, and the [Security](/security) page for building output with `html`.

### Rules when streaming

The rules are the ones for server scripts. These are the ones that matter most when streaming:

- **Script output is HTML.** Component tags in it render with the same power as your own markup, and the component's own scripts run with the current request. Escape every value you interpolate, and sanitize HTML from a CMS or an API before returning it.
- **A nested stream script resolves with its parent.** A `data-bascik-stream` or `data-bascik-server` script inside a returned component runs once per rendered instance and receives no props from the usage tag. Its output is spliced into the instance before the parent's slot is written, so the slot arrives complete, in one piece, and the page's stream order is unchanged. The nested script gets what is left of the parent's `scripts.timeout`.
- **CSS arrives before the first instance.** Each component's stylesheet is sent as one `<style>` block in the body, at the start of the first slot in document order that renders an instance of it, once per response for all of the page's stream scripts, whatever order the slots finish in. A page that also returns the component from a server script sends it once more for the server part.
- **Failures leave the slot empty, never a 500.** An output over a budget (1000 component instances, 4 MiB of rendered HTML, or rereading more than 16 times its length plus 33,554,432 characters per output, 64 nested component scripts per response, 4 levels deep) leaves this slot empty and logs a message naming the route and the component file. A nested script that throws empties this slot under `scripts.onServerScriptError: 'error'`; under `'warn'` or `'ignore'` only the nested script's part of the card is empty. Either way the rest of the document streams on.
- **Tags that are not rendered stay as written.** A tag listed in `components.external` with no component file, a misspelled tag, and a component that cannot be rendered at request time all reach the browser as written; the dev server logs the last two once per route when at least one component can be rendered at request time. See [Request-Time Component Rendering](/compatibility#request-time-component-rendering) for the components that cannot be rendered and how to restructure them.

The [streamed catalog demo](https://cloudflare-adapter.bascik.dev/catalog-stream) on Cloudflare Workers streams batches of the same cards. The full list of rules, including base paths and client scripts, is in [Returning component tags](/server-scripts#returning-component-tags) for server scripts.

## Error Handling & Headers

### Error Policy

Because streaming begins after HTTP 200 headers are already committed, a `data-bascik-stream` failure cannot convert the response into an HTTP 500 error page:

- Under `scripts.onServerScriptError: 'error'`, the error is logged to stderr with source line remapping, the script slot receives an empty string, and the rest of the document stream completes cleanly.
- Under `scripts.onServerScriptError: 'warn'`, a warning is logged to stderr and the stream continues.
- Under `scripts.onServerScriptError: 'ignore'`, the failure is ignored silently.

The author's placeholder remains visible on error, keeping page layout intact.

A stream script that resolves its last chunk after `scripts.timeout` has passed, even inside its own `abort` listener, is a timeout under the policy above, not a late chunk.

### HTTP Headers & Caching Consequences

Pages containing streaming scripts automatically adjust HTTP transport headers:

- **HTTP/1.1 Framing:** Uses `Transfer-Encoding: chunked` according to [RFC 9112 Section 7.1](https://httpwg.org/specs/rfc9112.html#chunked.encoding).
- **HTTP/2 Framing:** Uses native multiplexed DATA frames according to [RFC 9113 Section 8.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.1). `Transfer-Encoding` is prohibited in HTTP/2 ([RFC 9113 Section 8.2.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.2.2)).
- **Content-Length & ETag:** Omitted because response byte length is unknown when headers are committed.
- **Cache-Control:** Automatically set to `private, no-store` to prevent intermediary proxy caching of partial streaming responses ([RFC 9111](https://httpwg.org/specs/rfc9111.html)).
- **HEAD Requests:** HEAD requests execute through the buffered planner to compute exact `Content-Length` headers without streaming the body.

## Client Disconnect & Backpressure

- **Backpressure Handling:** When a downstream TCP socket buffer fills, Bascik's response sink pauses execution of subsequent stream segments until the socket emits `drain`.
- **Cooperative Cancellation:** If a client closes the connection or navigates away before stream completion, the `AbortController` triggers. The passed `signal` aborts ongoing `fetch()` requests and database queries that consume the signal. Synchronous operations or uninstrumented database clients must be handled accordingly.

> **Next:** See [Server Scripts](/server-scripts) for buffered per-request execution, or read [Production Server](/production-server) for server deployment options.

<!-- demo:source-usage -->

```html
<style>
  .stream-panel {
    min-block-size: 4rem;
  }
  /* When the stream chunk arrives, CSS automatically hides the pending placeholder */
  .stream-panel:has(.result) .pending {
    display: none;
  }
</style>

<section class="stream-panel" aria-busy="true">
  <p class="pending" role="status">Loading live status…</p>
  <script data-bascik-stream>
    import { html } from "@bascik/bascik/html";

    export default async function (request, context, { signal }) {
      const response = await fetch("https://api.example.com/status", {
        signal,
      });
      const data = await response.json();
      return html`<p class="result">System online: ${data.uptime}</p>`;
    }
  </script>
</section>
```

<!-- demo:output-html -->

```html
<!-- The shell is sent immediately; the result chunk arrives in the stream.
     CSS :has(.result) automatically hides the .pending placeholder. -->
<section class="stream-panel" aria-busy="true">
  <p class="pending" role="status" style="display: none;">
    Loading live status…
  </p>
  <p class="result">System online: 99.99%</p>
</section>
```
