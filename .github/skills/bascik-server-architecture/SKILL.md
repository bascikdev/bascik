---
name: bascik-server-architecture
metadata:
  internal: true
description: Architecture, debugging, and maintenance of Bascik's built-in HTTP/1.1, HTTP/2, TLS, and Server-Sent Events (SSE) server. Use when modifying dev server, prod server, SSE live-reload, request scripts, or socket resilience.
---

# Bascik Server Architecture: HTTP/1.1, HTTP/2, TLS & SSE

Bascik includes a zero-dependency server whose shared core is `pkg/src/lib/server.ts`. Two thin mode modules sit on top of it: `pkg/src/lib/server-dev.ts` (development: watch, live reload, boot page) and `pkg/src/lib/server-prod.ts` (production, `bascik --server`: load `dist/` into memory). Keep mode-specific logic in those two files and everything else in the shared core so dev and deployed behavior stay identical.

---

## 1. Dev Server vs. Prod Server Architecture

| Feature               | Dev Server (`bascik`)                              | Prod Server (`bascik --server`)                 |
| :-------------------- | :------------------------------------------------- | :---------------------------------------------- |
| **Purpose**           | Local authoring, watching, live-reloading          | High-throughput static & dynamic serving        |
| **Live Reload / SSE** | Injects SSE client script into HTML pages          | Disabled                                        |
| **Watcher**           | `chokidar` watches `src/`, triggers rebuilds & SSE | No filesystem watcher                           |
| **Request Scripts**   | Executes `data-bascik-server` on request           | Executes `data-bascik-server` on request        |
| **HTTP Protocols**    | HTTP/1.1; HTTP/2 (ALPN) with `http.tls.enabled`    | HTTP/1.1; HTTP/2 (ALPN) with `http.tls.enabled` |
| **TLS**               | Off by default; generated or custom certs          | Off by default; generated or custom certs       |

---

## 2. Protocol Negotiation & TLS Setup

Bascik supports secure serving with ALPN (Application-Layer Protocol Negotiation):

- **ALPN Protocols:** Advertises `['h2', 'http/1.1']` to clients.
- **Fallback Behavior:** If a client does not support HTTP/2 or requests plain HTTP/1.1, the server handles it seamlessly via `http2.createSecureServer({ allowHTTP1: true })`.
- **Enabling TLS:** TLS (and with it HTTP/2) is off unless `http.tls.enabled: true` is set in config; without it `startServer()` serves plain HTTP/1.1. With TLS on, `ensureCertificates()` (`pki.ts`) uses `http.tls.keyFile` / `http.tls.certFile`, or generates `bascik-privkey.pem` / `bascik-cert.pem` in the project on first run (trusted via `mkcert` when installed, otherwise self-signed with `openssl`). There is no TLS environment variable or CLI flag.

---

## 3. Server-Sent Events (SSE) Live-Reload System

In dev mode, the server maintains an open SSE connection with connected browser tabs at `/bascik-live-reload`:

### Injected Client Script

The server injects a small, resilient SSE listener into HTML responses in dev mode:

```js
// Simplified from live-reload.ts: "reload <generation>" messages, reconnect, and error overlay omitted.
const es = new EventSource("/bascik-live-reload");
es.onmessage = (event) => {
  if (event.data.startsWith("reload")) {
    location.reload();
  }
};
```

### Connection Lifecycle & Keep-Alive

To prevent intermediate proxies, firewalls, and browser timeouts from severing idle SSE connections:

1. **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
2. **Heartbeat:** Transmit periodic pings (`DEFAULT_HEARTBEAT_INTERVAL_MS`, 20 seconds, in `sse.ts`).
3. **Clean Teardown:** Listen for `req.on('close')` to remove client response objects from the active broadcaster set to prevent memory leaks.

---

## 4. Fault Tolerance & Socket Error Handling

Production and dev servers must never crash from client disconnects or aborted streams. Always attach error handlers to sockets and HTTP/2 streams:

- **`ERR_HTTP2_STREAM_CANCEL` / `RST_STREAM`:** Occurs when a client closes a tab or aborts an in-flight request. Suppress or handle gracefully without bubbling to uncaught exceptions.
- **`ECONNRESET` & `EPIPE`:** Handle on socket instances when writing response bodies to disconnected clients.

```ts
stream.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "ERR_HTTP2_STREAM_CANCEL" || err.code === "ECONNRESET") {
    return; // Client disconnected; clean up silently
  }
  logger.error(err);
});
```

---

## 5. Request-Time Server Scripts (`data-bascik-server`)

`<script data-bascik-server>` blocks execute in-process as Node.js ESM modules using `ScriptRegistry` without spawning child processes.

- **Sidecar loading:** In production (`bascik --server`), script sources are loaded from `.bascik/dist/server-scripts.json` at startup.
- **Context delivery:** Handlers receive `(request: Request, context: { remoteIp }, { signal })`, identical to API routes.
- **Output:** The handler's return value replaces the script tag in the page response. Component tags in the output are rendered at request time (markup, props, slots, scoped CSS, nested server scripts) from the component manifest, within the `scripts.renderLimits` budgets.
- **Escaping:** Output is HTML. `html` from `@bascik/bascik/html` (`pkg/src/html.ts`) escapes each value for where it lands; plain string output is not escaped.
- **Fault containment:** A throwing or over-budget script follows `scripts.onServerScriptError`: `'error'` (default) answers 500 for a server script, `'warn'` and `'ignore'` leave its slot empty.

---

## 6. Execution in Workspace

Test and run server modes directly using workspace helper scripts:

```sh
# Dev server in docs workspace
yarn docs:dev

# Prod server in docs workspace
yarn docs:preview

# HTTP/1.1 E2E tests
yarn --cwd pkg e2e:prod:http1

# HTTP/2 E2E tests
yarn --cwd pkg e2e:prod:http2
```
