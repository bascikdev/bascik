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

Handlers take a standard WHATWG `Request` and return a standard WHATWG `Response`. There is no proprietary context wrapper, no middleware chain, and no custom decorator syntax.

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

Because Bascik uses native web standard `Request` and `Response` objects, your handlers are completely portable. The exact same handler function can run without modification on:

- Cloudflare Workers
- Deno Deploy
- Bun
- Hono
- Vercel Edge Functions

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
