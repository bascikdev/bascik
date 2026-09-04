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

## File-Based Routing

API route files live in `directory.api` (default: `src/api`). The URL path prefix is always `/api`:

| File Path | URL Route |
| :--- | :--- |
| `src/api/health.ts` | `/api/health` |
| `src/api/contact.ts` | `/api/contact` |
| `src/api/users/index.ts` | `/api/users` |
| `src/api/users/[id].ts` | `/api/users/:id` |
| `src/api/[org]/repos/[id].ts` | `/api/:org/repos/:id` |

Static segments take precedence over dynamic segments. For example, `src/api/users/me.ts` is matched before `src/api/users/[id].ts` when navigating to `/api/users/me`.

When configuring a custom `base` in `bascik.config.ts`, API routes compose cleanly (e.g. `base: '/app/'` routes to `/app/api/...`).

## Method Exports and Automatic Allow Headers

A route file exports functions corresponding to standard HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`.

- **Allowlist dispatch:** Only exported methods are accepted. Any unexported method returns `405 Method Not Allowed` with an accurate `Allow` header listing the permitted methods.
- **Derived HEAD:** When `GET` is exported but `HEAD` is not, Bascik executes `GET`, returns the status and headers, and automatically strips the body. An explicit `HEAD` export takes precedence.
- **Auto OPTIONS:** When `OPTIONS` is not exported, Bascik automatically responds with `204 No Content` and the `Allow` header. Bascik does not inject CORS headers by default. Cross-origin access remains entirely under the handler's control.

## The Request and Response Contract & Portability

Because Bascik uses native web standard `Request` and `Response` objects, your handlers are completely portable. `request.url` reflects the real scheme and host of the incoming request. The exact same handler function can run without modification on serverless edge runtimes or alongside standard web adapters:

- Cloudflare Workers
- Fastly Compute
- Netlify Edge Functions
- AWS Lambda (via Web Adapters or Function URLs)
- Google Cloud Functions / Cloud Run (using standard Web Request adapters)

## The Context Argument

Handlers accept an optional second argument providing parsed route parameters and client IP:

```ts
export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string }
): Promise<Response> => {
  return Response.json({
    id: context.params.id,
    ip: context.remoteIp,
  });
};
```

- `context.params`: Key-value map of extracted dynamic route segments (`[param]`).
- `context.remoteIp`: The client IP address. When `http.trustProxy` is enabled in configuration, this value reflects the real client IP forwarded by upstream reverse proxies or CDNs.

## Request Body Handling and Streaming

Request bodies are exposed as standard WHATWG streams with `duplex: 'half'`. Handlers parse bodies using standard WHATWG methods such as `await request.json()`, `await request.text()`, `await request.formData()`, or `await request.arrayBuffer()`. Bascik does not automatically parse bodies or sniff content types.

- **Streaming Size Enforcement (`http.maxBodySize`):** The maximum request body size defaults to `1048576` bytes (1 MB) and can be customized in `bascik.config.ts`.
- **Stream Counting:** Bytes are counted on the fly as they stream from the client. Bascik never buffers an unbounded payload in memory to measure it.
- **Payload Rejection:** If the payload exceeds the limit, the incoming stream is aborted and destroyed, and Bascik responds with `413 Payload Too Large` without continuing execution.
- **Client Headers Untrusted:** Bascik does not trust `Content-Length` headers from clients; size limits are enforced strictly against actual received bytes.

## Timeouts and Cooperative Cancellation

API route execution is protected by `http.apiTimeout` (defaults to `10000` ms):

- **AbortSignal:** Handlers receive a cooperative `AbortSignal` in the third argument options object `{ signal }` to cancel downstream network calls or database operations.
- **Hard Timeout:** If a handler does not resolve before `http.apiTimeout` elapses, Bascik responds with `504 Gateway Timeout` and logs the timeout on the server.
- **Synchronous Execution Limitation:** Like any JavaScript runtime, synchronous CPU-bound operations (such as infinite loops) cannot be interrupted by timers. The timeout protects asynchronous operations (promises, queries, fetch requests).

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

To serve API routes, run Bascik in production server mode using `bascik --server` or during development using `bascik`.

## What Bascik Deliberately Omits

Bascik leaves standard web application responsibilities to standard TypeScript and web APIs:

- **Middleware:** Compose plain functions directly inside your handler files.
- **Body validation:** Use Zod, Valibot, or native checks directly on `await request.json()`.
- **CORS headers:** Return explicit `Access-Control-Allow-Origin` headers on responses if required.
- **Sessions & Auth:** Read the `cookie` header and return `Set-Cookie` headers using standard Web APIs.
- **Automatic compression:** API routes are not compressed automatically to prevent BREACH attack vectors on sensitive dynamic payloads.
