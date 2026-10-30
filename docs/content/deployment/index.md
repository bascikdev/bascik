# Deployment Overview

Deploying a Bascik site is fast and flexible. Because Bascik compiles your components, styles, and scripts into standard vanilla HTML, CSS, and client JavaScript in `dist/`, you can host your site anywhere: from zero-configuration static hosts and global CDNs to edge serverless platforms and dedicated Node servers.

## Choosing Where to Deploy

Most websites built with Bascik fall into one of three deployment models:

### 1. Static Hosting (Most Common)

If your site is a marketing page, blog, documentation site, portfolio, or uses build-time scripts (`data-bascik-build`) to fetch data, **static hosting is all you need**.

- **How it works:** Run `bascik --build` to produce `dist/` and upload it to any host or CDN.
- **Popular hosts:** Cloudflare (Pages or Workers static assets), GitHub Pages, Netlify, Vercel, AWS S3 / CloudFront, and traditional web servers (NGINX, Caddy, Apache).
- **Zero runtime maintenance:** No Node.js process to keep alive in production, zero compute charges, and instant global caching.

> **Get Started:** Follow our step-by-step, hand-holding [Static Hosting Guide](/deployment/static-hosting) to deploy your site to Cloudflare Pages, GitHub Pages, Netlify, and more in minutes.

### 2. Serverless & Edge Adapters (Cloudflare Workers & Pages)

If your site uses request-time server scripts (`data-bascik-server`), progressive HTML streams (`data-bascik-stream`), or edge API routes (`src/api/`), you can deploy to edge platforms without managing a dedicated server.

- **How it works:** Running `bascik --build --target cloudflare` compiles static assets for the CDN while packaging your server scripts, stream scripts, and API routes into an edge Worker automatically.
- **Benefits:** Global edge execution, zero origin servers to maintain, and automatic streaming.

> **Read the Guide:** Check out the [Cloudflare Adapter](/deployment/cloudflare) guide for build commands, keeping your Wrangler configuration in the repo, Workers Builds, Worker Previews, and edge features, or learn about [Custom Adapters](/deployment/custom-adapters).

### 3. Node.js Production Server (`bascik --server`)

If you prefer self-hosting on a VPS, Docker container, or cloud virtual machine, Bascik includes a built-in production HTTP/1.1 and HTTP/2 server.

- **How it works:** Run `bascik --build` followed by `bascik --server`.
- **Capabilities:** High-throughput HTTP/2, automatic Brotli and Gzip compression, health-check probes, and zero-downtime draining.

> **Read the Guide:** See [Production Server](/production-server) and [Server Scripts](/server-scripts) for configuration details.

---

## Static hosting

For most Bascik sites, `dist/` is the deployable artifact. You only need a static host when nothing on the site runs at request time: no `data-bascik-server` scripts, no `data-bascik-stream` scripts, and no API route files in `src/api/`. Each of those needs something to execute code per request, either the built-in Node server or a [serverless target](#serverless-hosting).

Every major platform follows the same pattern:

1. Run `bascik --build` to produce `dist/`
2. Configure the host to deploy from the `dist/` folder
3. Point the publish directory at `dist/`

For step-by-step walkthroughs across popular platforms, see the dedicated [Static Hosting](/deployment/static-hosting) guide.

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

---

## Content-Security-Policy

Bascik sends no Content-Security-Policy unless you ask. The [Content Security Policy](/how-to/content-security-policy) how-to has a recipe for each host: the `contentSecurityPolicy` option on the Node servers and Cloudflare, and a `<meta>` tag for static hosts.

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

Builds are reproducible and deterministic: identical source inputs always produce byte-identical output across repeated runs and machines. This makes it straightforward to diff `dist/` between builds or verify deployed artifacts against the exact commit that produced them.

Every full dev or build run cleans `directory.out` and its private build folder before pre-phase lifecycle scripts run. The output therefore reflects the current source tree, without pages or assets left behind by earlier runs. Pre-phase scripts can still generate files in the output directory because cleaning finishes before those scripts start. `bascik --server` only reads an existing build and never cleans it. Targeted builds (`bascik --build --only <glob>`) also skip cleaning so existing pages survive when rebuilding a small subset.

### What a static host receives

A static host serves every file of the folder you point it at, dotfiles included, so after a plain `bascik --build`, `dist/` holds only the site: pages, CSS, scripts and assets. Bascik's private build files live in `.bascik/dist/`, beside `dist/` and never inside it: the build state, the ownership inventory (`ownership.json`, which names your source files), and, when the site has them, the server-script sidecar (`server-scripts.json`, the source of every server and stream script), the component manifest, the CSP hashes and the file manifest. The folder is named after [`directory.out`](/configuration#directory), so `build/www` gets `build/.bascik/www/`, and Bascik writes a `.gitignore` into `.bascik/` so it is never committed.

| Deploy                                       | What it copies                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Static host (Pages, Netlify, S3, a web root) | `dist/` from a plain `bascik --build`, never after a `--target` build                                                    |
| `bascik --server` on your own machine        | both `dist/` and `.bascik/dist/` from the same build, with the project's `bascik.config.ts`, `src/api/` and dependencies |
| `--target cloudflare`                        | `dist/.bascik/cloudflare/` (its `public/` folder and the Worker); see [Cloudflare](/deployment/cloudflare)               |

`.bascik/dist/` holds the server scripts and CSP hashes for the pages of its own build, so a `bascik --server` deploy copies both folders from the same `bascik --build`. The build records the content of every page it wrote. When a page in `dist/` differs from that record, `bascik --server` starts and prints one warning that names the pages (or says that all of them changed). A deploy step that edits `dist/` after the build (adding analytics, a minifier, a CDN rewrite) is the expected cause. The warning ends with how to start without it: make the change in a `post` [exec script](/exec-scripts), which runs before the build records its pages and takes their CSP hashes.

The warning compares page HTML only. It catches a `.bascik/dist/` copied from another build when that build wrote different pages. A build that changed only a server script's source writes the same pages, because the source lives in the sidecar and each placeholder is named by its page and position. A `.bascik/dist/` from such a build starts with no warning and runs that build's server scripts, so always copy both folders from the same build.

The server serves each page as it is in `dist/`, with the server scripts and CSP hashes `.bascik/dist/` holds. A server script runs from the sidecar, matched to its placeholder in the page. A minifier may change the placeholder's quotes, letter case, whitespace or attribute order, because a browser reads every such spelling as the same attributes. It must keep the `<script>` element with its `type="text/bascik-server"` and its `data-bascik-server-id`. A `post` exec script that removes a placeholder fails the build: once the `post` phase finishes, `bascik --build` (plain or `--target`) checks that every page still has each placeholder the sidecar holds for it, and stops before any deployment folder is written. The message names the page, how many server scripts the sidecar holds for it, and the tag to paste back, with `data-bascik-stream` for a stream script. If a page edited after the build no longer has such a placeholder, `bascik --server` refuses to start with the same message.

When the site sends a CSP, a deploy step after the build that adds, removes or rewrites an inline `<script>` or `<style>` makes those blocks fail the CSP hashes. A minifier that drops one trailing semicolon is enough. Browsers block that code, or report it when the policy is `reportOnly`. With [`contentSecurityPolicy`](/configuration#contentsecuritypolicy) set, the startup warning names each changed page whose inline code is no longer all in `csp-hashes.json`. It counts only the kinds the policy restricts with hashes, so inline styles are left out when the policy has no `style-src` or `default-src`, or allows `'unsafe-inline'` styles. A `post` exec script fixes this: once the `post` phase finishes, the build takes the CSP hashes again from the pages in `dist/`, so `csp-hashes.json`, the `bascik --server` header and a `--target` deployment's headers match the HTML that ships. The warning checks inline hashes only. A step that moves an external script or stylesheet to another host, such as a CDN rewrite or an analytics tag, needs that host in `script-src` or `style-src`.

`bascik --server` refuses to start only when it cannot run the release: `dist/` copied without `.bascik/dist/` (it names both folders); a page whose server-script placeholder the sidecar does not hold or holds in another mode (a `.bascik/dist/` from an older build that lacks a script the new `dist/` names), which names the page and asks for `bascik --build`; or a page that lost a placeholder the sidecar holds for it, as above. A `--only` build refuses a `dist/` whose pages differ from the record, because it keeps the other pages' server scripts and CSP hashes. It names the first such page and both causes: you edited `dist/` after the build (make the change in a `post` exec script, or run a full `bascik --build`, which reconciles), or `.bascik/dist/` came from another build.

A `--target` build writes its deployment folder inside `dist/`, to `dist/.bascik/<target>/`: the Worker, with the source of every server script and API route, and its config. Deploy that folder, not `dist/`, and do not point a static host at `dist/` after a `--target` build, or it publishes the Worker; the build prints the same note. The deployment folder's own `public/` folder never holds a `.bascik` path. See [What is the `.bascik/` folder?](/faq#what-is-the-bascik-folder).

### Consuming the build manifest

When `generate.manifest: true` is configured, Bascik outputs `.bascik/dist/manifest.json`. Deployment workflows and CDN synchronization scripts can consume this manifest to upload only modified files or verify build outputs:

```js
// Example deploy-layer script reading .bascik/dist/manifest.json
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(".bascik/dist/manifest.json", "utf8"));
for (const [relPath, info] of Object.entries(manifest.files)) {
  console.log(
    `Deploying ${relPath} (${info.size} bytes, SHA-256: ${info.hash})`,
  );
}
```

### Content Security Policy

Bascik inlines component `<style>` blocks and wraps component `<script>` blocks in isolated IIFEs. To support a strict policy without `'unsafe-inline'`, enable `generate.cspHashes: true` in `bascik.config.ts`. Bascik emits `.bascik/dist/csp-hashes.json` mapping each page to its exact post-minification inline script and style SHA-256 hashes (`sha256-<base64>`), taken from the pages as `post` exec scripts left them.

Bascik sends no policy of its own because the policy depends on your site and your host. Setting a generic one inside the framework would provide false assurance. The [`contentSecurityPolicy`](/configuration#contentsecuritypolicy) option sends the directives you write, plus these hashes, from the Node servers and the Cloudflare Worker, and turns on `generate.cspHashes` for you. [Content Security Policy](/how-to/content-security-policy) shows how to turn the hashes into a policy on each host.

### Cross-Origin Isolation Headers

Bascik sets safe default cross-origin headers:

- `Cross-Origin-Opener-Policy: same-origin-allow-popups`
- `Cross-Origin-Resource-Policy: cross-origin`

These defaults allow cross-origin images, fonts, and authentication popups to function without unexpected breaks. If full cross-origin isolation (e.g. `SharedArrayBuffer`) is required, configure `Cross-Origin-Embedder-Policy: require-corp` at your hosting layer.

### Excluded source files

To keep deployment artifacts clean, the following files are excluded from static asset copying and are never copied to `dist/`:

- **Component source files**: all files in `src/components/` are source templates, resolved at build time, and never copied to `dist/`
- **Page templates**: `.html` files in `src/pages/` are transpiled into compiled pages
- **TypeScript files**: `.ts` source files used by build scripts or helper modules
- **Other source files**: `.mjs`, `.cjs`, `.mts`, and `.cts` modules, source maps (`.map`), and Markdown (`.md`)
- **API route handlers**: files in `src/api/` (`directory.api`) are runtime handlers executed in server mode and are never copied to static `dist/`. Because handler source code is strictly protected and never published, accessing private environment secrets via `process.env` in handlers remains secure.
- **Test files**: any test file matching `*.test.*` or `*.spec.*` (e.g. `styles.test.ts`)
- **Inlined stylesheets**: global CSS files configured in `assets.inlineStyles` (injected directly into `<head>`)
- **Hidden paths**: every dotfile and every file below a dot-directory, except a top-level `.well-known/` directory (see below)
- **Dependencies**: every file below a `node_modules` directory

### Well-Known URIs

Files in `src/pages/.well-known/` are published to `dist/.well-known/` and served at `/.well-known/`, the [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615) location for files such as `security.txt`, `assetlinks.json`, and `agent-skills/index.json`:

```text
src/pages/.well-known/security.txt   ->  https://example.com/.well-known/security.txt
```

This is the only dot-directory Bascik publishes, and only directly under `src/pages/`. Dotfiles inside it (`.well-known/.env`) and a `.well-known` folder anywhere else (`src/pages/blog/.well-known/`) are still excluded, and the usual deny-list applies to the files inside it, so `.md`, `.ts`, and `.html` files there are not copied. With a non-root `base` such as `/docs/`, the directory is served at `/docs/.well-known/`. The dev server, `bascik --server`, and the Cloudflare adapter all serve it. Files without an extension (for example `apple-app-site-association`) are served as pages, not assets, so give them an extension or serve them from an [API route](/api-routes).

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

### Subdirectory deploys

Set `base` when the site is published at a path such as `https://example.com/docs/` instead of the domain root. GitHub Pages project sites are a common example: a repository named `my-site` is normally published at `https://account.github.io/my-site/`.

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  base: "/my-site/",
});
```

Bascik normalizes the leading and trailing slash, rewrites root-relative HTML, CSS, and web app manifest URLs during the build, and serves pages and static assets below the same prefix in development and with `bascik --server`. Generated sitemap, robots, and canonical URLs compose the site URL, base, and page path in that order.

Requests outside the configured prefix return `404 Not Found`. With `base: '/my-site/'`, request `/my-site/about`, not `/about`. This strict behavior matches a static host and catches incorrect links during local preview. Live reload also connects through the prefix automatically.

A custom domain mapped to the project site usually serves it from `/`, so leave the default `base: '/'` in that deployment shape.

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
- **Request URL origin reconstruction** (`request.url` in API routes and server scripts) reconstructs the public scheme (`http` or `https`) and authority from the rightmost entries of `X-Forwarded-Proto` and `X-Forwarded-Host`. If headers are omitted or malformed, Bascik safely falls back to local transport parameters.
- **HSTS security headers** recognize `X-Forwarded-Proto: https` forwarded by the proxy, and send the value from [`security.hsts`](/configuration#securityhsts) (`max-age=31536000` by default, without `includeSubDomains`).

When `trustProxy: false` (the default), `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` headers are strictly ignored to prevent client spoofing. Do not enable `trustProxy` if the server is directly exposed to the public Internet without a trusted reverse proxy.

#### Security Model and Reverse Proxy Contract

Enabling `trustProxy: true` is only secure when ingress is strictly controlled so all client traffic flows through the reverse proxy, and the proxy sanitizes or strips untrusted client-supplied forwarded headers.

Because `http.trustProxy` is a boolean flag, Bascik trusts the immediate upstream proxy and reads the rightmost forwarded header entries. If the proxy does not sanitize untrusted inbound headers, a client could potentially send conflicting headers. Additionally, `request.url.origin` reflects the reconstructed external target address and is not an authorization decision. Application handlers that validate CORS, webhooks, or CSRF must compare incoming requests against an explicit configured canonical origin or allowlist rather than trusting `request.url.origin` as an authorization policy.

### Health checks and zero-downtime deployments

`bascik --server` provides built-in endpoints for load balancer and orchestrator health checks:

- **Liveness probe:** `GET /_health/live` returns `200 OK` as long as the process is alive.
- **Readiness probe:** `GET /_health` (or `GET /_health/ready`) returns `200 OK` when the server is ready to accept traffic, and `503 Service Unavailable` during boot and during the shutdown drain window.

Configure your container orchestrator (e.g. Kubernetes, AWS ECS) or load balancer with:

- **Health check path:** `/_health`
- **Shutdown signal:** `SIGTERM`
- **Deregistration delay:** Match or exceed `http.timeouts.drain` (default `5000` ms) so the load balancer stops routing new traffic before the process exits.
