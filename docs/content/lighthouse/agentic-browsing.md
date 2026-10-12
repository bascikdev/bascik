# Agentic Browsing

Lighthouse 13.3 introduced an **Agentic Browsing** category that audits how well a site supports AI agents and automated browsers. It is experimental and based on proposed standards, and it needs Chrome 150 or later. Unlike the other categories it has no weighted 0 to 100 score. The report shows a pass ratio and per-audit pass, warning, or fail status instead.

The audits fall into three groups: agent-centric accessibility, stability and discoverability, and WebMCP. A Bascik site passes the first two by default and chooses whether to opt in to the third.

## What Bascik Passes by Default

**Accessibility tree is well-formed.** AI agents navigate pages through the accessibility tree, the same structure that screen readers use. Lighthouse checks that interactive elements have programmatic names and labels, that roles and parent-child relationships are valid, and that interactive content is not hidden from the tree. Bascik outputs real, semantic HTML (`<nav>`, `<main>`, `<header>`, `<footer>`, labeled `<button>` elements, `<img alt="">`), so the accessibility tree is correct without any extra effort. The same fixes that improve [Accessibility](/lighthouse/accessibility) improve this audit.

**Cumulative Layout Shift is 0.** When content moves after load, agents that have already built a representation of the page are working from stale coordinates. Because Bascik ships finished HTML with explicit `width` and `height` on every image and no client-side rendering pass, there is nothing left to shift. See [`aspect-ratio` CSS](/lighthouse/performance#aspect-ratio-css-layout-stability-before-images-load) for containers that load content late.

**`llms.txt` follows recommendations.** Lighthouse checks that the `llms.txt` file at the root of a site is a valid Markdown file with at least one H1 heading. See the next section for how to publish one.

> **Bascik sites pass these audits without any configuration.** Correct HTML, zero layout shift, and a well-formed `llms.txt` are natural properties of a statically built site. Frameworks that hydrate on the client introduce layout shift during hydration and often produce an accessibility tree that differs from the initial server-rendered HTML, both of which hurt these audits.

## Publishing `llms.txt`

The [`llms.txt` specification](https://llmstxt.org/) defines a Markdown index at the root of a site that tells LLMs and AI agents what the site contains and where to find the details. A minimal valid file has an H1 title, a short summary, and sections of links:

```md
# Example Site

> One sentence describing what the site is for.

## Docs

- [Getting Started](https://example.com/getting-started): Install and build a first page.
- [Configuration](https://example.com/configuration): Every option, with defaults.
```

Because Bascik copies non-HTML files from `src/pages/` into `dist/`, the simplest approach is to author `src/pages/llms.txt` by hand, the same way you would author a `robots.txt`. For a larger site, generate it from your content instead: an [exec script](/exec-scripts) can read your Markdown or JSON data and write `llms.txt` directly into `dist/` during the build, so it never drifts from your pages. The Bascik documentation site does exactly this, deriving `llms.txt` from the same content Markdown files that drive its pages.

## WebMCP

The remaining audits cover WebMCP, a proposed standard that lets a page expose tools and forms to AI agents explicitly, either declaratively in HTML or imperatively in JavaScript. Lighthouse reports the registered tools, forms that are missing a declarative WebMCP definition, and the validity of tool schemas. WebMCP audits require registering for the WebMCP origin trial, and the standard is still changing.

Bascik does not generate WebMCP definitions. If you adopt WebMCP, write the declarative markup or the registration script like any other vanilla HTML or `<script>` block, and Bascik passes it through to the output. Because tool registration timing can change what Lighthouse captures, register imperative tools early in page load.

> **Lighthouse reference.** [Agentic browsing scoring](https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring) documents each audit and how the category is reported.
