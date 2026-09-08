# Overview

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

For most Bascik sites, `dist/` is the deployable artifact. You only need a static host when nothing on the site runs at request time: no `data-bascik-server` scripts, no `data-bascik-stream` scripts, and no API route files in `src/api/`. Each of those needs something to execute code per request, either the built-in Node server or a [serverless target](#serverless-hosting).

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

## Serverless hosting

Serverless here means you do not operate Bascik's Node server: a CDN serves the static files and a managed function runs your server scripts, stream scripts, and API routes per request. Bascik builds this as an explicit, opt-in target so the default `dist/` stays a plain static tree.

Hosting adapters are installable packages that implement the `@bascik/bascik/adapter` contract. Official targets include `cloudflare-pages` and `cloudflare-workers` via `@bascik/adapter-cloudflare`. Third parties can publish custom adapters using `@bascik/bascik/adapter` and runtime helpers from `@bascik/bascik/runtime`. See [Cloudflare Adapter](/deployment/cloudflare) for the tested recipe, support matrix, and provider limits, or read [Custom Adapters](/deployment/custom-adapters) to learn how to author custom deployment adapters.

## Using the production server

If your site uses `data-bascik-server` scripts for per-request dynamic content, you need infrastructure that can execute Node.js alongside the built files. The built-in production server handles this without any additional framework.

```sh
bascik --build   # compile to dist/
bascik --server   # start the HTTP server; runs server scripts per request
```

See [Production Server](/production-server) for full documentation on server configuration and [Server Scripts](/server-scripts) for the request context API.
