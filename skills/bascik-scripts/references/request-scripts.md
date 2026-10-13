# Request-Time Scripts and API Routes Reference

Server scripts, stream scripts, and API routes run per request in Node.js under the dev server, `bascik --server`, or a serverless bundle (`bascik --build --target cloudflare`). A plain static `dist/` on a static host cannot run them.

## `data-bascik-server`

```html
<script data-bascik-server>
  import { escapeHtml } from '@/lib/escape.ts';

  export default async function (request, context, { signal }) {
    const url = new URL(request.url);
    const query = escapeHtml(url.searchParams.get('q') ?? '');
    return `<p>Results for ${query}</p>`;
  }
</script>
```

- Arguments: `request` (WHATWG `Request`, same as API routes), `context` (`{ remoteIp }`, proxy-aware with `http.trustProxy`), and `{ signal }` (`AbortSignal` for timeout and client disconnect).
- Runs in-process. Handler results are never cached; loaded modules are reused across requests.
- Every `server` script on the page resolves before the response starts, so the response is buffered with `Content-Length`.
- The source is extracted to `dist/.bascik/server-scripts.json` and replaced by an inert `<script type="text/bascik-server">` placeholder, so server code is never shipped to browsers. They do not run during `bascik --build`.
- Bounded by `scripts.timeout` (default 30000 ms). Synchronous loops block the event loop and cannot be interrupted; always use async APIs.
- `scripts.onServerScriptError`: `'error'` (default) returns HTTP 500; `'warn'` logs and renders an empty string; `'ignore'` renders an empty string silently.
- Errors print the request path and a stack pointing at the source line: `[bascik] server script error at "/dashboard":`.

## `data-bascik-stream`

Same authoring model as `data-bascik-server`. The difference: headers and all HTML before the tag are sent immediately, and the script's output is written in document order when it resolves.

Decision rule:

- `data-bascik-server` when the output must exist before anything is sent, or a failure must be an HTTP 500.
- `data-bascik-stream` when the shell and layout should paint while a slow block loads.

Rules:

- All `server` scripts on a mixed page resolve first. A `server` failure under `'error'` aborts with a 500 before any bytes go out. A slow `server` script delays the first byte of the whole page.
- A `stream` failure cannot become a 500 (headers are committed). The slot renders empty, the error is logged at the `onServerScriptError` severity, and the document completes.
- Stream responses use chunked transfer on HTTP/1.1 (DATA frames on HTTP/2) with `cache-control: private, no-store`, and omit `content-length`, `etag`, and Brotli encoding. `HEAD` uses the buffered path.
- There is no config key; opt in per tag.
- Avoid layout shift: everything before the tag paints first, so wrap the slot in a component with reserved size (`min-block-size` or `aspect-ratio`), `aria-busy` / `role="status"`, and a placeholder swapped by a one-cell grid stack (`grid-area: 1 / 1`) or a `:has(> .result)` rule. Bascik adds no CSS or JS for this. Put slow blocks last in source and position them with `grid-template-areas` or `order`.

## Module lifetime

- Node keeps evaluated ESM modules until the process exits, including earlier dev generations. Clean up timers and resources yourself and keep request data in handler arguments, not module state.
- In dev, edits to literally imported helper files reload the inline modules that use them; unrelated edits keep singleton state. Computed imports do not get this guarantee. Production uses stable module identities.

## Escaping

Bascik does not escape script output and ships no escaper. Output is raw HTML by contract.

```ts
// src/lib/escape.ts
const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (ch) => map[ch]);
```

| Sink | Treatment |
|---|---|
| Text between tags, quoted attribute values | HTML entity escape (`& < > " '`) |
| Unquoted attribute | Never; quote the attribute |
| `href`, `src`, `action` | Parse with `new URL(value, base)` and allow only `http:` and `https:`; escaping does not stop `javascript:` |
| Inline `<script>`, `on*` attributes, `<style>` | Never interpolate untrusted data; pass it through `data-*` attributes to a static script |
| Already-rendered HTML (CMS, Markdown from users) | Sanitize with an allowlist at the data layer |

Untrusted data includes everything from `request`, database rows with user input, and third-party APIs.

## API routes

Files under `src/api/` (`directory.api`) map to `/api/...`:

```text
src/api/health.ts            /api/health
src/api/users/index.ts       /api/users
src/api/users/[id].ts        /api/users/:id
src/api/files/[...path].ts   /api/files/*  (one or more segments)
```

```ts
// src/api/users/[id].ts
export const GET = async (request: Request, { params }: { params: { id: string } }) =>
  Response.json({ id: params.id });
```

- Export `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`. Others return 405 with an accurate `Allow` header. `HEAD` derives from `GET`; `OPTIONS` answers 204 automatically.
- Context: `(request, { params, remoteIp, platform }, { signal })`. `params` is a plain object. A catch-all gives `params.path` as a decoded `string[]`.
- Precedence: static segments, then `[param]`, then catch-all. Malformed encoding, `%2F`/`%5C`, `..`, control characters, and empty interior segments return 400; dot segments return 404 (only a leading `/.well-known/` is public, and it never reaches API routes).
- `request.body` streams; `http.maxBodySize` (default 1 MB) aborts with 413. `http.apiTimeout` (default 10000 ms) fires `signal`.
- Handlers run in-process with `process.env`. Their source is never served or copied. Thrown errors return a 500 without stack or path details. No CORS headers are added.
- `context.platform` is `{ name: 'node' }` on the built-in server and `{ name: 'cloudflare', env, waitUntil }` in a generated Worker (`env` holds KV, D1, and secret bindings).
- `bascik --build` alone cannot serve API routes and warns; add `--target <name>` for a serverless bundle or run `bascik --server`.

## Testing

Put business logic in pure functions in `src/lib/*.ts` and unit test them with Vitest. Test the HTTP layer with integration tests that send requests to the dev server or `bascik --server`, not by importing the script tag.
