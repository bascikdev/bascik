# API Routes

Bascik supports standard, portable API routes defined in TypeScript or JavaScript files under `src/api/`.

```ts
// src/api/contact.ts
export const POST = async (request: Request): Promise<Response> => {
  const { name, email } = await request.json();
  if (!email) {
    return Response.json({ error: "email is required" }, { status: 400 });
  }
  await sendEmail({ name, email });
  return Response.json({ ok: true }, { status: 201 });
};
```

Handlers take a standard WHATWG `Request` and return a standard WHATWG `Response`. There is no proprietary context wrapper, no middleware chain, and no custom decorator syntax. Server scripts and stream scripts receive this same `Request` object; see [Server Scripts](/server-scripts).

The [Contact Form](/example-components/contact-form) example posts to a route like this one.

> **See it live on Cloudflare Workers.** The [edge API client](https://cloudflare-adapter.bascik.dev/api-demo) calls a deployed `src/api/ping.ts` route from the browser and shows the JSON response. You can also request it directly at [/api/ping](https://cloudflare-adapter.bascik.dev/api/ping).

## File-Based Routing

API route files live in `directory.api` (default: `src/api`). The URL path prefix is always `/api`:

| File Path                     | URL Route                             |
| :---------------------------- | :------------------------------------ |
| `src/api/health.ts`           | `/api/health`                         |
| `src/api/contact.ts`          | `/api/contact`                        |
| `src/api/users/index.ts`      | `/api/users`                          |
| `src/api/users/[id].ts`       | `/api/users/:id`                      |
| `src/api/[org]/repos/[id].ts` | `/api/:org/repos/:id`                 |
| `src/api/[...path].ts`        | `/api/*` (one or more segments)       |
| `src/api/files/[...path].ts`  | `/api/files/*` (one or more segments) |

Every `.ts`, `.mts`, `.js` and `.mjs` file in `directory.api` is a route, except type declarations (`types.d.ts`) and tests beside a route (`contact.test.ts`, `contact.spec.mts`). Keep shared helpers outside the folder, for example in `src/lib/` imported as `@/lib/db.ts`: a helper inside it, such as `src/api/db.ts`, is served as `/api/db` and answers `405` to every method it does not export.

Static segments take precedence over dynamic segments. For example, `src/api/users/me.ts` is matched before `src/api/users/[id].ts` when navigating to `/api/users/me`.

Dynamic `[param]` values are percent-decoded once from the raw request path. `/api/users/100%2520` supplies the literal string `100%20`, not `100 `. A `[param]` value is always one path segment: an encoded `/` or `\` (`/api/users/a%2Fb`) never splits it into two and never reaches the handler, the request answers `400`, as it does for a catch-all.

### Catch-all routes

A final `[...name]` segment is a **required catch-all**. It matches **one or more** remaining path segments and never zero: `src/api/files/[...path].ts` handles `/api/files/a` and `/api/files/a/b/c`, but not `/api/files`. Add `src/api/files/index.ts` (or `files.ts`) to serve the bare path.

```ts
// src/api/files/[...path].ts   GET /api/files/reports/2026/q1.pdf
export const GET = async (
  request: Request,
  context: { params: Record<string, string | string[]>; remoteIp: string },
): Promise<Response> => {
  const segments = context.params.path as string[]; // ["reports", "2026", "q1.pdf"]
  return Response.json({ segments });
};
```

- **Captured value:** `context.params.<name>` is a `string[]`, one entry per path segment, so segment boundaries are preserved. `[param]` values stay `string`.
- **Decoding:** the raw request path is split on `/` first, then each segment is percent-decoded exactly once. `/api/files/a%2541` yields `["a%41"]`, never `["aA"]`.
- **Rejected with `400 Bad Request` (handler never runs):** malformed percent-encoding (`%E0%A4%A`), an encoded separator (`%2F`, `%5C`), `..` traversal segments, control characters (`%00`, `%0A`), and empty interior segments (`/api/files/a//b`). A single trailing slash is ignored. Single-dot segments (`/api/files/a/%2e/b`) and other dot-prefixed segments (`/.env`) return `404` before matching, as for every other route.
- **Precedence:** compared segment by segment from the left: a static segment beats a `[param]`, which beats a catch-all. The result never depends on file discovery order. A catch-all only receives requests no more specific route matched.
- **Pattern errors:** the catch-all must be a whole, named, final segment. `[...]`, `x[...a]`, and `[...a]/b.ts` are errors. Two catch-alls at the same position (`[...a].ts` and `[...b].ts`, or `[x]/[...a].ts` and `[y]/[...b].ts`) are ambiguous. Both fail the build or server start naming every file, and `bascik --check` reports them (`invalid-catch-all`, `route-collision`). Catch-alls at different depths or prefixes may coexist.
- **Methods, security, limits:** method dispatch, `405` with `Allow`, derived `HEAD`, auto `OPTIONS`, path-traversal and hidden-path guards, `http.maxBodySize`, and `http.apiTimeout` apply exactly as for any other route. Catch-all routes are API-only; page routing is unchanged.
- **Forwarding upstream:** treat the captured segments as untrusted input. If a handler forwards them to another service, allow-list the first segment or the full path, re-encode each segment with `encodeURIComponent`, build the URL from a fixed origin, and never accept a caller-supplied origin.

When configuring a custom `base` in `bascik.config.ts`, API routes compose cleanly (e.g. `base: '/app/'` routes to `/app/api/...`).

## Method Exports and Automatic Allow Headers

A route file exports functions corresponding to standard HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`.

- **Allowlist dispatch:** Only exported methods are accepted. Any unexported method returns `405 Method Not Allowed` with an accurate `Allow` header listing the permitted methods. Only the seven names above are methods: an export such as `PURGE` or `SEARCH` is never called, and a request with that method gets the same `405`. `TRACE`, `TRACK` and `CONNECT` cannot be exported either (a web `Request` cannot carry them), so they always get that `405`.
- **Derived HEAD:** When `GET` is exported but `HEAD` is not, Bascik executes `GET`, returns the status and headers, and automatically strips the body. An explicit `HEAD` export takes precedence. A body a `HEAD` answer does not send is canceled, so a streamed source (a `fetch()` pass-through, a file) is released at once.
- **Auto OPTIONS:** When `OPTIONS` is not exported, Bascik automatically responds with `204 No Content` and the `Allow` header. Bascik does not inject CORS headers by default. Cross-origin access remains entirely under the handler's control.

This recording sends two real requests to a dev server whose `src/api/users/[id].ts` exports only `GET`. The `GET` returns the handler's JSON with a `200`. The `DELETE` is refused with a `405`, and the `Allow` header lists exactly what the route accepts:

![A terminal running two curl commands against a dev server. A GET to /api/users/42 prints the JSON {"id":"42","name":"Ada"} and 200. A DELETE to the same URL prints 405 and an Allow header listing GET, HEAD, and OPTIONS](/assets/demos/api-routes@2x.webp)

## The Request and Response Contract & Portability

Bascik uses native web standard `Request` and `Response` objects, and `request.url` reflects the real scheme and host of the incoming request. Its pathname is the request path as sent: a request for `//api/ping` has the pathname `//api/ping`, never the host `api`. That makes the handler _function_ reusable: a handler that only touches Web APIs (`Request`, `Response`, `URL`, `fetch`, Web Crypto) is plain code you can call from a unit test or from another runtime's wrapper.

Reusable code is not the same as a deployable service. Three more things have to exist on any host before a handler answers traffic: the route table (`src/api/users/[id].ts` to `/api/users/:id`), the method dispatch and `Allow` semantics described above, and whatever the handler imports. A handler that reads `process.env`, opens a database socket, or imports a Node-only package runs where those things exist.

Where handlers run today:

- **`bascik --server`** and the dev server: supported, in-process, with routing, dispatch, body limits, and timeouts handled for you.
- **Serverless (static assets on a CDN plus managed functions):** supported through a build target and adapter, starting with Cloudflare Pages and Workers. The same routing and dispatch core runs inside the generated function. See [Deployment](/deployment#serverless-hosting) for the support matrix, or test an endpoint live on our [interactive edge API demo](https://cloudflare-adapter.bascik.dev/api-demo).
- **Other hosts:** manual porting only. Write the wrapper for the platform's request shape and reuse the handler function; Bascik does not generate one for you.

## The Context Argument

Handlers accept an optional second argument providing parsed route parameters and client IP:

```ts
export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string },
): Promise<Response> => {
  return Response.json({
    id: context.params.id,
    ip: context.remoteIp,
  });
};
```

- `context.params`: Key-value map of extracted dynamic route segments. `[param]` values are `string`; a `[...name]` catch-all value is a decoded `string[]`.
- `context.remoteIp`: The client IP address. When `http.trustProxy` is enabled in configuration, this value reflects the real client IP forwarded by upstream reverse proxies or CDNs.
- `context.platform`: The host. `{ name: "node" }` on `bascik --server` and the dev server; on Cloudflare it also carries the Worker's `env` bindings and `waitUntil` (see [Bindings and secrets](/deployment/cloudflare#bindings-and-secrets)).

## Request Body Handling and Streaming

Request bodies are exposed as standard WHATWG streams with `duplex: 'half'`. Handlers parse bodies using standard WHATWG methods such as `await request.json()`, `await request.text()`, `await request.formData()`, or `await request.arrayBuffer()`. Bascik does not automatically parse bodies or sniff content types.

- **Streaming Size Enforcement (`http.maxBodySize`):** The maximum request body size defaults to `1048576` bytes (1 MB) and can be customized in `bascik.config.ts`. A value of `0` or less disables the limit.
- **Stream Counting:** Bytes are counted on the fly as they stream from the client. Bascik never buffers an unbounded payload in memory to measure it.
- **Payload Rejection:** If the payload exceeds the limit, the handler's body stream errors and Bascik responds with `413 Payload Too Large` and `Connection: close`.
- **Declared Length:** A `Content-Length` above the limit is answered `413` before the handler runs, even for a handler that never reads its body. The method policy comes first: a method the route does not export still gets `405` with `Allow`, and an automatic `OPTIONS` still gets `204`. A client that sends `Expect: 100-continue` with such a length gets the `413` without a `100 Continue`, so it never uploads the body.
- **Lingering Close:** After a body is rejected, Bascik keeps reading and discarding the rest of the upload, so the client finishes sending and reads the response instead of failing with `EPIPE` or `ECONNRESET`. It stops after 8 MiB more, after 5 seconds with no data, or after 30 seconds in all, whichever comes first. HTTP/1.1 then closes the connection. On HTTP/2 only that stream is affected: it ends normally once drained, or is reset with `NO_ERROR` at a limit, and the session stays open. One exception: an HTTP/2 client that sends more data than its own `content-length` header declared breaks the protocol, and Node closes that whole session.
- **Streamed Echoes:** If a response streams the request body back (for example `new Response(request.body)`), its `200` headers are already sent when the limit trips. The client gets a truncated response, and the rest of its upload is still drained before the connection closes.
- **Client Headers Untrusted:** A `Content-Length` below the limit is never trusted; size limits are enforced against the bytes actually received.

## Timeouts and Cooperative Cancellation

API route execution is protected by `http.apiTimeout` (defaults to `10000` ms):

- **AbortSignal:** Handlers receive a cooperative `AbortSignal` in the third argument options object `{ signal }` to cancel downstream network calls or database operations.
- **Hard Timeout:** If a handler does not resolve before `http.apiTimeout` elapses, Bascik responds with `504 Gateway Timeout` and logs the timeout on the server. Once the deadline passes the response is a `504` even if the handler returns a `Response` afterwards, including from inside its own `abort` listener. A client that disconnects first stays a `499`.
- **Synchronous Execution Limitation:** Like any JavaScript runtime, synchronous CPU-bound operations (such as infinite loops) cannot be interrupted by timers, and while they run they block the event loop, so other requests to the server wait too. The timeout protects asynchronous operations (promises, queries, fetch requests).

## Error Handling and Information Protection

Bascik strictly protects internal implementation details from clients:

- **Clean 500 Responses:** Thrown errors or unhandled rejections return a generic `500 Internal Server Error` response with no stack traces, file paths, or internal error messages sent to the client.
- **Server-Side Logging:** The complete, formatted error stack trace and route path are logged directly to server stderr for diagnostics.
- **Fault Containment:** An error or syntax failure in a specific route file is completely contained to that route. Other API routes, server scripts, and static pages continue operating normally.
- **Network Resets:** Client disconnects and network resets (`ECONNRESET`, `EPIPE`, `ERR_HTTP2_STREAM_CANCEL`) mid-request are handled cleanly without logging false server errors.

## Security Model and Secret Protection

- **No CORS by Default:** Same-origin policy is preserved by default. Handlers must explicitly set `Access-Control-Allow-Origin` headers if cross-origin access is intended.
- **Full Environment Access:** Handlers run in-process with full access to `process.env` for database credentials, private API tokens, and server secrets.
- **Source Protection:** Source code in `directory.api` (`src/api/`) is never served to clients, copied by asset pipelines, or bundled into static build output.
- **Transport and Traversal Security:** Path traversal attempts (`%2e%2e%2f`), dot-file requests, and null bytes (`%00`) are blocked before routing. CRLF injection in handler-supplied headers is strictly rejected.

## Errors and Status Codes

- Return any standard `Response` object to specify status code, headers, and body.
- When throwing an uncaught error or returning a non-Response value, Bascik logs the error on the server and responds to the client with `500 Internal Server Error`.
- Multiple `Set-Cookie` headers are preserved without flattening.

## Testing Handlers Without a Server

Because handlers take a `Request` and return a `Response`, you can test them directly in unit tests without starting a network server:

```ts
import { describe, it, expect } from "vitest";
import { POST } from "./contact.ts";

describe("contact API route", () => {
  it("rejects requests missing an email", async () => {
    const request = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("email is required");
  });
});
```

## Static Builds vs Production Server

Static builds (`bascik --build`) cannot serve dynamic API endpoints. If route files exist in `src/api/`, the build prints a warning and completes:

```text
warning: 3 API routes found in src/api/ but static builds cannot serve them.
  Deploy with `bascik --server`, or port them to your host's function runtime.
  Routes: /api/health, /api/contact, /api/users/[id]
```

To serve API routes, run Bascik in production server mode using `bascik --server`, during development using `bascik`, or build for a serverless target that packages the routes into a managed function (see [Deployment](/deployment#serverless-hosting)).

## What Bascik Deliberately Omits

Bascik leaves standard web application responsibilities to standard TypeScript and web APIs:

- **Middleware:** Compose plain functions directly inside your handler files.
- **Body validation:** Use Zod, Valibot, or native checks directly on `await request.json()`.
- **CORS headers:** Return explicit `Access-Control-Allow-Origin` headers on responses if required.
- **Sessions & Auth:** Read the `cookie` header and return `Set-Cookie` headers using standard Web APIs.
- **Automatic compression:** API routes are not compressed automatically to prevent BREACH attack vectors on sensitive dynamic payloads.
