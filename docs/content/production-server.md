# Production Server

Bascik includes a high-performance, read-only production HTTP/1.1 and HTTP/2 server. `bascik --server` boots directly against the pre-compiled `dist/` directory, loading all HTML documents, inlined styles, and scoped scripts into an in-memory store for instant sub-millisecond page delivery.

## Starting the Production Server

Build your static assets first, then start the production server:

```sh
bascik --build   # compile HTML, CSS, assets to dist/
bascik --server  # launch production HTTP server
```

The production server is read-only and designed for deployment:

- It loads pre-compiled output from `dist/` and never recompiles source files or deletes output.
- It executes `data-bascik-server` and `data-bascik-stream` scripts in-process per request.
- It bypasses disk I/O for HTML pages by serving directly from memory.
- For local development with file watching and live reload, run the [Development Server](/development-server) with `bascik` instead.

## CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--server` | Start the production server runtime | `false` |
| `--port <number>` | Port to listen on | `8080` (HTTP) or `8443` (HTTPS/HTTP2) |
| `--hostname <string>` | Interface to bind | `localhost` |
| `--base <path>` | Deployment path prefix | `/` |
| `--config <path>` | Path to explicit config file | `bascik.config.ts` |
| `--env-file <path>` | Custom environment file path | `./.env` |

```sh
# Run on port 3000 bound to all interfaces
bascik --server --port 3000 --hostname 0.0.0.0
```

## Configuration (`http`)

Configure production server runtime behavior under the `http` key in `bascik.config.ts`:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  http: {
    port: 8080,
    hostname: '0.0.0.0',
    compression: true,
    trustProxy: true,
    rateLimit: {
      window: 60000,
      max: 1000,
    },
    cacheControl: {
      '.woff2': 'public, max-age=31536000, immutable',
      '.png': 'public, max-age=86400',
    },
    tls: {
      enabled: false,
      keyFile: './certs/key.pem',
      certFile: './certs/cert.pem',
    },
  },
});
```

### Server Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `http.port` | `number` | `8080` / `8443` | TCP port to listen on |
| `http.hostname` | `string` | `'localhost'` | Network interface to bind |
| `http.compression` | `boolean` | `true` | Enables automatic Gzip and Brotli compression |
| `http.trustProxy` | `boolean` | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Proto` proxy headers |
| `http.rateLimit` | `boolean \| object` | `false` | In-memory sliding-window IP rate limiter |
| `http.cacheControl` | `Record<string, string>` | `{}` | Custom `Cache-Control` headers matched by file extension |
| `http.timeouts` | `object` | `{}` | Socket request, headers, and keep-alive timeout values |
| `http.maxBodySize` | `number` | `10485760` (10MB) | Maximum payload byte size for API route requests |
| `http.tls` | `object` | `{ enabled: false }` | TLS / HTTPS and HTTP/2 certificate configuration |

## HTTP/2 & TLS Support

Bascik supports native HTTP/2 over TLS with automatic fallback to HTTP/1.1:

```ts
// bascik.config.ts
export default defineConfig({
  http: {
    port: 8443,
    tls: {
      enabled: true,
      keyFile: './certs/privkey.pem',
      certFile: './certs/fullchain.pem',
    },
  },
});
```

When TLS is enabled:
- ALPN negotiation enables HTTP/2 for modern clients and HTTP/1.1 for legacy agents.
- TLS session tickets and SNI routing are configured automatically.
- Development certificates (e.g. generated with `mkcert`) work seamlessly for local HTTPS testing.

## Compression: Brotli & Gzip

When `http.compression: true` is enabled (the default):

- Static HTML pages are pre-compressed with both Brotli and Gzip in the background at startup.
- The server reads each request's `Accept-Encoding` header and picks the best match: Brotli for modern browsers, Gzip for legacy clients, proxies, and crawlers that do not advertise `br`, and uncompressed bytes otherwise. Each variant carries its own `ETag`.
- Fast Brotli and Gzip streams compress static assets based on client `Accept-Encoding`.
- Responses containing streaming scripts (`data-bascik-stream`) skip compression to preserve incremental chunk delivery.

## In-Memory Caching & ETags

On boot, `bascik --server` reads all compiled HTML documents from `dist/` into an in-memory lookup table:

- Page lookups, routing, and header computation take place in memory with zero filesystem access.
- SHA-256 content hashes generate deterministic `ETag` headers, responding with `304 Not Modified` for unchanged client caches.
- Standalone static assets (images, fonts, downloads) stream from disk using high-speed non-blocking streams.

## Graceful Shutdown & Health Checks

The production server responds to `SIGTERM` and `SIGINT` process signals by stopping acceptance of new TCP connections, finishing in-flight request streams, and exiting cleanly:

- **Built-in Health Checks:** Deploy `src/api/health.ts` for orchestrator liveness and readiness probes.
- **Connection Draining:** In-flight streaming scripts and file uploads are given time to complete before the socket closes.

> **Next:** See [Deploying](/deploying) for deployment guides on Node servers, Docker, PM2, and systemd.
