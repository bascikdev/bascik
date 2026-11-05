# SEO

Lighthouse's SEO category checks a short list of meta tags and structural signals: a document title, a meta description, a viewport tag, a valid canonical URL, a crawlable page, descriptive link text, image `alt` attributes, and legible font sizes with tappable targets. Every one of them is a vanilla HTML attribute, so there is nothing to install or configure.

Because every Bascik page is its own `.html` file, every page can have a title and description written for its content. These help search engines understand and present pages, but Google may rewrite title links and generate query-specific snippets; neither tag guarantees a ranking or a particular search appearance. There is no single-page-app router to work around, and search engines receive finished HTML without executing JavaScript.

## SEO: The Essential Head Tags

Bascik also helps with one of the easy-to-miss SEO assets: once `BASCIK_SITE_URL` is set, `bascik --build` generates `dist/sitemap.xml` and `dist/robots.txt` for you by default. That gives crawlers a complete list of your pages without adding another plugin or build step. See [Sitemap & robots.txt](/sitemap).

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Unique, accurate title for every page -->
  <title>Getting Started - Bascik Docs</title>

  <!-- A useful summary; Google may instead use visible page text for the snippet -->
  <meta
    name="description"
    content="Install Bascik and build your first reusable HTML component in under five minutes."
  />

  <!-- Preferred URL for this page -->
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

### Social Preview Image Tags

Open Graph treats `og:image:width`, `og:image:height`, `og:image:type`, and `og:image:alt` as properties of the `og:image` tag before them, and `twitter:image:alt` belongs to `twitter:image` in the same way. Put each one directly after its image tag. Apple's LinkPresentation framework, which builds iMessage link previews, drops the image when `twitter:image:alt` comes before the image tags, and the preview shows only the title and site icon.

```html
<meta property="og:image" content="https://yourdomain.com/og/page-path.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Page title" />
<meta name="twitter:image" content="https://yourdomain.com/og/page-path.jpg" />
<meta name="twitter:image:alt" content="Page title" />
```

Messages caches a preview for each URL, so a link sent before a fix keeps its old preview. Test a fix with a URL Messages has not seen, such as one with `?v=2` appended.

## Site Names, Titles, and Snippets

Google automatically determines the site name, title link, and snippet shown for a result. Use consistent, clear signals, but treat them as guidance rather than controls. See [site names](https://developers.google.com/search/docs/appearance/site-names), [title links](https://developers.google.com/search/docs/appearance/title-link), and [snippets](https://developers.google.com/search/docs/appearance/snippet).

For a site name, use the same recognizable brand in the home page's visible content, title, and `og:site_name`. You can also identify the site on its home page with a single `WebSite` structured-data item whose `url` is the canonical home-page URL:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Acme",
    "url": "https://example.com/"
  }
</script>
```

Google may still select a different site name. `alternateName` is optional; use it only for a genuine alternate name, not as a list of keywords.

Write a unique, concise, accurate `<title>` for each page. Keep it aligned with the page's main visible heading and content, and avoid repeated boilerplate or keyword stuffing. Google can build a title link from the `<title>`, prominent headings and text, links to the page, and other signals such as `og:title`; it may change the result when those sources are unclear or inconsistent. There is no fixed Google character limit.

Write a distinct, useful meta description for each page, but don't expect it to always become the snippet. Google primarily creates snippets from page content and may choose different text for different queries. A meta description can be used when it describes the page better than the visible text Google would otherwise select. There is no fixed Google description length. The character ranges enforced by Bascik's audit and docs tests are editorial targets, not Google requirements.

## Help Google Choose Sitelinks

Sitelinks are the extra links Google may show beneath a site's main search result. Google selects them automatically based on its understanding of the site and the search query. There is no meta tag, JSON-LD property, sitemap setting, or Bascik configuration that can require Google to show a particular set of pages or rank the home page first.

To make the site's hierarchy and important pages clear:

1. Give the home page a unique, descriptive title and heading that identify the site or brand. Give every other page its own concise, descriptive title and heading too.
2. Link from the home page to the most useful starting points, and include those pages in the site's shared navigation where they belong.
3. Use ordinary crawlable `<a href="...">` links. Give each link concise text that describes its destination, such as `Getting Started`, rather than a generic label such as `Read more`.
4. Link between related pages when it helps visitors understand what to read next. Keep navigation logical and avoid repeating the same links or keywords unnaturally.
5. Build with `BASCIK_SITE_URL` so Bascik can generate a sitemap, then use Google Search Console to inspect the canonical home-page URL and request indexing after publishing. A sitemap helps discovery; it does not control ranking or sitelinks.

These practices help search engines understand the site, but they do not guarantee a first-place result or any specific sitelinks. Google shows them only when its systems consider them useful for a query. See [Google's sitelinks guidance](https://developers.google.com/search/docs/appearance/sitelinks) for the current recommendations.

## Structured Data with JSON-LD

Structured data gives search engines machine-readable information about a page. It can help Google understand the content and may make a page eligible for a specific supported **rich result**; it does not guarantee a rich result or improve ordinary ranking by itself. A Schema.org type is not automatically a Google search feature. Check Google's [structured-data introduction](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data) and [gallery of supported search features](https://developers.google.com/search/docs/appearance/structured-data/search-gallery).

Use JSON-LD for structured data when it fits your project. Add a `<script type="application/ld+json">` block to your `<head>` with data that accurately describes the visible page. Bascik never touches `application/ld+json` script blocks, so the JSON passes through exactly as written. Follow Google's [general structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies) and the specific requirements for the feature.

Structured data must be relevant, current, complete for its feature, and consistent with content people can see on the page. Irrelevant, misleading, or hidden markup can make a page ineligible for rich results or lead to a manual action affecting rich-result eligibility. Don't add markup just because a type exists in Schema.org.

**FAQPage**: marks up question-and-answer content. Google generally limits FAQ rich results to well-known, authoritative government- and health-focused sites, so most sites should not expect an expandable FAQ result. Only use this markup when the questions and answers are visible on the page:

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

An [enriched search result](https://developers.google.com/search/docs/appearance/enriched-search-results) is an appearance for a supported feature, not a generic benefit of adding schema. Use the appropriate feature on pages whose visible content qualifies—for example, an event page for an actual event or a recipe page for a recipe. Google changes its supported features and requirements, so check the [current feature gallery](https://developers.google.com/search/docs/appearance/structured-data/search-gallery) before implementing one.

### Generate Structured Data at Build Time

Google can process JSON-LD added by JavaScript, but the markup must be present in the rendered page and match its visible content; rendering can also add processing delay. Bascik's [build scripts](/scripts/build) are a natural fit for generating JSON-LD from data files at build time, with no browser JavaScript required. Verify the built HTML contains the intended data. See Google's guidance for [generating structured data with JavaScript](https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript).

> **Validate before shipping.** Use [Google's Rich Results Test](https://search.google.com/test/rich-results) to check markup for Google-supported rich results, then inspect the deployed pages in Search Console. Passing a test does not guarantee that Google will show a rich result. Use [Schema.org](https://schema.org) for the broader vocabulary; not every Schema.org type has a Google search appearance.

## Ranking and Publisher Features

Google uses many systems and signals to rank results. A title, sitemap, structured data, site name, or exact-match domain cannot guarantee that a page ranks first or outranks another site. Focus on useful, original pages that clearly explain what your site offers, make the brand and page purpose obvious, and connect related pages with descriptive links. Use Search Console to monitor which queries bring impressions and clicks, then improve pages for the people those queries represent. See Google's [guide to ranking systems](https://developers.google.com/search/docs/appearance/ranking-systems-guide).

[Preferred Sources](https://developers.google.com/search/docs/appearance/preferred-sources) is a separate publication feature for eligible news sources and certain Search experiences. It is not a setting for ordinary site owners to control general rankings or sitelinks. Consider it only if your site is a qualifying publication and the feature is relevant to your content.

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
