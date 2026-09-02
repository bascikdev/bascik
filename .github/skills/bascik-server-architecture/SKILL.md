---
name: bascik-server-architecture
description: Architecture, debugging, and maintenance of Bascik's built-in HTTP/1.1, HTTP/2, TLS, and Server-Sent Events (SSE) server. Use when modifying dev server, prod server, SSE live-reload, request scripts, or socket resilience.
---

# Bascik Server Architecture: HTTP/1.1, HTTP/2, TLS & SSE

Bascik includes a zero-dependency server implemented in `pkg/src/lib/server.ts` and `pkg/src/lib/serve.ts` that powers both the development server (with live-reload) and production serving (`bascik --server`).

---

## 1. Dev Server vs. Prod Server Architecture

| Feature | Dev Server (`bascik`) | Prod Server (`bascik --server`) |
| :--- | :--- | :--- |
| **Purpose** | Local authoring, watching, live-reloading | High-throughput static & dynamic serving |
| **Live Reload / SSE** | Injects SSE client script into HTML pages | Disabled |
| **Watcher** | `chokidar` watches `src/`, triggers rebuilds & SSE | No filesystem watcher |
| **Request Scripts** | Executes `data-bascik-server` on request | Executes `data-bascik-server` on request |
| **HTTP Protocols** | HTTP/1.1 & HTTP/2 (ALPN) | HTTP/1.1 & HTTP/2 (ALPN) |
| **TLS** | Auto-generated in-memory certificates | Auto-generated or custom certs |

---

## 2. Protocol Negotiation & TLS Setup

Bascik supports secure serving with ALPN (Application-Layer Protocol Negotiation):

* **ALPN Protocols:** Advertises `['h2', 'http/1.1']` to clients.
* **Fallback Behavior:** If a client does not support HTTP/2 or requests plain HTTP/1.1, the server handles it seamlessly via `http2.createSecureServer({ allowHTTP1: true })`.
* **Disabling TLS for Testing:**
  Set `BASCIK_ENABLE_TLS=false` when testing environments that cannot handle self-signed certificates without complex trust stores. (There is no `--no-tls` flag; the environment variable is the only switch.)

---

## 3. Server-Sent Events (SSE) Live-Reload System

In dev mode, the server maintains an open SSE connection with connected browser tabs at `/__bascik_live_reload`:

### Injected Client Script

The server injects a small, resilient SSE listener into HTML responses in dev mode:

```js
const es = new EventSource('/__bascik_live_reload');
es.onmessage = (event) => {
  if (event.data === 'reload') {
    location.reload();
  }
};
```

### Connection Lifecycle & Keep-Alive

To prevent intermediate proxies, firewalls, and browser timeouts from severing idle SSE connections:
1. **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
2. **Heartbeat:** Transmit periodic comment pings (`:\n\n`) every 15–30 seconds.
3. **Clean Teardown:** Listen for `req.on('close')` to remove client response objects from the active broadcaster set to prevent memory leaks.

---

## 4. Fault Tolerance & Socket Error Handling

Production and dev servers must never crash from client disconnects or aborted streams. Always attach error handlers to sockets and HTTP/2 streams:

* **`ERR_HTTP2_STREAM_CANCEL` / `RST_STREAM`:** Occurs when a client closes a tab or aborts an in-flight request. Suppress or handle gracefully without bubbling to uncaught exceptions.
* **`ECONNRESET` & `EPIPE`:** Handle on socket instances when writing response bodies to disconnected clients.

```ts
stream.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ERR_HTTP2_STREAM_CANCEL' || err.code === 'ECONNRESET') {
    return; // Client disconnected; clean up silently
  }
  logger.error(err);
});
```

---

## 5. Request-Time Server Scripts (`data-bascik-server`)

`<script data-bascik-server>` blocks execute in-process as Node.js ESM modules using `ScriptRegistry` without spawning child processes.
- **Sidecar loading:** In production (`bascik --server`), script sources are loaded from `dist/.bascik/server-scripts.json` at startup.
- **Context delivery:** Handlers receive explicit `{ req }` context (`path`, `method`, `headers`, `searchParams`) and `{ signal }` for timeout/cancellation.
- **Output:** The handler's return value replaces the script tag in the page response.
- **Escaping:** Output is raw HTML; user data must be sanitized using `escapeHtml` from `@bascik/bascik`.
- **Fault containment:** Errors in one script block fail only that block, logged per `scripts.onServerScriptError`.

---

## 6. Execution in Workspace

Test and run server modes directly using workspace helper scripts:

```sh
# Dev server in docs workspace
yarn docs:dev

# Prod server in docs workspace
yarn docs:serve

# HTTP/1.1 E2E tests
yarn --cwd pkg e2e:prod:http1

# HTTP/2 E2E tests
yarn --cwd pkg e2e:prod:http2
```
