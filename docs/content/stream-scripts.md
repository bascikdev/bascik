# Stream Scripts

Stream scripts let you flush the static shell of a page to the browser immediately, while asynchronous backend tasks stream their HTML markup into the response progressively over chunked HTTP.

## See it in action

This stream status card illustrates progressive rendering: the static header and pending state paint immediately, and streaming chunks update the view as backend promises resolve.

## data-bascik-stream

Tag any `<script>` block with `data-bascik-stream` to run it as a streaming script. Bascik holds every static byte of the page in memory; only request-time script output is unknown. Headers and every static byte before the `<script data-bascik-stream>` tag are flushed to the client immediately, and the script's output is sent when it resolves, in document order, within the same response.

```html
<section class="feed-panel" aria-busy="true">
  <p class="pending" role="status">Loading live activity…</p>
  <script data-bascik-stream>
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const feed = await fetchActivityFeed(request, signal);
      return `<div class="result">${feed.map(item => `<p>${escape(item.text)}</p>`).join('')}</div>`;
    }
  </script>
</section>
```

The browser receives and renders the shell immediately, parsing and painting incrementally as each chunk arrives. No client JavaScript framework or runtime library is added to the page.

> **Server vs Stream scripts:** Use `data-bascik-server` when the output must be present before anything is sent, or when a script failure should result in an HTTP 500 error page. Use `data-bascik-stream` when the page shell should paint immediately while slow backend queries resolve. For escaping and injection guidelines, see [Escaping and injection](/server-scripts#escaping-and-injection).

## Execution Model & Request Flow

Stream scripts use the same handler signature as `data-bascik-server` and API routes: `(request, context, { signal })`. With stream scripts, one key architectural difference applies: the server does not wait for stream scripts before committing HTTP response headers.

```html
<script data-bascik-stream>
  export default async function (request, context, { signal }) {
    const data = await loadUserData(request.headers.get('cookie'), signal);
    return `<article>${data.html}</article>`;
  }
</script>
```

### The Mixed-Page Ordering Rule

When a page contains both `data-bascik-server` and `data-bascik-stream` blocks:

1. **Phase 1 (Preparation):** All `data-bascik-server` scripts on the page execute first. If any `server` script fails under `scripts.onServerScriptError: 'error'`, the response is aborted and an HTTP 500 status is returned.
2. **Phase 2 (Commit & Early Flush):** HTTP headers and all static HTML bytes up to the first `data-bascik-stream` tag are committed and sent immediately to the browser.
3. **Phase 3 (Streaming Output):** Static segments and stream script outputs are emitted in strict document source order.

> **Placement tip:** A slow `data-bascik-server` script on a page with stream scripts delays the initial response commit for the entire page. If a data operation is slow or latency-sensitive, use `data-bascik-stream` instead.

## Placeholders That Do Not Shift Layout

Whatever HTML you write before a `<script data-bascik-stream>` tag is sent in the initial chunk and displayed while the script executes. Bascik does not inject synthetic spinners or wrappers. The placeholder gives way to the streaming result entirely through standard HTML and CSS.

### Recipe A: Reserved Box (Default Pattern)

Wrap the placeholder and script in a container that reserves its final dimensions using `min-block-size` for text blocks or `aspect-ratio` for media elements. Include `aria-busy="true"` on the container and `role="status"` on the placeholder text so assistive technologies announce the pending state:

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
      const account = await loadAccount(request, signal);
      return `<article class="result"><h3>${escape(account.name)}</h3></article>`;
    }
  </script>
</section>
```

#### How Visual Swap Works

Because Bascik adds no client runtime, previously flushed DOM nodes cannot be removed without client code. The streaming result is appended where the `<script>` tag lived in the DOM. The visual swap is achieved with author CSS:

- **Pattern 1: One-Cell CSS Grid Stack (Recommended):** Set `display: grid` and place children in `grid-area: 1 / 1`. The arrived `.result` paints directly over the `.pending` placeholder.
- **Pattern 2: CSS `:has()` Parent Selector:** Use `.panel:has(> .result) > .pending { display: none; }` to hide the placeholder element once the `.result` child arrives in the DOM.

### Recipe B: Skeleton Shimmer

Add a subtle loading animation with pure CSS keyframes:

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
    animation: shimmer 1.5s ease-in-out infinite;
  }
</style>

<div class="skeleton" role="status" aria-label="Loading data">
  <script data-bascik-stream>
    export default async function (request, context, { signal }) {
      const content = await fetchDetails(request, signal);
      return `<div class="result">${content}</div>`;
    }
  </script>
</div>
```

### Recipe C: Priority Source Order with CSS Grid Positioning

In Bascik streaming, source order is delivery order: bytes before the first stream tag arrive first, and subsequent stream tags arrive sequentially. To deliver fast blocks first, place slow stream scripts at the end of the HTML source, then position them visually using CSS grid areas:

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
      export default async function (request, context, { signal }) {
        const stats = await loadMetrics(request, signal);
        return `<div class="result">${stats.summary}</div>`;
      }
    </script>
  </section>

  <section class="billing" aria-busy="true">
    <p class="pending" role="status">Loading billing…</p>
    <script data-bascik-stream>
      export default async function (request, context, { signal }) {
        const bills = await loadBilling(request, signal);
        return `<div class="result">${bills.total}</div>`;
      }
    </script>
  </section>
</main>
```

## Error Handling & Headers

### Error Policy

Because streaming begins after HTTP 200 headers are already committed, a `data-bascik-stream` failure **cannot** convert the response into an HTTP 500 error page:

- Under `scripts.onServerScriptError: 'error'`, the error is logged to stderr with source line remapping, the script slot receives an empty string, and the rest of the document stream completes cleanly.
- Under `scripts.onServerScriptError: 'warn'`, a warning is logged to stderr and the stream continues.
- Under `scripts.onServerScriptError: 'ignore'`, the failure is ignored silently.

The author's placeholder remains visible on error, keeping page layout intact.

### HTTP Headers & Caching Consequences

Pages containing streaming scripts automatically adjust HTTP transport headers:

- **Transfer-Encoding:** Set to `chunked` (HTTP/1.1) or chunked data frames (HTTP/2).
- **Content-Length & ETag:** Omitted because response byte length is unknown when headers are committed.
- **Cache-Control:** Automatically set to `private, no-store` to prevent intermediary proxy caching of partial streaming responses.
- **HEAD Requests:** HEAD requests execute through the buffered planner to compute exact `Content-Length` headers without streaming the body.

## Client Disconnect & Backpressure

- **Backpressure Handling:** When a downstream TCP socket buffer fills, Bascik's response sink halts execution of subsequent stream segments until the socket emits `drain`.
- **Abort Signal Propagation:** If a client closes the connection or navigates away before stream completion, the `AbortController` triggers. The passed `signal` aborts ongoing `fetch()` requests and database queries immediately.

> **Next:** See [Server Scripts](/server-scripts) for buffered per-request execution, or read [Production Server](/production-server) for server deployment options.

<!-- demo:source-usage -->
```html
<section class="stream-panel" aria-busy="true">
  <p class="pending" role="status">Loading live status…</p>
  <script data-bascik-stream>
    import { escape } from '@/lib/server.ts';

    export default async function (request, context, { signal }) {
      const data = await fetchStatus(request, signal);
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
