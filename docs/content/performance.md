# Lighthouse 100s

Bascik gives you an enormous head start on Lighthouse scores. Because it outputs vanilla HTML with zero framework runtime, you begin every page with near-perfect scores, and reaching 100 across all four Lighthouse categories is a matter of applying a small, well-known set of HTML patterns.

| Performance | Accessibility | Best Practices | SEO |
| :---: | :---: | :---: | :---: |
| 100 | 100 | 100 | 100 |

Framework sites start at a deficit. Every component, every route, every reactive binding you add ships more JavaScript to the browser: more to parse, more to execute before the page is usable. The Lighthouse scores that look fine on a five-page MVP look very different at fifty pages with real content, images, and third-party scripts.

Bascik inverts that relationship. Adding a new component adds zero JavaScript to your pages. Adding a new page adds zero overhead. Your performance baseline stays constant no matter how large the codebase grows. The only thing that affects your scores is what you deliberately put on the page.

> **Fast at any size and complexity.** Framework-rendered pages ship a JavaScript runtime, a hydration pass, and client-side routing logic before a single pixel of your content appears. Bascik ships none of that. The browser receives finished HTML. Every byte saved at the start compounds through every Core Web Vital metric.

## What Bascik Does

Bascik's performance story starts before any of the techniques on this page. The build step is intentionally small, and that small footprint is itself an optimization.

**Zero runtime.** The most impactful thing Bascik does is what it does not add. No framework bundle, no hydration script, no client-side router. The only JavaScript on any page is what you wrote.

**CSS deduplication.** When a component appears multiple times on a page, Bascik emits a single `<style>` block regardless of instance count. A page with fifty cards carries the same CSS weight as a page with one.

**HTML minification.** HTML comments are stripped and excess whitespace is collapsed in every built page. Content inside `<pre>` blocks is left intact.

**Script minification.** `minify.js` is `true` by default, stripping comments and whitespace from every inline `<script>` block and any `.js` static files copied to `dist/`. For identifier mangling and dead-code elimination, plug in esbuild (see [Minify JavaScript Output](#minify-javascript-output) below).

**Maximum Brotli compression.** Under `bascik --server` and `bascik --build`, pages are compressed using maximum Brotli quality (`BROTLI_MAX_QUALITY = 11`), delivering optimal payload sizes for production delivery.

**Inline styles.** Set `inlineStyles` in `bascik.config.ts` to inject a stylesheet directly into `<head>`, eliminating the render-blocking HTTP request for that file entirely. Pair it with `minify.css: true` to minify the injected CSS at build time. When enforcing a strict Content Security Policy, enable `generate.cspHashes: true` to obtain exact SHA-256 hashes for all inlined styles and scripts without resorting to `'unsafe-inline'`.

Hitting 100 across the board is achievable on any Bascik site. The techniques below cover the rest: standard HTML patterns with no build plugins, no dependencies, and no configuration required.

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
  srcset="
    photo-400.jpg  400w,
    photo-800.jpg  800w,
    photo-1200.jpg 1200w
  "
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
<img src="gallery-1.jpg" alt="Gallery image 1" loading="lazy" width="600" height="400" />

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
      if (!href || preloaded.has(href) || href.startsWith('#') || href.startsWith('http')) {
        return;
      }
      preloaded.add(href);
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      document.head.appendChild(link);
    }

    // Dynamic prefetching on all local navigation links
    document.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;

      let timer;
      a.addEventListener('pointerenter', () => {
        if (preloaded.has(href)) return;
        // Wait 65ms to avoid prefetching on rapid pointer movements
        timer = setTimeout(() => preload(href), 65);
      });

      a.addEventListener('pointerleave', () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      });

      a.addEventListener('focus', () => preload(href));
      a.addEventListener('touchstart', () => preload(href), { passive: true });
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
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXX"></script>

  <!-- App logic: needs the DOM, runs after parsing is complete -->
  <script defer src="/js/app.js"></script>

  <!-- A module script is deferred automatically -->
  <script type="module" src="/js/counter.js"></script>
</head>
```

Because Bascik adds no runtime scripts of its own, every `<script>` tag in your output is one you wrote. You have complete control over load order and execution timing from the first character of every page.

> **MDN reference.** The [`<script>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script#attributes) on MDN lists every attribute including `defer`, `async`, and `type`, with execution-order notes and browser compatibility.

## SEO: The Essential Head Tags

Lighthouse's SEO audit checks for a short list of meta tags and structural signals. All of them are vanilla HTML attributes, nothing to install or configure.

Bascik also helps with one of the easy-to-miss SEO assets: once `BASCIK_SITE_URL` is set, `bascik --build` generates `dist/sitemap.xml` for you by default. That gives crawlers a complete list of your pages without adding another plugin or build step.

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Unique, descriptive title for every page -->
  <title>Getting Started - Bascik Docs</title>

  <!-- Description shown in search results (150–160 chars) -->
  <meta name="description" content="Install Bascik and build your first reusable HTML component in under five minutes." />

  <!-- Canonical URL: prevents duplicate-content issues -->
  <link rel="canonical" href="https://yourdomain.com/getting-started" />

  <!-- Open Graph: controls how the page looks when shared -->
  <meta property="og:title" content="Getting Started - Bascik Docs" />
  <meta property="og:description" content="Install Bascik and build your first reusable HTML component." />
  <meta property="og:image" content="https://yourdomain.com/og/getting-started.jpg" />
  <meta property="og:url" content="https://yourdomain.com/getting-started" />
  <meta property="og:type" content="website" />

  <!-- Twitter / X card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Getting Started - Bascik Docs" />
  <meta name="twitter:description" content="Install Bascik and build your first reusable HTML component." />
  <meta name="twitter:image" content="https://yourdomain.com/og/getting-started.jpg" />
</head>
```

Because every Bascik page is its own `.html` file, every page naturally gets its own `<title>` and `<meta name="description">`: the two most impactful SEO signals. There is no single-page-app router to work around.

## Structured Data with JSON-LD

Structured data tells search engines what your content *means*, not just what it says. Google uses it to generate **rich results**: FAQ dropdowns, breadcrumb trails, star ratings, article bylines, and product prices shown directly in the search listing before the user clicks.

Add a `<script type="application/ld+json">` block to your `<head>` with the schema for your content type. Bascik never touches `application/ld+json` script blocks, so the JSON passes through exactly as written.

**FAQ rich results**: turns your page's questions into expandable dropdowns in search results:

```html
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "What is Bascik?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Bascik is a build tool that compiles reusable HTML components into vanilla HTML pages with no JavaScript runtime."
        }
      },
      {
        "@type": "Question",
        "name": "Does Bascik add JavaScript to my pages?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "No. Bascik outputs vanilla HTML. The only JavaScript on any page is what you write yourself."
        }
      }
    ]
  }
  </script>
</head>
```

Other commonly useful types:

```html
<!-- BreadcrumbList: shows the page path in search results -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://yourdomain.com/" },
    { "@type": "ListItem", "position": 2, "name": "Docs", "item": "https://yourdomain.com/docs/" },
    { "@type": "ListItem", "position": 3, "name": "Getting Started" }
  ]
}
</script>

<!-- Article: shows author, date, and headline metadata -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Getting Started with Bascik",
  "author": { "@type": "Person", "name": "Collin Thomas" },
  "datePublished": "2025-01-01",
  "dateModified": "2025-06-01"
}
</script>
```

Bascik's [build scripts](/build-scripts) are a natural fit for generating JSON-LD from data files. Read a JSON data source at build time and emit the `<script type="application/ld+json">` block with zero runtime cost, always up to date with your content.

> **Validate before shipping.** Use [Google's Rich Results Test](https://search.google.com/test/rich-results) to confirm your structured data is valid and eligible for rich result types. Schema.org publishes the full type vocabulary at [schema.org](https://schema.org).

## Accessibility

The Lighthouse accessibility audit checks for semantic HTML, sufficient color contrast, keyboard navigability, and ARIA usage. Because Bascik outputs real HTML, every accessibility technique the platform provides is available to you without a plugin or library.

```html
<!-- Use semantic landmark elements -->
<header>…</header>
<nav aria-label="Primary navigation">…</nav>
<main>…</main>
<footer>…</footer>

<!-- Every image needs a meaningful alt (or empty alt for decorative images) -->
<img src="chart.png" alt="Bar chart showing 40% growth in Q3" />
<img src="divider.svg" alt="" role="presentation" />

<!-- Buttons must have accessible names -->
<button type="button" aria-label="Close dialog">
  <svg aria-hidden="true">…</svg>
</button>

<!-- Form inputs must be labeled -->
<label for="email">Email address</label>
<input type="email" id="email" name="email" autocomplete="email" />

<!-- Skip link: lets keyboard users bypass the navigation -->
<a href="#main-content" class="skip-link">Skip to main content</a>
```

A **skip link** is one of the highest-value, lowest-effort accessibility improvements you can add. Style it to be visually hidden until focused, then revealed, so it does not affect the visual layout for mouse users.

```css
/* Accessible skip link pattern */
.skip-link {
  position: absolute;
  top: -100%;
  left: 0;
  padding: 8px 16px;
  background: #d3ff8d;
  color: #000;
  font-weight: 600;
  z-index: 9999;
  text-decoration: none;
}

.skip-link:focus {
  top: 0;
}
```

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
  font-family: 'Inter';
  src: url('/fonts/inter-var.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  /* 3. Show text immediately with the fallback font,
        swap to Inter when it arrives */
  font-display: swap;
}

/* 4. Minimize layout shift with a metric-matched fallback */
@font-face {
  font-family: 'Inter-fallback';
  src: local('Arial');
  ascent-override: 90%;
  descent-override: 22%;
  line-gap-override: 0%;
  size-adjust: 107%;
}

body {
  font-family: 'Inter', 'Inter-fallback', sans-serif;
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

* **The Frames Track and Screenshots:** Hover over the timeline to see filmstrip screenshots of what your user saw at each millisecond. Look for the exact point where content is first painted (First Contentful Paint) and when the largest element becomes visible (Largest Contentful Paint).
* **The Experience Track (Layout Shifts):** Look for red bars in this track. Hovering over a layout shift bar highlights the exact DOM elements that moved, letting you know which image or container needs a fixed aspect ratio.
* **The Main Thread Flame Graph:** This chart shows CPU activity. Each horizontal bar represents a function call, with deeper bars representing nested calls. 
  * Look for **Long Tasks** (tasks taking longer than 50 milliseconds), which are flagged with a red top-right corner.
  * Framework sites typically show a dense, colorful block of JavaScript execution during hydration that blocks the main thread.
  * Bascik sites should show an incredibly clean, sparse Main thread, as they rely on vanilla HTML/JavaScript/CSS with no heavy runtime parsing.

### Exporting and Sharing Performance Traces

Performance profiles can be exported to share with teammates, compare against historical baselines, or analyze in external tools.

1. Click the **Download profile** button (the downward-pointing arrow icon in the Performance panel toolbar).
2. Save the resulting JSON file (typically named `Profile-YYYYMMDDTHHMMSS.json`).
3. To view or analyze a saved profile later, or on another machine, open the Performance tab in DevTools and click the **Upload profile** button (the upward-pointing arrow icon), or drag and drop the JSON file directly into the Performance panel.

You can also load these exported JSON files into third-party performance visualization tools or the online [Chrome DevTools Timeline Viewer](https://chromedevtools.github.io/timeline-viewer/) to inspect the trace details in a full-screen interface without having the source site running locally.

## Real-World Benchmarks: McMaster-Carr and Bring a Trailer

Two of the fastest content-heavy sites on the internet share a core philosophy: ship finished HTML and let the browser do what it was designed to do.

**McMaster-Carr** (mcmaster.com) is an industrial supply catalog with over 600,000 products. Its homepage loads in under a second on a mobile connection and scores 100 across all four Lighthouse categories. The homepage is almost entirely vanilla HTML links and text, no JavaScript framework, no hydration step, no layout shift. The browser receives a complete document and paints it immediately.

**Bring a Trailer** (bringatrailer.com) is an auction platform that serves hundreds of high-resolution car photos per page. It achieves near-perfect Lighthouse scores by resizing images at the CDN level, every thumbnail is served at exactly the pixel dimensions it occupies in the layout, and by fixing explicit aspect ratios on image containers so the layout never shifts as photos load in.

These sites are on opposite ends of the content spectrum: one is text-dense and nearly image-free, the other is image-dense with live auction data updating in real time. Both score 100. The lesson: perfect Lighthouse scores are not about the volume of content, they are about how you deliver it.

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
    https://cdn.example.com/photo.jpg?w=470&h=318&format=webp  1x,
    https://cdn.example.com/photo.jpg?w=940&h=636&format=webp  2x
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
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

The shimmer disappears the moment the image loads (since `<img>` renders over the background). The result: a polished loading experience with zero JavaScript and zero layout shift.

> **MDN reference.** [`aspect-ratio`](https://developer.mozilla.org/en-US/docs/Web/CSS/aspect-ratio) on MDN covers the full syntax including keyword values and browser compatibility.

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

## Inline Critical CSS

McMaster-Carr's pages paint instantly because the CSS needed for the above-the-fold layout arrives in the same HTTP response as the HTML, not in a separate stylesheet the browser must fetch and parse before it can draw anything. This technique is called **critical CSS inlining**.

```html
<head>
  <!-- Critical CSS inlined: zero extra round trips to paint the first screen -->
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; }
    header { display: flex; align-items: center; padding: 16px 24px; }
    .hero { min-height: 60vh; display: grid; place-items: center; }
    nav a { color: inherit; text-decoration: none; }
  </style>

  <!-- Full stylesheet loaded asynchronously - does not block first paint -->
  <link rel="preload" as="style" href="/css/styles.css"
        onload="this.onload=null;this.rel='stylesheet'" />
  <noscript><link rel="stylesheet" href="/css/styles.css" /></noscript>
</head>
```

The `onload` trick converts the preloaded asset into a live stylesheet the moment it finishes downloading, without blocking the initial render. The `<noscript>` fallback loads the full stylesheet for users with JavaScript disabled.

Keep inlined critical CSS to the minimum needed for above-the-fold visibility, typically 1–5 KB of minified CSS covering the header, hero section, and primary navigation.

> **Bascik tip.** If your global stylesheet is small (under ~15 KB), skip the split entirely, set `inlineStyles` in your config and Bascik handles it automatically. Zero render-blocking requests, no FOUC, and production builds minify the injected CSS when `minify.css` is true:
>
> ```ts
> // bascik.config.ts
> import { defineConfig } from '@bascik/bascik/config';
>
> export default defineConfig({
>   inlineStyles: ['src/css/styles.css'],
> });
>
> export const build = defineConfig({
>   minify: { css: true },
> });
> ```
>
> Once your stylesheet grows past roughly 15–20 KB (gzipped: ~4–5 KB), it is worth considering a linked external stylesheet instead. The tradeoff: the first page load pays one extra HTTP request, but every subsequent page in the session gets the file from the browser cache for free. If most of your traffic arrives from search and reads a single page, inline wins. If visitors typically navigate several pages per session, the cached external file pays off by page two. HTTP/2 reduces the penalty of the extra request significantly, but it does not eliminate it.

## Minify JavaScript Output & BYOMinifier

Bascik's `minify.js` option strips comments and collapses whitespace from every inline `<script>` block and any `.js` files copied into `dist/`. It is `true` by default, so production builds are already smaller without any configuration.

For maximum compression, identifier mangling, dead-code elimination, and tree-shaking, Bascik's **BYOMinifier (Bring Your Own Minifier)** lets you point `minify.js` at esbuild's `transform` API. esbuild has zero npm dependencies (it ships as a single native binary) and is typically 10–100× faster than alternatives:

```sh
npm install --save-dev esbuild
```

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';
import { transform } from 'esbuild';

export const build = defineConfig({
  minify: {
    css: true,
    js: async (js) => {
      const result = await transform(js, { minify: true, loader: 'js' });
      return result.code;
    },
  },
});
```

The function receives the raw JS string for each script block and must return the minified string. Async functions are fully supported, so any Promise-based minifier works. The built-in `true` mode is a safe fallback for projects that prefer to keep their toolchain dependency-free.

> **What gets minified.** Only inline scripts (those without a `src` attribute) and `.js` static files copied to `dist/`. External scripts loaded with `src=` and non-JS script types such as `application/ld+json` are always left untouched.

## Ship HTML First

The deepest lesson from McMaster-Carr is architectural. Its homepage has no JavaScript framework, no client-side router, and no hydration step. Every category link is a plain `<a>` tag. Every product name is a text node delivered in the first TCP packet.

A Bascik site or any statically built HTML page works the same way. Compare the waterfalls:

| Step | Framework SPA | Static HTML (Bascik) |
| --- | :---: | :---: |
| 1 | Fetch HTML shell | Fetch complete HTML |
| 2 | Fetch JS bundle | Browser paints ✓ |
| 3 | Parse & execute JS | |
| 4 | Fetch API data | |
| 5 | Render content | |

A framework SPA requires five sequential steps before the user sees content. A static HTML page requires one. Every framework adds steps; every step adds latency that compounds across all network conditions.

This is why sites like McMaster-Carr, which could justify a rich SPA for their 600,000-product catalog, choose server-rendered HTML. Content is immediately useful to every user on every device, and search engines index it without executing JavaScript.

> **Add interactivity surgically.** McMaster's search autocomplete is a small, focused script that loads after the page is visible. Bring a Trailer's live bid counter is a lightweight WebSocket updater, not a full application framework. Use Bascik's scoped `<script>` blocks or `<script defer>` to layer in interactivity after the HTML has painted, never block the first render for it.

## CSS-First Interactivity

Before writing a line of JavaScript for any UI behavior, ask: **can HTML and CSS do this?**

The browser ships a set of interactive primitives that require zero JavaScript. Using them makes your pages lighter, more accessible (they work even when JS fails or is blocked), and zero-parse-cost for the engine. The rule is simple: reach for JavaScript only when the platform genuinely cannot do the job.

### Collapsible Sections and Toggle Menus: `<details>`

`<details>` and `<summary>` give you a fully accessible toggle with no JavaScript, open/close state, keyboard activation (Enter, Space), Escape to close, and correct ARIA roles are all handled by the browser:

```html
<details>
  <summary>How does Bascik scope CSS?</summary>
  <p>It prefixes every class name with a component-unique hash at build time.</p>
</details>
```

The same pattern works for mobile navigation drawers. Wrap the nav links in `<details>`, put the hamburger button inside `<summary>`, and use the `[open]` attribute in CSS to drive all state:

```html
<nav>
  <a href="/" class="logo">MySite</a>
  <details class="nav-details">
    <summary class="nav-toggle" aria-label="Toggle navigation">
      <span class="hamburger-icon"></span>
    </summary>
    <ul class="nav-links">
      <li><a href="/about">About</a></li>
      <li><a href="/blog">Blog</a></li>
    </ul>
  </details>
</nav>
```

```css
/* Remove the default <summary> triangle marker */
.nav-toggle { list-style: none; cursor: pointer; }
.nav-toggle::-webkit-details-marker { display: none; }

/* Desktop: always show nav links regardless of open/closed state */
@media (min-width: 769px) {
  .nav-details { display: flex; align-items: center; }
  .nav-details > summary { display: none; }
  .nav-details > .nav-links { display: flex; } /* override UA hidden state */
}

/* Mobile: show links when open - pure CSS, no event listeners */
@media (max-width: 768px) {
  .nav-links { display: none; }
  .nav-details[open] > .nav-links { display: flex; flex-direction: column; }

  /* Animate hamburger → X using the [open] selector */
  .nav-details[open] .hamburger-icon { background: transparent; }
  .nav-details[open] .hamburger-icon::before { top: 0; transform: rotate(45deg); }
  .nav-details[open] .hamburger-icon::after  { top: 0; transform: rotate(-45deg); }
}

/* Lock body scroll when the overlay is open - still no JS */
body:has(.nav-details[open]) {
  overflow: hidden;
}
```

> **`body:has()`** is supported in Chrome 105+, Firefox 121+, and Safari 15.4+. It is the CSS-only solution to the previously JS-only problem of locking the page scroll behind an open overlay.

> **MDN reference.** [`<details>` and `<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details) on MDN document the `open` attribute, keyboard behavior, and accessibility semantics. The [`:has()` pseudo-class](https://developer.mozilla.org/en-US/docs/Web/CSS/:has) covers the CSS parent selector and browser support.

### Modal Dialogs: `<dialog>`

The `<dialog>` element provides a native modal with backdrop, focus trapping, and Escape-to-close, behaviors that previously required hundreds of lines of JavaScript to implement correctly:

```html
<button onclick="document.getElementById('my-modal').showModal()">Open</button>

<dialog id="my-modal">
  <p>Modal content here.</p>
  <form method="dialog">
    <button>Close</button>
  </form>
</dialog>
```

```css
dialog::backdrop {
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}
```

The `onclick` inline handlers are one-liners, not a script file. `<dialog>` handles focus management, keyboard dismissal, and `aria-modal` automatically.

> **MDN reference.** The [`<dialog>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog) on MDN covers `showModal()`, `close()`, `returnValue`, the `::backdrop` pseudo-element, and browser compatibility.

### The Decision Framework

When building any interactive feature, work through this checklist before writing JavaScript:

1. **Can a native HTML element do it?** `<details>`, `<dialog>`, `<input type="range">`, `<datalist>`, `<meter>`, `<progress>` cover a huge range of interactive patterns out of the box.
2. **Can a CSS state selector do it?** `:checked`, `:target`, `:hover`, `:focus-within`, `:has()`, `[open]` handle most toggle and reveal behaviors.
3. **Can an HTML attribute do it?** `loading="lazy"`, `required`, `disabled`, `hidden`, `contenteditable`.

Only if all three answers are no should you reach for JavaScript. When you do, scope it, defer it, and keep it small.

## Agentic Browsing

Lighthouse 13.3 introduced a new **Agentic Browsing** category that audits how well a site supports AI agents and automated browsers. It is still under development, but it already checks three things that Bascik sites pass by default.

**Accessibility tree is well-formed.** AI agents navigate pages through the accessibility tree, the same structure that screen readers use. Bascik outputs real, semantic HTML (`<nav>`, `<main>`, `<header>`, `<footer>`, labeled `<button>` elements, `<img alt="">`) so the accessibility tree is correct without any extra effort.

**Cumulative Layout Shift is 0.** When content moves after load, agents that have already built a representation of the page are working from stale coordinates. Because Bascik ships finished HTML with explicit `width` and `height` on every image and no client-side rendering pass, there is nothing left to shift.

**`llms.txt` follows recommendations.** Lighthouse checks that the `llms.txt` file at the root of a site is a valid Markdown file with at least one H1 heading. Bascik's docs generate `llms.txt` from the same content Markdown files that drive the pages, so it is always valid.

> **llms.txt reference.** The [`llms.txt` specification](https://llmstxt.org/) defines the standard Markdown index format for LLMs and AI agents.

> **Bascik sites score 3/3 on Agentic Browsing without any configuration.** Correct HTML, zero layout shift, and a well-formed `llms.txt` are natural properties of a statically built site. Frameworks that hydrate on the client introduce layout shift during hydration and often produce an accessibility tree that differs from the initial server-rendered HTML, both of which hurt this score.

## The Kitchen Sink: Complete Head Template

Here is a complete `<head>` combining every technique on this page. Copy it as a starting point for any Bascik page and fill in the values specific to your site.

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <title>Page Title - Site Name</title>
  <meta name="description" content="One or two sentences describing this specific page." />
  <link rel="canonical" href="https://yourdomain.com/page-path" />

  <!-- Open Graph -->
  <meta property="og:title" content="Page Title - Site Name" />
  <meta property="og:description" content="One or two sentences describing this specific page." />
  <meta property="og:image" content="https://yourdomain.com/og/page-path.jpg" />
  <meta property="og:url" content="https://yourdomain.com/page-path" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />

  <!-- Preconnect to critical third-party origins -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="dns-prefetch" href="https://www.googletagmanager.com" />

  <!-- Preload critical assets -->
  <link rel="preload" as="image" href="/images/hero.jpg" />
  <link rel="preload" as="font" href="/fonts/inter-var.woff2" type="font/woff2" crossorigin />

  <!-- Styles: use inlineStyles in bascik.config.ts to eliminate render-blocking requests -->

  <!-- Prefetch likely next navigation -->
  <link rel="prefetch" href="/next-page" />

  <!-- Scripts: async for independent third parties, defer for your code -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXX"></script>
  <script defer src="/js/app.js"></script>
</head>
```
