# Performance

Lighthouse's Performance category is where Bascik's zero-runtime design pays off most. It scores load speed and stability through Core Web Vitals such as Largest Contentful Paint (LCP) and Cumulative Layout Shift (CLS). A Bascik page starts with no framework JavaScript to parse and no hydration pass, so your remaining work is deciding how images, fonts, styles, and scripts reach the browser. Every technique here is standard HTML or CSS.

See the [Lighthouse overview](/lighthouse) for what Bascik does automatically, such as CSS deduplication, HTML and script minification, and Brotli compression.

## Ship HTML First

The deepest lesson from McMaster-Carr (see [Real-World Benchmarks](/lighthouse#real-world-benchmarks-mcmaster-carr-and-bring-a-trailer)) is architectural. Its homepage has no JavaScript framework, no client-side router, and no hydration step. Every category link is a plain `<a>` tag. Every product name is a text node delivered in the first TCP packet.

A Bascik site or any statically built HTML page works the same way. Compare the waterfalls:

| Step |   Framework SPA    | Static HTML (Bascik) |
| ---- | :----------------: | :------------------: |
| 1    |  Fetch HTML shell  | Fetch complete HTML  |
| 2    |  Fetch JS bundle   |   Browser paints ✓   |
| 3    | Parse & execute JS |                      |
| 4    |   Fetch API data   |                      |
| 5    |   Render content   |                      |

A framework SPA requires five sequential steps before the user sees content. A static HTML page requires one. Every framework adds steps; every step adds latency that compounds across all network conditions.

This is why sites like McMaster-Carr, which could justify a rich SPA for their 600,000-product catalog, choose server-rendered HTML. Content is immediately useful to every user on every device, and search engines index it without executing JavaScript.

With the production server, marking slow request-time blocks `<script data-bascik-stream>` lets the shell of a server-rendered page reach the browser before that backend work finishes. This moves Time to First Byte (TTFB) and First Contentful Paint (FCP) to roughly the static-page baseline while Largest Contentful Paint (LCP) still depends on the slowest `server` script and on any `stream` script placed before the LCP element. See [Placeholders That Do Not Shift Layout](/stream-scripts#placeholders-that-do-not-shift-layout) for zero-CLS streaming recipes.

> **Add interactivity surgically.** McMaster's search autocomplete is a small, focused script that loads after the page is visible. Bring a Trailer's live bid counter is a lightweight WebSocket updater, not a full application framework. Use Bascik's scoped `<script>` blocks or `<script defer>` to layer in interactivity after the HTML has painted, never block the first render for it. Many common widgets need no script at all; see [native interactive elements](/lighthouse/accessibility#css-first-interactivity).

## Responsive Images with `srcset`

Sending a 2400 px image to a 375 px phone is one of the most common performance killers on the web. The `srcset` attribute tells the browser which image file to choose based on the device's pixel density and viewport width, no JavaScript required.

```html
<!-- Density-based srcset: serve 2x for retina screens -->
<img
  src="hero.jpg"
  srcset="hero.jpg 1x, hero@2x.jpg 2x"
  alt="A scenic mountain landscape"
  width="800"
  height="450"
/>

<!-- Width-based srcset with sizes: let the browser pick -->
<img
  src="photo-800.jpg"
  srcset="photo-400.jpg 400w, photo-800.jpg 800w, photo-1200.jpg 1200w"
  sizes="(max-width: 600px) 100vw, 800px"
  alt="Team photo"
  width="800"
  height="533"
  loading="lazy"
/>
```

Always include explicit `width` and `height` attributes. The browser uses them to reserve layout space before the image loads, which eliminates Cumulative Layout Shift (CLS), a Core Web Vital that Lighthouse measures directly.

> **MDN reference.** The [`srcset` attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/srcset) and [`sizes` attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/sizes) on MDN cover the full selection syntax and every valid descriptor.

## Lazy Loading

The browser only needs to fetch images and iframes that are currently visible. Adding `loading="lazy"` defers off-screen resources until the user scrolls near them, reducing initial page weight and improving Largest Contentful Paint (LCP) for the above-the-fold content.

```html
<!-- Images below the fold -->
<img
  src="gallery-1.jpg"
  alt="Gallery image 1"
  loading="lazy"
  width="600"
  height="400"
/>

<!-- Third-party embeds -->
<iframe
  src="https://www.youtube-nocookie.com/embed/VIDEO_ID"
  title="Product walkthrough video"
  loading="lazy"
  width="560"
  height="315"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
  allowfullscreen
></iframe>
```

Do **not** apply `loading="lazy"` to your hero image or any image visible without scrolling. The browser will already prioritize it, adding lazy loading to a critical image delays it and hurts your LCP score.

> **MDN reference.** [`loading="lazy"`](https://developer.mozilla.org/en-US/docs/Web/Performance/Lazy_loading) on MDN covers deferred loading for both images and iframes, including browser thresholds and compatibility.

## Image CDN: One Source, Infinite Sizes

Storing one high-resolution source image and generating correctly-sized derivatives at request time is one of the most scalable image strategies available. Bring a Trailer appends transform parameters directly to each image URL:

```text
https://cdn.example.com/photo.jpg?w=470&h=318&crop=1
```

Most modern CDNs, Cloudflare Images, Imgix, Cloudinary, Bunny.net Transform, support this pattern. You upload a full-resolution photo once and the CDN generates WebP or AVIF derivatives at whatever dimensions the layout needs, cached at the edge closest to each user. No build step. No local image processing pipeline.

```html
<!-- CDN delivers the exact pixel size the layout needs -->
<img
  src="https://cdn.example.com/photo.jpg?w=470&h=318&format=webp"
  srcset="
    https://cdn.example.com/photo.jpg?w=470&h=318&format=webp 1x,
    https://cdn.example.com/photo.jpg?w=940&h=636&format=webp 2x
  "
  alt="1968 Toyota Land Cruiser"
  width="470"
  height="318"
  loading="lazy"
/>
```

If your host does not support CDN transforms, use `<picture>` to offer WebP with a JPEG fallback, all declarative HTML, no JavaScript, no build step:

```html
<picture>
  <source
    type="image/webp"
    srcset="photo-470.webp 470w, photo-940.webp 940w"
    sizes="(max-width: 600px) 100vw, 470px"
  />
  <img
    src="photo-470.jpg"
    srcset="photo-470.jpg 470w, photo-940.jpg 940w"
    sizes="(max-width: 600px) 100vw, 470px"
    alt="1968 Toyota Land Cruiser"
    width="470"
    height="318"
    loading="lazy"
  />
</picture>
```

Browsers that support WebP choose the `<source>`; others fall back to the `<img>` src automatically.

> **MDN reference.** The [`<picture>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/picture) on MDN covers art direction, format selection with `<source>`, and fallback behavior.

## `aspect-ratio` CSS: Layout Stability Before Images Load

Explicit `width` and `height` attributes reserve image space before the network responds. The `aspect-ratio` CSS property extends that reservation to any container, useful when images are CSS backgrounds, when you use `object-fit` to fill flex cells, or when you need a stable skeleton layout while lazy-loading dozens of images.

Bring a Trailer pins every auction thumbnail to a `470×318` ratio. The page skeleton renders at the correct height the instant the HTML arrives, so there is zero layout shift as car photos stream in:

```html
<div class="card-image">
  <img
    src="photo.jpg?w=470&h=318"
    alt="1968 Toyota Land Cruiser"
    width="470"
    height="318"
    loading="lazy"
  />
</div>
```

```css
.card-image {
  aspect-ratio: 470 / 318;
  width: 100%;
  overflow: hidden;
  /* Skeleton shimmer while image is pending */
  background-color: #f0f0f0;
  background-image: linear-gradient(
    90deg,
    #f0f0f0 25%,
    #e0e0e0 50%,
    #f0f0f0 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.card-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
```

The shimmer disappears the moment the image loads (since `<img>` renders over the background). The result: a polished loading experience with zero JavaScript and zero layout shift.

> **MDN reference.** [`aspect-ratio`](https://developer.mozilla.org/en-US/docs/Web/CSS/aspect-ratio) on MDN covers the full syntax including keyword values and browser compatibility.

## Preloading Critical Assets

`<link rel="preload">` tells the browser to fetch a resource as soon as possible, before it would normally discover it in the HTML or CSS. Use it for assets that are critical to the first render: your hero image, a web font, or a stylesheet loaded by a script.

```html
<head>
  <!-- Preload the LCP hero image -->
  <link rel="preload" as="image" href="hero.jpg" />

  <!-- Preload a web font (prevents invisible text flash) -->
  <link
    rel="preload"
    as="font"
    href="/fonts/inter-var.woff2"
    type="font/woff2"
    crossorigin
  />

  <!-- Preload a critical stylesheet that a script would inject late -->
  <link rel="preload" as="style" href="/css/above-fold.css" />
</head>
```

Only preload what you actually use on the current page. Preloading resources that are never consumed triggers a Lighthouse warning and wastes bandwidth.

> **MDN reference.** [`<link rel="preload">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/preload) on MDN documents every valid `as` value, CORS handling, and browser support notes.

> **Fingerprinting and Lighthouse.** Content-hash asset fingerprinting is a CDN caching technique, not a Lighthouse technique. The `uses-long-cache-ttl` audit is unweighted in Lighthouse 10 and later, so fingerprinting will not move the score. Bascik inlines component CSS and JavaScript, so fingerprinting only applies to images, fonts, and other copied page assets. See [Asset Fingerprinting](/how-to/asset-fingerprinting).

## Prefetching the Next Page

`<link rel="prefetch">` fetches a resource during idle time and caches it for a future navigation. When you know the user is very likely to go to a specific page next, like the next step of a checkout flow or the top item in your navigation, prefetch it and the navigation will feel instant.

```html
<head>
  <!-- Prefetch the most likely next page -->
  <link rel="prefetch" href="/getting-started" />

  <!-- Prefetch an image used heavily on the next page -->
  <link rel="prefetch" as="image" href="/getting-started/hero.jpg" />
</head>
```

Prefetch is low-priority and only runs during idle time, so it never competes with resources the current page needs. It is safe to add for any high-confidence next-page prediction.

> **MDN reference.** [`<link rel="prefetch">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/prefetch) on MDN describes the priority model, browser support, and interaction with the HTTP cache.

### Dynamic Prefetching on Hover and Focus

While hardcoding `<link rel="prefetch">` tags works well for high-priority pages, you can dynamically prefetch navigation links as the user interacts with your site. This is how the Bascik documentation sidebar and search results work under the hood.

By listening for `pointerenter` (hover), `focus`, and `touchstart` events on link elements, you can append a `<link rel="prefetch">` element to your document `<head>` just as the user begins their navigation attempt. Since a typical user hovers over a link for about 100 to 300 milliseconds before clicking it, this simple script gives the browser a valuable head start to fetch and cache the next page.

Here is a vanilla HTML/JavaScript/CSS pattern to implement dynamic prefetching on your links:

```html
<script>
  (function () {
    const preloaded = new Set();

    function preload(href) {
      if (
        !href ||
        preloaded.has(href) ||
        href.startsWith("#") ||
        href.startsWith("http")
      ) {
        return;
      }
      preloaded.add(href);
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    }

    // Dynamic prefetching on all local navigation links
    document.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;

      let timer;
      a.addEventListener("pointerenter", () => {
        if (preloaded.has(href)) return;
        // Wait 65ms to avoid prefetching on rapid pointer movements
        timer = setTimeout(() => preload(href), 65);
      });

      a.addEventListener("pointerleave", () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      });

      a.addEventListener("focus", () => preload(href));
      a.addEventListener("touchstart", () => preload(href), { passive: true });
    });
  })();
</script>
```

This pattern costs almost nothing to run. The 65 millisecond delay on `pointerenter` prevents unnecessary prefetches when a cursor sweeps across the page. By the time the user presses down or releases their mouse button, the browser is already downloading the destination document. When they click, the page loads instantly from the disk or memory cache.

## DNS Prefetch & Preconnect

Every external domain requires a DNS lookup, a TCP handshake, and a TLS negotiation before the first byte of data arrives. For critical third-party origins, fonts, analytics, a CDN, you can start that work as early as possible by adding one or two `<link>` tags to your `<head>`.

```html
<head>
  <!-- Step 1: resolve the DNS as early as possible -->
  <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
  <link rel="dns-prefetch" href="https://fonts.gstatic.com" />

  <!-- Step 2: for truly critical origins, open the full connection
       (DNS + TCP + TLS) before it is needed -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
</head>
```

Use `preconnect` sparingly, each open connection consumes browser resources. Reserve it for origins you will definitely hit within the first few seconds of the page load. Use `dns-prefetch` as the lightweight fallback for everything else.

> **MDN reference.** [`<link rel="preconnect">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/preconnect) and [`rel="dns-prefetch"`](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/dns-prefetch) on MDN detail the connection phases each hint triggers and when to prefer one over the other.

## Async and Deferred Scripts

A plain `<script src="…">` tag blocks HTML parsing while the browser fetches and executes the file. Two attributes eliminate that block:

- **`defer`:** fetches the script in parallel with HTML parsing and executes it after the document is fully parsed, in order. Use this for scripts that need the DOM ready.
- **`async`:** fetches in parallel and executes as soon as the download finishes, out of order. Use this for fully independent scripts (analytics, chat widgets) that have no dependencies on other scripts or the DOM.

```html
<head>
  <!-- Analytics: fully independent, run as soon as it arrives -->
  <script
    async
    src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXX"
  ></script>

  <!-- App logic: needs the DOM, runs after parsing is complete -->
  <script defer src="/js/app.js"></script>

  <!-- A module script is deferred automatically -->
  <script type="module" src="/js/counter.js"></script>
</head>
```

Because Bascik adds no runtime scripts of its own, every `<script>` tag in your output is one you wrote. You have complete control over load order and execution timing from the first character of every page.

> **MDN reference.** The [`<script>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script#attributes) on MDN lists every attribute including `defer`, `async`, and `type`, with execution-order notes and browser compatibility.

## Minify JavaScript Output & BYOMinifier

Bascik's `minify.js` option strips comments and collapses whitespace from every inline `<script>` block and any `.js` files copied into `dist/`. It is `true` by default, so production builds are already smaller without any configuration.

For maximum compression, identifier mangling, dead-code elimination, and tree-shaking, Bascik's **BYOMinifier (Bring Your Own Minifier)** lets you point `minify.js` at esbuild's `transform` API. esbuild has zero npm dependencies (it ships as a single native binary) and is typically 10–100× faster than alternatives:

```sh
npm install --save-dev esbuild
```

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";
import { transform } from "esbuild";

export const build = defineConfig({
  minify: {
    js: async (js) => {
      const result = await transform(js, { minify: true, loader: "js" });
      return result.code;
    },
  },
});
```

The function receives the raw JS string for each script block and must return the minified string. Async functions are fully supported, so any Promise-based minifier works. The built-in `true` mode is a safe fallback for projects that prefer to keep their toolchain dependency-free.

> **What gets minified.** Only inline scripts (those without a `src` attribute) and `.js` static files copied to `dist/`. External scripts loaded with `src=` and non-JS script types such as `application/ld+json` are always left untouched.

## Inline Critical CSS

McMaster-Carr's pages paint instantly because the CSS needed for the above-the-fold layout arrives in the same HTTP response as the HTML, not in a separate stylesheet the browser must fetch and parse before it can draw anything. This technique is called **critical CSS inlining**.

```html
<head>
  <!-- Critical CSS inlined: zero extra round trips to paint the first screen -->
  <style>
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      line-height: 1.5;
    }
    header {
      display: flex;
      align-items: center;
      padding: 16px 24px;
    }
    .hero {
      min-height: 60vh;
      display: grid;
      place-items: center;
    }
    nav a {
      color: inherit;
      text-decoration: none;
    }
  </style>

  <!-- Full stylesheet loaded asynchronously - does not block first paint -->
  <link
    rel="preload"
    as="style"
    href="/css/styles.css"
    onload="this.onload=null;this.rel='stylesheet'"
  />
  <noscript><link rel="stylesheet" href="/css/styles.css" /></noscript>
</head>
```

The `onload` trick converts the preloaded asset into a live stylesheet the moment it finishes downloading, without blocking the initial render. The `<noscript>` fallback loads the full stylesheet for users with JavaScript disabled.

Keep inlined critical CSS to the minimum needed for above-the-fold visibility, typically 1–5 KB of minified CSS covering the header, hero section, and primary navigation.

> **Bascik tip.** If your global stylesheet is small (under ~15 KB), skip the split entirely, set `assets.inlineStyles` in your config and Bascik handles it automatically. Zero render-blocking requests, no FOUC, and production builds minify the injected CSS automatically:
>
> ```ts
> // bascik.config.ts
> import { defineConfig } from "@bascik/bascik/config";
>
> export default defineConfig({
>   assets: {
>     inlineStyles: ["src/css/styles.css"],
>   },
> });
> ```
>
> Once your stylesheet grows past roughly 15–20 KB (gzipped: ~4–5 KB), it is worth considering a linked external stylesheet instead. The tradeoff: the first page load pays one extra HTTP request, but every subsequent page in the session gets the file from the browser cache for free. If most of your traffic arrives from search and reads a single page, inline wins. If visitors typically navigate several pages per session, the cached external file pays off by page two. HTTP/2 reduces the penalty of the extra request significantly, but it does not eliminate it.

## `content-visibility: auto` for Long Catalog Pages

McMaster-Carr lists hundreds of product categories on its homepage. Bring a Trailer streams dozens of auction cards. For pages with long repeating content, `content-visibility: auto` tells the browser to skip layout and paint for off-screen sections entirely, rendering each chunk on demand as the user scrolls.

```css
/* Applied to each repeating content section */
.auction-card,
.product-category,
.listing-row {
  content-visibility: auto;
  /* Hint the browser to reserve this much vertical space per item
     so the scrollbar height stays accurate before items render */
  contain-intrinsic-size: auto 320px;
}
```

On a page with 100 cards, this can reduce initial rendering time by 50–70% because the browser only paints what is visible. Set `contain-intrinsic-size` close to the real rendered height of one item, the browser will correct it after the first render cycle.

> **Test scroll behavior carefully.** Hidden sections use estimated heights, which can cause minor scroll-position drift if `contain-intrinsic-size` is far from the actual height. Measure in DevTools before shipping.

> **MDN reference.** [`content-visibility`](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility) and [`contain-intrinsic-size`](https://developer.mozilla.org/en-US/docs/Web/CSS/contain-intrinsic-size) on MDN cover the full syntax, browser support, and sizing recommendations.

## Web Fonts Without the Flash

Web fonts are a common source of both performance and layout problems. Two CSS properties and one `<link rel="preload">` eliminate nearly all of them.

```html
<!-- 1. Preload the font file so it arrives early -->
<link
  rel="preload"
  as="font"
  href="/fonts/inter-var.woff2"
  type="font/woff2"
  crossorigin
/>
```

```css
/* 2. Declare the font face */
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-var.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  /* 3. Show text immediately with the fallback font,
        swap to Inter when it arrives */
  font-display: swap;
}

/* 4. Minimize layout shift with a metric-matched fallback */
@font-face {
  font-family: "Inter-fallback";
  src: local("Arial");
  ascent-override: 90%;
  descent-override: 22%;
  line-gap-override: 0%;
  size-adjust: 107%;
}

body {
  font-family: "Inter", "Inter-fallback", sans-serif;
}
```

`font-display: swap` ensures text is visible immediately using the fallback font, then swaps to your custom font once it loads. The metric-override `@font-face` makes the fallback font's dimensions closely match your custom font, minimizing CLS during the swap.

> **MDN reference.** [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) documents the full descriptor set including variable font ranges, and [`font-display`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display) covers every swap strategy with timing diagrams.

## Profiling with the Chrome DevTools Performance Tab

While Lighthouse provides a high-level score and checklist, the **Performance** panel in Google Chrome DevTools is the definitive tool for diagnosing real-world performance. It lets you capture a precise timeline of your page load, locate CPU-bound bottlenecks, identify Layout Shifts, and inspect individual frame rendering times.

### Recording a Performance Profile

To capture and analyze a performance profile of your page:

1. Open your page in Google Chrome. For accurate measurements, use an Incognito window to prevent browser extensions from polluting the results.
2. Open DevTools by pressing `Cmd + Option + I` on macOS or `Ctrl + Shift + I` on Windows and Linux, then select the **Performance** tab.
3. To profile a page load, click the **Start profiling and reload page** button (the circular arrow icon). DevTools will reload the page, record activity until the page is fully loaded and idle, and then stop recording automatically.
4. To profile a dynamic interaction, click the **Record** button (the solid gray circle), perform the action on your page (such as opening a modal or sorting a list), and then click **Stop**.

### Analyzing the Flame Chart and Tracks

Once the recording completes, DevTools displays a comprehensive timeline. Here is what to focus on to improve your site's speed:

- **The Frames Track and Screenshots:** Hover over the timeline to see filmstrip screenshots of what your user saw at each millisecond. Look for the exact point where content is first painted (First Contentful Paint) and when the largest element becomes visible (Largest Contentful Paint).
- **The Experience Track (Layout Shifts):** Look for red bars in this track. Hovering over a layout shift bar highlights the exact DOM elements that moved, letting you know which image or container needs a fixed aspect ratio.
- **The Main Thread Flame Graph:** This chart shows CPU activity. Each horizontal bar represents a function call, with deeper bars representing nested calls.
  - Look for **Long Tasks** (tasks taking longer than 50 milliseconds), which are flagged with a red top-right corner.
  - Framework sites typically show a dense, colorful block of JavaScript execution during hydration that blocks the main thread.
  - Bascik sites should show an incredibly clean, sparse Main thread, as they rely on vanilla HTML/JavaScript/CSS with no heavy runtime parsing.

### Exporting and Sharing Performance Traces

Performance profiles can be exported to share with teammates, compare against historical baselines, or analyze in external tools.

1. Click the **Download profile** button (the downward-pointing arrow icon in the Performance panel toolbar).
2. Save the resulting JSON file (typically named `Profile-YYYYMMDDTHHMMSS.json`).
3. To view or analyze a saved profile later, or on another machine, open the Performance tab in DevTools and click the **Upload profile** button (the upward-pointing arrow icon), or drag and drop the JSON file directly into the Performance panel.

You can also load these exported JSON files into third-party performance visualization tools or the online [Chrome DevTools Timeline Viewer](https://chromedevtools.github.io/timeline-viewer/) to inspect the trace details in a full-screen interface without having the source site running locally.

> **Next:** The same hints appear in the [complete head template](/lighthouse/seo#the-kitchen-sink-complete-head-template) on the SEO page.
