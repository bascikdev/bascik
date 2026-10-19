# SEO

Lighthouse's SEO category checks a short list of meta tags and structural signals: a document title, a meta description, a viewport tag, a valid canonical URL, a crawlable page, descriptive link text, image `alt` attributes, and legible font sizes with tappable targets. Every one of them is a vanilla HTML attribute, so there is nothing to install or configure.

Because every Bascik page is its own `.html` file, every page naturally gets its own `<title>` and `<meta name="description">`: the two most impactful SEO signals. There is no single-page-app router to work around, and search engines receive finished HTML without executing JavaScript.

## SEO: The Essential Head Tags

Bascik also helps with one of the easy-to-miss SEO assets: once `BASCIK_SITE_URL` is set, `bascik --build` generates `dist/sitemap.xml` and `dist/robots.txt` for you by default. That gives crawlers a complete list of your pages without adding another plugin or build step. See [Sitemap & robots.txt](/sitemap).

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Unique, descriptive title for every page -->
  <title>Getting Started - Bascik Docs</title>

  <!-- Description shown in search results (150–160 chars) -->
  <meta
    name="description"
    content="Install Bascik and build your first reusable HTML component in under five minutes."
  />

  <!-- Canonical URL: prevents duplicate-content issues -->
  <link rel="canonical" href="https://yourdomain.com/getting-started" />

  <!-- Open Graph: controls how the page looks when shared -->
  <meta property="og:title" content="Getting Started - Bascik Docs" />
  <meta
    property="og:description"
    content="Install Bascik and build your first reusable HTML component."
  />
  <meta
    property="og:image"
    content="https://yourdomain.com/og/getting-started.jpg"
  />
  <meta property="og:url" content="https://yourdomain.com/getting-started" />
  <meta property="og:type" content="website" />

  <!-- Twitter / X card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Getting Started - Bascik Docs" />
  <meta
    name="twitter:description"
    content="Install Bascik and build your first reusable HTML component."
  />
  <meta
    name="twitter:image"
    content="https://yourdomain.com/og/getting-started.jpg"
  />
</head>
```

Two audits depend on how you deploy rather than on the markup. A page returning a non-success status code, or carrying `noindex`, is not crawlable. And a `robots.txt` that blocks all crawlers on a staging site will fail the audit on that host, so run the final audit against production-equivalent settings.

## Structured Data with JSON-LD

Structured data tells search engines what your content _means_, not just what it says. Google uses some types to generate **rich results** shown directly in the search listing before the user clicks, such as breadcrumb trails, article bylines and dates, and product prices. Types without a visual result still give search engines and AI assistants a machine-readable summary of the page.

Add a `<script type="application/ld+json">` block to your `<head>` with the schema for your content type. Bascik never touches `application/ld+json` script blocks, so the JSON passes through exactly as written.

**FAQPage**: marks up question-and-answer content. Google shows FAQ rich results only for well-known government and health sites, so on most sites this markup describes the page without adding expandable dropdowns to the listing. Unused structured data causes no problems in search:

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
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Home",
        "item": "https://yourdomain.com/"
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": "Docs",
        "item": "https://yourdomain.com/docs/"
      },
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

## The Kitchen Sink: Complete Head Template

Here is a complete `<head>` combining the SEO tags above with the resource hints from [Performance](/lighthouse/performance). Copy it as a starting point for any Bascik page and fill in the values specific to your site.

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <title>Page Title - Site Name</title>
  <meta
    name="description"
    content="One or two sentences describing this specific page."
  />
  <link rel="canonical" href="https://yourdomain.com/page-path" />

  <!-- Open Graph -->
  <meta property="og:title" content="Page Title - Site Name" />
  <meta
    property="og:description"
    content="One or two sentences describing this specific page."
  />
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
  <link
    rel="preload"
    as="font"
    href="/fonts/inter-var.woff2"
    type="font/woff2"
    crossorigin
  />

  <!-- Styles: use inlineStyles in bascik.config.ts to eliminate render-blocking requests -->

  <!-- Prefetch likely next navigation -->
  <link rel="prefetch" href="/next-page" />

  <!-- Scripts: async for independent third parties, defer for your code -->
  <script
    async
    src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXX"
  ></script>
  <script defer src="/js/app.js"></script>
</head>
```
