# Deploying

Bascik's build output is a standard folder of static HTML, CSS, and JavaScript files. `bascik --build` writes everything to `dist/`, and that folder can be served by any static host or CDN without additional configuration.

Builds are reproducible and deterministic: identical source inputs always produce byte-identical output across repeated runs and machines. This makes it straightforward to diff `dist/` between builds or verify deployed artifacts against the exact commit that produced them.

Every full dev or build run cleans `directory.out` before pre-phase lifecycle scripts run. The output therefore reflects the current source tree, without pages or assets left behind by earlier runs. Pre-phase scripts can still generate files in the output directory because cleaning finishes before those scripts start. `bascik --server` only reads an existing build and never cleans it. Targeted builds (`bascik --build --only <glob>`) also skip cleaning so existing pages survive when rebuilding a small subset.

## Per-environment values: the site URL

The site URL is a per-deployment value, so it is not a config-file key. Set `BASCIK_SITE_URL` in each environment's configuration (CI variables, container env, a `.env` file on the target) and the same checked-in source builds for staging and production without mutating anything:

```sh
BASCIK_SITE_URL=https://staging.example.com bascik --build   # staging
BASCIK_SITE_URL=https://example.com bascik --build           # production
```

A `--site-url` flag and an automatic `./.env` file are also available; see [Configuration](/configuration#configuration-precedence) for the precedence chain. Builds that generate a sitemap or robots.txt fail when no source provides the URL, so a misconfigured environment surfaces immediately instead of shipping a broken sitemap.

## What's in `dist/`

Running `bascik --build` produces:

- **HTML**: compiled pages with component tags resolved, scoped class names applied, build-script output inlined, and dynamic route templates expanded into concrete static HTML files
- **CSS and JS**: page-adjacent files from `src/pages/`, processed by configured minifiers
- **Static assets**: eligible images, fonts, downloads, and other files from `src/pages/`, preserving their relative paths

The output uses root-relative paths (e.g. `/css/styles.css`). Files must be served from an HTTP server; opening them directly with `file://` will break asset loading.

### Consuming the build manifest

When `generate.manifest: true` is configured, Bascik outputs `dist/.bascik/manifest.json`. Deployment workflows and CDN synchronization scripts can consume this manifest to upload only modified files or verify build outputs:

```js
// Example deploy-layer script reading dist/.bascik/manifest.json
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('dist/.bascik/manifest.json', 'utf8'));
for (const [relPath, info] of Object.entries(manifest.files)) {
  console.log(`Deploying ${relPath} (${info.size} bytes, SHA-256: ${info.hash})`);
}
```

### Generating strict Content Security Policy headers

Bascik inlines component `<style>` blocks and wraps component `<script>` blocks in isolated IIFEs. To support strict CSP configurations without using `'unsafe-inline'`, enable `generate.cspHashes: true` in `bascik.config.ts`. Bascik emits `dist/.bascik/csp-hashes.json` mapping each page to its exact post-minification inline script and style SHA-256 hashes (`sha256-<base64>`).

Bascik emits hashes rather than injecting a CSP header because CSP headers belong to your hosting provider or CDN edge. Setting a generic CSP with `'unsafe-inline'` inside the framework would provide false assurance.

### Cross-Origin Isolation Headers

Bascik sets safe default cross-origin headers:
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`
- `Cross-Origin-Resource-Policy: cross-origin`

These defaults allow cross-origin images, fonts, and authentication popups to function without unexpected breaks. If full cross-origin isolation (e.g. `SharedArrayBuffer`) is required, configure `Cross-Origin-Embedder-Policy: require-corp` at your hosting layer.

```js
// scripts/generate-csp-headers.ts
import { readFileSync, writeFileSync } from 'node:fs';

const hashes = JSON.parse(readFileSync('dist/.bascik/csp-hashes.json', 'utf8'));
let headers = '';
for (const [path, pageHashes] of Object.entries(hashes)) {
  const scriptSrc = pageHashes.scripts.map((h) => `'${h}'`).join(' ');
  const styleSrc = pageHashes.styles.map((h) => `'${h}'`).join(' ');
  headers += `${path}\n  Content-Security-Policy: script-src 'self' ${scriptSrc}; style-src 'self' ${styleSrc}\n\n`;
}
writeFileSync('dist/_headers', headers);
```

### Excluded source files

To keep deployment artifacts clean, the following files are excluded from static asset copying and are never copied to `dist/`:

- **Component source files**: all files in `src/components/` are source templates, resolved at build time, and never copied to `dist/`
- **Page templates**: `.html` files in `src/pages/` are transpiled into compiled pages
- **TypeScript files**: `.ts` source files used by build scripts or helper modules
- **Other source files**: `.mjs`, `.cjs`, `.mts`, and `.cts` modules, source maps (`.map`), and Markdown (`.md`)
- **API route handlers**: files in `src/api/` (`directory.api`) are runtime handlers executed in server mode and are never copied to static `dist/`. Because handler source code is strictly protected and never published, accessing private environment secrets via `process.env` in handlers remains secure.
- **Test files**: any test file matching `*.test.*` or `*.spec.*` (e.g. `styles.test.ts`)
- **Inlined stylesheets**: global CSS files configured in `inlineStyles` (injected directly into `<head>`)
- **Hidden paths**: every dotfile and every file below a dot-directory
- **Dependencies**: every file below a `node_modules` directory

Treat `directory.pages` as the publish tree. Colocate assets with a page or organize shared files under folders such as `src/pages/assets/`, `src/pages/images/`, and `src/pages/fonts/`. Keep tests and source-only helpers outside that tree. Use `assets.exclude` for project-specific exclusions; its globs match relative to `directory.pages`, and the built-in exclusions always apply.

If a project needs to copy files from a separate source tree, use a `pipeline.exec` script that selects those files and writes them to `directory.out`. This keeps external copying explicit instead of creating a second built-in asset root.

### Previewing static builds locally

To preview your built site locally before deploying, run Bascik's built-in production server:

```sh
bascik --server
```

Or preview with any third-party static HTTP server:

```sh
npx http-server dist
```

Then open `http://localhost:8080` in your browser to inspect your production site.

### Reverse proxy and CDN deployments (`trustProxy`)

When deploying `bascik --server` behind a CDN, load balancer, or reverse proxy (such as Cloudflare, AWS CloudFront/ALB, or NGINX), set `http.trustProxy: true` in `bascik.config.ts` (or under `export const server`):

```ts
export const server = defineConfig({
  http: {
    trustProxy: true,
  },
});
```

When `trustProxy: true` is enabled:
- **Rate limiting** derives client IP from the rightmost (immediate proxy) entry of `X-Forwarded-For`, preventing a single active visitor from exhausting the rate-limit budget for all visitors behind the proxy.
- **HSTS security headers** recognize `X-Forwarded-Proto: https` forwarded by the proxy.

When `trustProxy: false` (the default), `X-Forwarded-For` and `X-Forwarded-Proto` headers are strictly ignored to prevent client spoofing. Do not enable `trustProxy` if the server is directly exposed to the public Internet without a trusted reverse proxy.

### Health checks and zero-downtime deployments

`bascik --server` provides built-in endpoints for load balancer and orchestrator health checks:

- **Liveness probe:** `GET /_health/live` returns `200 OK` as long as the process is alive.
- **Readiness probe:** `GET /_health` (or `GET /_health/ready`) returns `200 OK` when the server is ready to accept traffic, and `503 Service Unavailable` during boot and during the shutdown drain window.

Configure your container orchestrator (e.g. Kubernetes, AWS ECS) or load balancer with:
- **Health check path:** `/_health`
- **Shutdown signal:** `SIGTERM`
- **Deregistration delay:** Match or exceed `http.timeouts.drain` (default `5000` ms) so the load balancer stops routing new traffic before the process exits.

## Static hosting

For most Bascik sites, `dist/` is the deployable artifact. If your site has no `data-bascik-server` scripts, you only need a static host.

Every major platform follows the same pattern:

1. Run `bascik --build` to produce `dist/`
2. Configure the host to deploy from the `dist/` folder
3. Point the publish directory at `dist/`

That covers GitHub Pages, Netlify, Cloudflare Pages, AWS S3, Vercel, and any other static host. Refer to your hosting provider's documentation for the exact steps. Because the output is vanilla HTML, CSS, and JS, it follows the same conventions as Vite, Astro, and other tools, so guides for those tools are largely applicable.

### Tips that apply everywhere

**Custom 404 page.** Name your page `src/pages/404.html`. After building, `dist/404.html` is the standard location for custom 404 pages recognized by GitHub Pages, Netlify, Cloudflare Pages, and Vercel.

**Root-relative paths.** The default `base: '/'` targets the domain root. Set `base` when the host mounts the site below the root.

**Build command.** If your host runs a build command for you, use `npx bascik --build` or `bascik --build` (if installed as a dev dependency). Set the output directory to `dist/`.

**No runtime required.** Bascik does not need Node.js at serve time for static sites. Any CDN or file server that can serve HTML files is sufficient.

**Caching on a CDN.** For immutable, far-future caching of images and fonts, see [Asset Fingerprinting](/how-to/asset-fingerprinting). For most sites the built-in content-hash ETags plus `http.cacheControl` are enough, with no build step.

**Small sites.** A landing page or docs for one tool can be a single page with no server at all. See [Micro Sites](/how-to/micro-sites).

### GitHub Actions example

A minimal workflow for building and uploading to any static host:

```yaml
name: Build
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - run: npm ci
      - run: npx bascik --build
        env:
          BASCIK_SITE_URL: https://example.com
      # Upload dist/ to your host here
```

`dist/` is the artifact to upload or deploy.

### Subdirectory deploys

Set `base` when the site is published at a path such as `https://example.com/docs/` instead of the domain root. GitHub Pages project sites are a common example: a repository named `my-site` is normally published at `https://account.github.io/my-site/`.

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  base: '/my-site/',
});
```

Bascik normalizes the leading and trailing slash, rewrites root-relative HTML, CSS, and web app manifest URLs during the build, and serves pages and static assets below the same prefix in development and with `bascik --server`. Generated sitemap, robots, and canonical URLs compose the site URL, base, and page path in that order.

Requests outside the configured prefix return `404 Not Found`. With `base: '/my-site/'`, request `/my-site/about`, not `/about`. This strict behavior matches a static host and catches incorrect links during local preview. Live reload also connects through the prefix automatically.

A custom domain mapped to the project site usually serves it from `/`, so leave the default `base: '/'` in that deployment shape.

## Using the production server

If your site uses `data-bascik-server` scripts for per-request dynamic content, you need infrastructure that can execute Node.js alongside the built files. The built-in production server handles this without any additional framework.

```sh
bascik --build   # compile to dist/
bascik --server   # start the HTTP server; runs server scripts per request
```

See [Production Server](/server) for full documentation on server scripts and the request context API.

> **Plaintext HTTP by default.** Bascik's server runs as a plaintext HTTP/1.1 server by default on port `8080`. Most cloud platforms (Heroku, Fly.io, AWS ECS, Render, etc.) terminate TLS at the edge and forward cleartext HTTP to your container. If your platform passes TLS through to the container or you want HTTP/2, set `http.tls.enabled: true` in your `bascik.config.ts`.

### Server configuration

Configure the port and TLS in `bascik.config.ts` before building:

```ts
export default {
  http: {
    port: 8080,
    hostname: '0.0.0.0',          // bind all interfaces; required in containers
    tls: { enabled: false },      // set to true for TLS-enabled HTTP/2
  },
};
```

When `keyFile` and `certFile` are omitted, Bascik generates certificates automatically using mkcert (if installed) or openssl as a fallback. For production, supply a certificate signed by a trusted CA.

### Process supervisor in production

When running `bascik --server` directly on a server or within containers, always run under a process supervisor such as systemd, Docker restart policies, or a container orchestrator (Kubernetes, AWS ECS).

Process-level safety handlers in Bascik ensure that unhandled errors or rejections log complete diagnostics before exiting cleanly with a non-zero code. A supervisor automatically restarts the process in an untainted state:

**systemd unit restart policy:**
```ini
[Service]
Restart=on-failure
RestartSec=3s
```

**Docker container restart policy:**
```sh
docker run -d --restart=unless-stopped -p 8080:8080 my-site
```

### Containers

A two-stage Dockerfile keeps the final image lean:

```dockerfile
# Stage 1: build
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG BASCIK_SITE_URL=https://example.com
RUN npx bascik --build

# Stage 2: serve
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY --from=build /app/dist ./dist
COPY bascik.config.ts .
EXPOSE 8080
CMD ["npx", "bascik", "--server"]
```

The `ARG` makes the site URL a build-time input, so the same Dockerfile builds staging and production images with different `--build-arg BASCIK_SITE_URL=...` values.

If `http.tls.enabled: true` is set, you can supply a real certificate by mounting it at runtime:

```sh
docker run -p 8443:8443 \
  -v /etc/letsencrypt/live/example.com/privkey.pem:/app/bascik-privkey.pem:ro \
  -v /etc/letsencrypt/live/example.com/fullchain.pem:/app/bascik-cert.pem:ro \
  my-site
```

Bascik looks for `bascik-privkey.pem` and `bascik-cert.pem` in the working directory by default; mounting them at those paths means no config change is needed.

### PaaS (Railway, Render, Fly.io, etc.)

Set the start command to `bascik --build && bascik --server`, point the platform's health check at the server port, and configure the port via the `http.port` setting to match the port the platform expects to expose. Set `BASCIK_SITE_URL` in the platform's environment variables so the sitemap and robots.txt carry the public origin.

### VPS or bare metal

Obtain a certificate (e.g. from Let's Encrypt via `certbot`) and point Bascik at it in `bascik.config.ts`. Then create a systemd unit to keep the server running:

```ini
# /etc/systemd/system/my-site.service
[Unit]
Description=My Bascik Site
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/my-site
ExecStartPre=/usr/bin/npx bascik --build
ExecStart=/usr/bin/npx bascik --server
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
Environment=BASCIK_SITE_URL=https://example.com

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now my-site
journalctl -u my-site -f
```

### Caching and cache-control tuning

Bascik inlines component CSS and JavaScript directly into page markup, and `assets.inlineStyles` inlines global stylesheets. External static asset requests are primarily images, fonts, and favicons.

Configure `http.cacheControl` to tune caching policies per extension:

```ts
// bascik.config.ts
export default {
  http: {
    cacheControl: {
      '.woff2': 'public, max-age=31536000, immutable',
      '.png': 'public, max-age=86400',
    },
  },
};
```

Pair `immutable` with fingerprinted filenames where content is immutable.

### Behind a reverse proxy

If you already run nginx, Caddy, or another proxy, proxy HTTPS traffic to Bascik. The proxy-to-backend leg can use Bascik's self-signed certificate; only the client-facing edge needs a trusted cert. Pass the original client IP and any authentication headers through to `data-bascik-server` scripts so they have access to them.

Note that the built-in rate limiter reads the TCP remote address. When running behind a proxy, all requests arrive from the proxy's IP, so rate limiting should be configured at the proxy layer instead.

> **Platform docs.** Consult your hosting provider's documentation for specifics around caching headers, redirects, environment variables, and build pipelines. Bascik's output is standard enough that most generic guides apply directly.
