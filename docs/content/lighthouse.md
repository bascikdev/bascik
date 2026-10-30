# Lighthouse 100s Overview

Bascik gives you an enormous head start on Lighthouse scores. Because it outputs vanilla HTML with zero framework runtime, you begin every page with near-perfect scores, and reaching 100 across the scored Lighthouse categories, plus a clean Agentic Browsing report, is a matter of applying a small, well-known set of HTML patterns. This section has one page for each of the five categories.

| Performance | Accessibility | Best Practices | SEO | Agentic Browsing |
| :---------: | :-----------: | :------------: | :-: | :--------------: |
|     100     |      100      |      100       | 100 |       3/3        |

Agentic Browsing is the newest Lighthouse category. It reports a pass ratio instead of a 0 to 100 score. See [Agentic Browsing](/lighthouse/agentic-browsing) for what it checks and which audits are opt-in.

Framework sites start at a deficit. Every component, every route, every reactive binding you add ships more JavaScript to the browser: more to parse, more to execute before the page is usable. The Lighthouse scores that look fine on a five-page MVP look very different at fifty pages with real content, images, and third-party scripts.

Bascik inverts that relationship. Adding a new component adds zero JavaScript to your pages. Adding a new page adds zero overhead. Your performance baseline stays constant no matter how large the codebase grows. The only thing that affects your scores is what you deliberately put on the page.

> **Fast at any size and complexity.** Framework-rendered pages ship a JavaScript runtime, a hydration pass, and client-side routing logic before a single pixel of your content appears. Bascik ships none of that. The browser receives finished HTML. Every byte saved at the start compounds through every Core Web Vital metric.

## The Five Categories

Start with the category you want to improve. Each page lists what Lighthouse checks, what Bascik already does for you, and the vanilla HTML, CSS, and JavaScript patterns for the rest.

- **[Performance](/lighthouse/performance):** Responsive images, lazy loading, resource hints, font loading, critical CSS, minification, and profiling with Chrome DevTools.
- **[Accessibility](/lighthouse/accessibility):** Semantic landmarks, labels, skip links, contrast, focus, and native interactive elements like `<details>` and `<dialog>`. Start with [Component Best Practices](/component-best-practices#use-htmls-elements): most accessibility audits pass when each element is the right one for its job.
- **[Best Practices](/lighthouse/best-practices):** HTTPS, a valid document shell, image aspect ratios, a clean console, and Content Security Policy hashes.
- **[SEO](/lighthouse/seo):** Titles, descriptions, canonical URLs, Open Graph, JSON-LD structured data, and a complete head template.
- **[Agentic Browsing](/lighthouse/agentic-browsing):** The accessibility tree, layout stability, and `llms.txt` for AI agents and automated browsers.

## What Bascik Does

Bascik's performance story starts before any of the techniques on the category pages. The build step is intentionally small, and that small footprint is itself an optimization.

**Zero runtime.** The most impactful thing Bascik does is what it does not add. No framework bundle, no hydration script, no client-side router. The only JavaScript on any page is what you wrote.

**CSS deduplication.** When a component appears multiple times on a page, Bascik emits a single `<style>` block regardless of instance count. A page with fifty cards carries the same CSS weight as a page with one.

**HTML minification.** HTML comments are stripped and excess whitespace is collapsed in every built page. Content inside `<pre>`, `<textarea>`, `<script>`, and `<style>`, and every attribute value, is left intact, and non-breaking spaces are never touched. The minifier does not read your CSS: an element styled `white-space: pre` (or `pre-wrap`, `pre-line`) that is not a `<pre>` loses its extra spaces and line breaks, so use `<pre>` for preformatted text or set `minify.html: false`.

**Script minification.** `minify.js` is `true` by default, stripping comments and whitespace from every inline `<script>` block and any `.js` static files copied to `dist/`. For local variable renaming and constant folding, worth roughly another 9% of compressed script bytes, plug in esbuild (see [Minify JavaScript Output](/lighthouse/performance#minify-javascript-output-byominifier)).

**Maximum Brotli compression.** Under `bascik --server` and `bascik --build`, pages are compressed using maximum Brotli quality (`BROTLI_MAX_QUALITY = 11`), delivering optimal payload sizes for production delivery. Compressible static assets (CSS, JavaScript, SVG, JSON) up to 2 MiB are compressed on demand by negotiation; already-compressed formats (images, video, WOFF2) and assets above 2 MiB are served as-is. Large assets are streamed from disk rather than buffered, so a burst of requests for a big file does not multiply its size in server memory.

**Inline styles.** Set `assets.inlineStyles` in `bascik.config.ts` to inject a stylesheet directly into `<head>`, eliminating the render-blocking HTTP request for that file entirely. Production builds minify the injected CSS automatically. When enforcing a strict Content Security Policy, enable `generate.cspHashes: true` to obtain exact SHA-256 hashes for all inlined styles and scripts without resorting to `'unsafe-inline'`.

**Sitemap and robots.txt.** Once `BASCIK_SITE_URL` is set, `bascik --build` writes `dist/sitemap.xml` and `dist/robots.txt` for you. See [Sitemap & robots.txt](/sitemap).

### Precompressed assets

By default `bascik --server` compresses eligible static assets on demand, once per representation, and keeps the result in a bounded in-memory cache. To move that work to build time, set `http.precompress: true`:

```ts
export const build = defineConfig({
  http: { precompress: true },
});
```

The build then writes `<asset>.br`, `<asset>.gz`, and a `.bmeta` provenance file beside each compressible asset of at least 512 bytes. The server serves a sidecar only when its `.bmeta` hash matches the current asset bytes, so a stale sidecar from an earlier deploy is never served under a new ETag; it falls back to on-demand compression instead. Sidecars are also useful when `dist/` is deployed to a static host or CDN that honors precompressed files. The option is off by default because it adds two max-quality codec passes per asset to the build and roughly doubles the on-disk footprint of compressible assets.

Hitting 100 across the board is achievable on any Bascik site. The category pages cover the rest: standard HTML patterns with no build plugins, no dependencies, and no configuration required.

## Real-World Benchmarks: McMaster-Carr and Bring a Trailer

Two of the fastest content-heavy sites on the internet share a core philosophy: ship finished HTML and let the browser do what it was designed to do.

**McMaster-Carr** (mcmaster.com) is an industrial supply catalog with over 600,000 products. Its homepage loads in under a second on a mobile connection and scores 100 across all four Lighthouse categories. The homepage is almost entirely vanilla HTML links and text, no JavaScript framework, no hydration step, no layout shift. The browser receives a complete document and paints it immediately.

**Bring a Trailer** (bringatrailer.com) is an auction platform that serves hundreds of high-resolution car photos per page. It achieves near-perfect Lighthouse scores by resizing images at the CDN level, every thumbnail is served at exactly the pixel dimensions it occupies in the layout, and by fixing explicit aspect ratios on image containers so the layout never shifts as photos load in.

These sites are on opposite ends of the content spectrum: one is text-dense and nearly image-free, the other is image-dense with live auction data updating in real time. Both score 100. The lesson: perfect Lighthouse scores are not about the volume of content, they are about how you deliver it.
