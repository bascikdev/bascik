# Stream Scripts

Imagine a dashboard or product page where the navigation, header, and sidebar are ready immediately, but live account metrics or customer reviews depend on a slower database query. Stream scripts let you flush the static page shell and placeholder markup to the browser right away, streaming the resolved HTML chunks into the open response as asynchronous backend tasks finish.

## See it in action

The two-stage illustration below shows progressive rendering: the static header and pending placeholder paint immediately in the initial chunk, and the streamed result updates the view once the backend task resolves.

## data-bascik-stream

Tag any `<script>` block with `data-bascik-stream` to run it as a streaming script. Bascik pre-calculates the static segments of the page; only request-time script output is unknown. Headers and every static HTML byte before the `<script data-bascik-stream>` tag are flushed to the client immediately, and the script's output is sent when its export resolves, in document order, within the same HTTP response.

```html
<section class="feed-panel" aria-busy="true">
  <p class="pending" role="status">Loading live activity…</p>
  <script data-bascik-stream>
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const response = await fetch('https://api.example.com/feed', { signal });
      const items = await response.json();
      return `<div class="result">${items.map(item => `<p>${escape(item.text)}</p>`).join('')}</div>`;
    }
  </script>
</section>
```

Developers familiar with [React Server Components (RSC)](https://react.dev/reference/rsc/server-components) or [progressive streaming SSR](https://react.dev/reference/react-dom/server/renderToPipeableStream#streaming-more-content-as-it-loads) will recognize the value of progressive delivery. Unlike client-hydrated component trees or client-side DOM reconciliation runtimes, Bascik streams ordinary vanilla HTML in one document response in source order. No Bascik client library is injected into the browser.

> **Choosing script execution modes:**
> - [Build scripts](/build-scripts) run once at build time (`data-bascik-build`) for static content.
> - [Server scripts](/server-scripts) run on each request (`data-bascik-server`) and buffer output before committing headers, returning an HTTP 500 error page if an error occurs.
> - [Stream scripts](/stream-scripts) flush headers and the static shell immediately, then stream HTML chunks progressively over an open connection.
>
> *Note:* Request-time streaming requires running the Bascik [dev server](/development-server) or [production server](/production-server). It cannot stream dynamically from a static-only CDN hosting pre-rendered HTML files. For security guidelines when interpolating user data, see [Escaping and injection](/server-scripts#escaping-and-injection).

## Execution Model & Request Flow

Stream scripts share the standard server handler signature: `(request, context, { signal })`. With stream scripts, one key architectural difference applies: the server does not wait for stream scripts before committing HTTP response headers.

```html
<script data-bascik-stream>
  import { escape } from '@/lib/server.ts';

  export default async function (request, context, { signal }) {
    const res = await fetch('https://api.example.com/user', {
      headers: { cookie: request.headers.get('cookie') || '' },
      signal,
    });
    const user = await res.json();
    return `<article><h3>Welcome back, ${escape(user.name)}</h3></article>`;
  }
</script>
```

### The Mixed-Page Ordering Rule

When a page contains both `data-bascik-server` and `data-bascik-stream` blocks:

1. **Phase 1 (Preparation):** All `data-bascik-server` scripts on the page execute first. If any `server` script fails under `scripts.onServerScriptError: 'error'`, the response is aborted and an HTTP 500 status is returned.
2. **Phase 2 (Commit & Early Flush):** HTTP headers and all static HTML bytes up to the first `data-bascik-stream` tag are committed and sent immediately to the browser.
3. **Phase 3 (Streaming Output):** Static segments and stream script outputs are emitted in strict document source order. While the server executes stream jobs concurrently with bounded concurrency, chunks are flushed sequentially so the HTML stream remains valid.

> **Placement tip:** A slow `data-bascik-server` script on a page delays the initial response commit for the entire page. If a data operation is slow or latency-sensitive, use `data-bascik-stream` instead.

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
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const response = await fetch('https://api.example.com/account', { signal });
      const account = await response.json();
      return `<article class="result"><h3>${escape(account.name)}</h3></article>`;
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
    0% { opacity: 0.5; }
    50% { opacity: 0.85; }
    100% { opacity: 0.5; }
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
</style>

<div class="skeleton" role="status" aria-label="Loading data">
  <script data-bascik-stream>
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const res = await fetch('https://api.example.com/details', { signal });
      const data = await res.json();
      return `<div class="result"><p>${escape(data.details)}</p></div>`;
    }
  </script>
</div>
```

### Recipe C: Priority Source Order with CSS Grid Positioning

In Bascik streaming, source order is delivery order: bytes before the first stream tag arrive first, and subsequent stream tags arrive sequentially. To deliver fast blocks first, place slow stream scripts later in the HTML source, then position them visually using CSS grid areas. Ensure that visual positioning preserves a sensible source and focus order according to the [W3C CSS Grid Placement](https://www.w3.org/TR/css-grid-1/#order-accessibility) specification:

```html
<!-- src/components/dashboard-grid.html -->
<style>
  .dash {
    display: grid;
    grid-template-columns: 14rem 1fr;
    grid-template-areas:
      "nav metrics"
      "nav billing"
      "nav footer";
  }
  .nav     { grid-area: nav; }
  .metrics { grid-area: metrics; min-block-size: 8rem; }
  .billing { grid-area: billing; min-block-size: 12rem; }
  .foot    { grid-area: footer; }
</style>

<main class="dash">
  <!-- Fast and static blocks first: delivered in the initial chunk -->
  <nav class="nav"><a href="/dashboard">Dashboard</a></nav>
  <footer class="foot"><p>&copy; 2026</p></footer>

  <!-- Heavy streaming blocks placed later in source -->
  <section class="metrics" aria-busy="true">
    <p class="pending" role="status">Loading metrics…</p>
    <script data-bascik-stream>
      import { escape } from '@/lib/server.ts';

      export default async function (request, context, { signal }) {
        const res = await fetch('https://api.example.com/metrics', { signal });
        const stats = await res.json();
        return `<div class="result"><p>${escape(stats.summary)}</p></div>`;
      }
    </script>
  </section>

  <section class="billing" aria-busy="true">
    <p class="pending" role="status">Loading billing…</p>
    <script data-bascik-stream>
      import { escape } from '@/lib/server.ts';

      export default async function (request, context, { signal }) {
        const res = await fetch('https://api.example.com/billing', { signal });
        const bills = await res.json();
        return `<div class="result"><p>${escape(bills.total)}</p></div>`;
      }
    </script>
  </section>
</main>
```

## Error Handling & Headers

### Error Policy

Because streaming begins after HTTP 200 headers are already committed, a `data-bascik-stream` failure cannot convert the response into an HTTP 500 error page:

- Under `scripts.onServerScriptError: 'error'`, the error is logged to stderr with source line remapping, the script slot receives an empty string, and the rest of the document stream completes cleanly.
- Under `scripts.onServerScriptError: 'warn'`, a warning is logged to stderr and the stream continues.
- Under `scripts.onServerScriptError: 'ignore'`, the failure is ignored silently.

The author's placeholder remains visible on error, keeping page layout intact.

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
<section class="stream-panel" aria-busy="true">
  <p class="pending" role="status">Loading live status…</p>
  <script data-bascik-stream>
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const response = await fetch('https://api.example.com/status', { signal });
      const data = await response.json();
      return `<p class="result">System online: ${escape(data.uptime)}</p>`;
    }
  </script>
</section>
```

<!-- demo:output-html -->
```html
<!-- The shell is sent immediately; the result chunk arrives in the stream -->
<section class="stream-panel" aria-busy="true">
  <p class="pending" role="status">Loading live status…</p>
  <p class="result">System online: 99.99%</p>
</section>
```
