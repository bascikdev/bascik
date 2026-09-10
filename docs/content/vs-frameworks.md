# Bascik vs Frameworks

Bascik is not a framework. It is a build tool that resolves components at compile time and then disappears. Understanding how that differs from popular lightweight frameworks helps you pick the right tool, and shows how they can work together.

## What Bascik Does

Bascik solves one problem: component reuse at build time. Write a navigation bar once, use it on every page, and get clean HTML out. That is the entire scope.

Everything else, interactivity, server communication, reactive state, is your decision. You can ship zero JavaScript, or you can add as much as the project needs. Bascik does not have an opinion.

The custom component tags in a Bascik project are the ones **you create**. If you create `site-nav.html`, you can write `<site-nav>`. Bascik does not add a catalog of framework components with their own behavior or API.

Bascik does use a small set of build instructions such as `data-bascik-slot`, `data-bascik-prop-*`, and `data-bascik-build`. They use HTML's standard `data-*` extension mechanism to keep Bascik source valid HTML. Bascik consumes them during the build; they are not runtime directives that require browser JavaScript to interpret.

## HTMX and Alpine.js

[HTMX](https://htmx.org) (~14 KB) and [Alpine.js](https://alpinejs.dev) (~16 KB) both take an attribute-based approach to adding behavior to HTML. HTMX focuses on server-driven partial updates: you add attributes like `hx-get`, `hx-post`, `hx-target`, and `hx-swap`, and HTMX intercepts events, fires requests to your server, and swaps portions of the page with the response. Alpine focuses on client-side interactivity: `x-data` defines state, and directives like `x-bind`, `x-show`, and `@click` wire that state to the DOM.

Both are compatible with Bascik. Bascik resolves components at build time and produces vanilla HTML; HTMX and Alpine run in the browser on whatever Bascik produced. There is no conflict, and no coordination required between them.

```html
<!-- HTMX and Alpine attributes work inside Bascik components without modification -->
<button hx-get="/api/items" hx-target="#list" hx-swap="innerHTML">
  Load items
</button>

<div x-data="{ open: false }">
  <button @click="open = !open">Toggle</button>
  <p x-show="open">Visible when open is true</p>
</div>
```

## Vue and React

Full-featured frameworks like Vue and React solve a different problem: client-side applications with complex reactive state, component trees, and client-side routing. They ship a significant JavaScript runtime (~40–100+ KB), require a bundler, and introduce a complete component model with lifecycle hooks, reactivity systems, and state management conventions.

For documents, marketing sites, docs portals, blogs, portfolios, most of that machinery is unused. The framework runtime loads and runs on every page visit in exchange for features the page does not use.

Bascik's component model lives entirely at build time. There is no runtime equivalent. A `<site-nav>` tag in source becomes a `<nav>` element in output, no JavaScript involved.

## Svelte

[Svelte](https://svelte.dev) is the framework whose single-file component format looks most like Bascik's. A `.svelte` file is `<script>` + markup + `<style>`, scoped styles are the default, and the compiler strips the framework syntax. The resemblance stops at the output.

Svelte compiles to a JavaScript runtime that manages reactive state and DOM updates in the browser. Every page needs that compiled output to function. A page with reactive state ships JS for the reactivity system plus JS for the application logic itself.

Bascik's output for an equivalent component is a static HTML file with no JavaScript added. There is nothing to hydrate, no reactive tree to initialize, no framework-managed DOM.

**What Svelte adds to a page:**

- A compiled JavaScript bundle per component (size varies; runtime helpers are shared across the app)
- A reactivity model (`$state`, `$derived`, `$effect`) that requires JavaScript to function
- Template syntax (`{#if}`, `{#each}`, `{@html}`) that resolves to JavaScript, not vanilla HTML

For content sites and documentation portals, the closest Svelte analog is SvelteKit in static-output mode (`adapter-static`). Even then, SvelteKit ships JavaScript for client-side navigation and hydration. Bascik's output for equivalent pages is vanilla HTML with none of that overhead.

## Next.js

Next.js is a React meta-framework that adds routing, server-side rendering, static site generation, and a full bundling pipeline on top of React. It is a powerful and complete system, and most of that power is aimed at applications with complex client-side state, authentication, API routes, and real-time data.

Many teams reach for Next.js on content sites, landing pages, and documentation portals because it is familiar and well-supported. The tradeoff is that every page ships 80+ KB or more of React runtime regardless of whether the page uses any client-side reactivity. Its conventions also gradually pull projects toward client-side patterns even for pages that were always static, and auditing what actually reaches the browser gets harder over time.

For a lot of what people build, that is simply more framework than the project needs. Bascik is built for exactly this kind of work. You write vanilla HTML, CSS, and JavaScript. Components are reused at build time. The output is a dist folder of static files you can open and verify file by file. There is no runtime to load, nothing to hydrate, letting you write the standard HTML, CSS, and JavaScript you already know. Google's Core Web Vitals (LCP, INP, CLS) are directly affected by JavaScript that blocks rendering; Bascik's output has none of that overhead.

**What Bascik offers for these projects:**

- Plain HTML, CSS, and JS authoring with component reuse. No JSX, no hooks, no framework model to adopt.
- Build output you can open, read, and verify file by file.
- Static pages that score well on Core Web Vitals without any optimization work.

## Static Site Builders: Hugo, Eleventy, Jekyll

Traditional static site builders such as [Hugo](https://gohugo.io), [Eleventy](https://www.11ty.dev), and [Jekyll](https://jekyllrb.com) focus on content pipelines: Markdown collections, templates, front matter, taxonomies, and data-driven page generation.

Bascik overlaps with them at the output level, all of these tools can ship plain static HTML, but the authoring model is different. Bascik stays close to hand-written HTML pages and reusable HTML components. It does not require a separate template language, collection system, or front matter format just to reuse a header, card, or footer.

## The Key Difference

| Tool | Runtime shipped | Component model or APIs required | Attribute / source syntax | Requires server |
| --- | ---: | --- | --- | --- |
| **Bascik** | None | Only the components you create, plus slots and props | Standards-valid `data-bascik-*` attributes, consumed at build time | No |
| **Next.js** | 80–100+ KB (React + hydration) | React component model, routing, and Next.js conventions | JSX, React hooks, Next.js file conventions | No (SSG) / Yes (SSR) |
| **HTMX** | ~14 KB | Request, target, swap, trigger, and history concepts | `hx-*` custom attributes interpreted at runtime | Usually |
| **Alpine.js** | ~16 KB | Alpine state and directive model | `x-*` and `@*` directives interpreted at runtime | No |
| **petite-vue** | ~5 KB | Vue reactivity and directive model | `v-*` and `@*` directives interpreted at runtime | No |
| **Svelte** | Compiled JS bundle (varies) | Svelte component model and reactivity (`$state`, `$effect`) | `.svelte` file format with compiler-resolved directives | No |
| **Vue / React** | 40–100+ KB | Framework component model, lifecycle, and state APIs | Vue directives/templates or React JSX | No |
| **Hugo / Eleventy / Jekyll** | None | Template syntax, content collections, front matter, generator conventions | Builder-specific templating languages | No |

The browser can parse Bascik's source without needing to understand a new runtime language: custom tags are valid custom-element-shaped HTML names, and build instructions use the web platform's `data-*` convention. Bascik resolves both before deployment. By contrast, runtime directives such as `hx-get`, `x-data`, and `v-scope` only gain behavior after their library's JavaScript loads.

## Dynamic Edge Deployments

Modern frameworks like Next.js, Astro, and SvelteKit often provide adapters for edge serverless platforms like Cloudflare Pages or Workers. They achieve dynamic behavior by packaging serverless functions alongside static assets.

Bascik supports this same unified edge deployment model via deployment adapters (such as `@bascik/adapter-cloudflare` or [custom adapters](/deployment/custom-adapters)). Running `bascik --build --target cloudflare-pages` partitions your application into:

1. **CDN static assets:** pure static HTML pages, CSS, and client-side assets served directly by Cloudflare's edge cache with zero compute invocation;
2. **Edge worker scripts:** pages containing `<script data-bascik-server>` or `<script data-bascik-stream>` compile their HTML templates and request-time code directly into a single worker bundle that executes at the edge.

The crucial difference lies in the client footprint. Frameworks like Next.js or SvelteKit require client-side runtimes to hydrate components, manage routing, and handle DOM reconciliations. Bascik streams clean, final HTML from the edge worker directly to the browser. Visitors receive live dynamic data and progressive rendering with zero client hydration overhead.

Most of what people build, content sites, marketing pages, docs portals, company blogs, landing pages, does not require a framework runtime in the browser. Knowing what each tool is optimized for is the best basis for choosing. Bascik fills the gap they leave open: component reuse and predictable build output, without a runtime or a new programming model to adopt. You write vanilla HTML, CSS, and JavaScript, get the organizational benefits you would expect from a framework, and ship a dist folder you can fully audit. For the parts of a project that do need client-side behavior, Bascik composes cleanly with HTMX or Alpine.

> **Combining tools.** A common pattern is Bascik for layout components (nav, footer, hero sections) and HTMX or Alpine for specific interactive elements. Each tool does what it is best at, and neither one intrudes on the other's domain.
