# From Astro

Astro and Bascik both compile component-based markup into HTML that ships no framework runtime by default. The key conceptual difference lies in authoring: Astro uses custom `.astro` templates with JS frontmatter and an islands architecture for client hydration, whereas Bascik uses standard vanilla HTML files resolved by custom tag name, running build scripts in Node.js and scoping vanilla JavaScript and CSS automatically.

## Which Astro Version This Guide Assumes

This guide was checked against Astro 5, 6, and 7 on October 26, 2026, when the newest release was Astro 7.4.2 (October 21, 2026), which requires Node.js 22.23.4 or newer. The Astro examples use the Content Layer API that Astro 5 introduced and that Astro 6 and 7 keep: `post.id`, `render(post)` imported from `astro:content`, and a `loader` per collection in `src/content.config.ts`. Props, slots, named slots, and scoped `<style>` have not changed across these majors, so those sections apply to any of them.

A project on an older version writes some of the "before" code differently. These are the forms that matter when converting:

| Feature           | Astro 4 and earlier                | Astro 5 and later                                                                                                                             |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection entry  | `post.slug`, `await post.render()` | `post.id`, `await render(post)` (the old form sits behind `legacy.collections` in 5 and only behind `legacy.collectionsBackwardsCompat` in 6) |
| Collection config | `src/content/config.ts`            | `src/content.config.ts` with a `loader` per collection                                                                                        |
| Listing files     | `Astro.glob()`                     | `getCollection()` or `import.meta.glob()` (`Astro.glob()` is deprecated in 5 and removed in 6)                                                |
| Client router     | `<ViewTransitions />`              | `<ClientRouter />` (the old name is removed in 6)                                                                                             |
| Output mode       | `output: 'hybrid'`                 | `output: 'static'` with `export const prerender = false` on individual routes                                                                 |
| Environment       | `import.meta.env`                  | `import.meta.env` or the typed `astro:env` modules                                                                                            |

Astro 7 changed the toolchain more than the API: its Rust compiler rejects unclosed tags and no longer corrects invalid nesting, `compressHTML` defaults to `'jsx'`, and the Sätteri processor renders Markdown and MDX without remark or rehype plugins. The scoped styles and MDX sections below say what each of those means for the files you convert. Astro's own upgrade guides for [v5](https://docs.astro.build/en/guides/upgrade-to/v5/), [v6](https://docs.astro.build/en/guides/upgrade-to/v6/), and [v7](https://docs.astro.build/en/guides/upgrade-to/v7/) list every change in full.

## Mental Model Comparison

| Concept                | Astro                                         | Bascik                                                                   |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Component format       | `.astro` file with frontmatter (`---`)        | Vanilla `.html` file in `src/components/`                                |
| Style scoping          | `<style>` block in `.astro`                   | Paired `.css` file or inline `<style>`                                   |
| Build-time logic       | Component frontmatter                         | `<script data-bascik-build>` block                                       |
| Content passing        | `<slot />` / `<slot name="…" />`              | `data-bascik-slot` / `data-bascik-slot="name"`                           |
| Component props        | `Astro.props`                                 | `data-bascik-prop-*` and `data-bascik-attr-*`                            |
| Environment variables  | `import.meta.env` / `astro:env`               | `process.env` in build scripts                                           |
| Request-time rendering | Server islands, Actions, and on-demand routes | `<script data-bascik-server>`, `<script data-bascik-stream>`, `src/api/` |
| Client interactivity   | `client:*` directives + UI framework island   | Vanilla JS in `<script>` tags (auto-scoped)                              |

## A Low-Risk First Step

Convert a single UI component, such as a card or navigation bar, to Bascik's HTML format:

1. Create a project with `npm create bascik@rc my-site`, or add Bascik to an existing folder with `npm install @bascik/bascik`.
2. Create `src/components/site-nav/site-nav.html` with your navigation markup.
3. Move any scoped styles into `src/components/site-nav/site-nav.css`.
4. Include `<site-nav></site-nav>` inside `src/pages/index.html`.
5. Run `npm run dev` to view the rendered page.

## .astro Files → .html Component Files

Rename the file from `ComponentName.astro` to the hyphenated tag name `component-name.html` and give it its own directory under `src/components/`, so `SiteNav.astro` becomes `src/components/site-nav/site-nav.html`. Remove the frontmatter fences (`---`) and convert the template HTML. The Bascik component file contains only the HTML markup of the component, and the tag name is the file name.

```text
Before (Astro)              After (Bascik)
src/                        src/components/
  components/                 site-nav/
    SiteNav.astro               site-nav.html
    Card.astro                  site-nav.css  ← was <style> in .astro
  pages/                      card/
    index.astro                 card.html
    about.astro                 card.css
                            src/pages/
                              index.html
                              about.html
```

## Frontmatter → `<script data-bascik-build>`

Astro's frontmatter block (`---`) runs on the server at build time. The direct equivalent in Bascik is `<script data-bascik-build>`. The script runs as a Node.js ESM module at build time, exporting a callable default function whose returned HTML replaces the tag in the page. Top-level `import` and top-level `await` are supported at module scope.

```astro
<!-- src/pages/blog.astro (Astro - before) -->
---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---

<ul>
  {posts.map(post => (
    <li><a href={`/blog/${post.id}`}>{post.data.title}</a></li>
  ))}
</ul>
```

```html
<!-- src/pages/blog/index.html (Bascik - after) -->
<ul>
  <script data-bascik-build>
    import { readdir, readFile } from "node:fs/promises";
    import matter from "gray-matter";

    const escape = (s) =>
      String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;");

    export default async function () {
      const files = (await readdir("./content/blog")).filter((f) =>
        f.endsWith(".md"),
      );
      const items = await Promise.all(
        files.map(async (f) => {
          const { data } = matter(
            await readFile(`./content/blog/${f}`, "utf8"),
          );
          const slug = f.replace(/\.md$/, "");
          return `<li><a href="/blog/${slug}/">${escape(data.title)}</a></li>`;
        }),
      );
      return items.join("\n");
    }
  </script>
</ul>
```

`gray-matter` is a normal npm dependency: install it with `npm install gray-matter`. Build scripts print HTML as text, so escape every value that comes from content before you interpolate it.

> **No Astro content helpers:** Bascik has no equivalent of `getCollection`, `astro:content`, or the `loader` and schema in `src/content.config.ts` (`src/content/config.ts` before Astro 5). Read Markdown files directly with Node.js `fs`, parse front matter with `gray-matter`, and validate it yourself. The `z.object({ … })` schema from `content.config.ts` can move as-is into a shared helper under `src/lib/` that imports `z` from the `zod` package; Astro 6 and later use Zod 4 (`import { z } from 'astro/zod'`) and Astro 5 uses Zod 3, so install the matching major. Frontmatter that listed files with `Astro.glob()` (deprecated in Astro 5, removed in 6) or `import.meta.glob()` becomes the same `readdir` call.

## Astro.props → data-bascik-prop-*

Astro's typed `Astro.props` becomes Bascik's `data-bascik-prop-*` attribute system. Add the attribute (with no value) on the receiver element inside the component, then supply the text value on the component tag at the usage site.

```astro
<!-- src/components/Card.astro (Astro - before) -->
---
interface Props {
  title: string;
  description: string;
}
const { title, description } = Astro.props;
---

<div class="card">
  <h3>{title}</h3>
  <p>{description}</p>
</div>

<!-- Usage -->
<Card title="Getting Started" description="Up and running in minutes." />
```

```html
<!-- src/components/my-card/my-card.html (Bascik - after) -->
<div class="card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-description></p>
</div>

<!-- Usage -->
<my-card
  data-bascik-prop-title="Getting Started"
  data-bascik-prop-description="Up and running in minutes."
></my-card>
```

> **Text only:** Bascik props accept plain text strings. Passing JSX, objects, arrays, or HTML content as a prop has no equivalent, use a slot for rich HTML content instead.
> See [Slots](/slots) for how fallback content behaves.

## `<slot />` → data-bascik-slot

Astro's default `<slot />` maps to a Bascik element with the `data-bascik-slot` attribute. Fallback content goes inside that element, equivalent to Astro's `<slot>Fallback</slot>`.

```astro
<!-- src/components/Section.astro (Astro - before) -->
<section class="section">
  <slot />
</section>

<!-- Usage -->
<Section><p>Section content.</p></Section>
```

```html
<!-- src/components/my-section/my-section.html (Bascik - after) -->
<section class="section">
  <div data-bascik-slot></div>
</section>

<!-- Usage -->
<my-section><p>Section content.</p></my-section>
```

## Named Slots → data-bascik-slot="name"

Astro's `<slot name="header" />` maps to a receiver element with `data-bascik-slot="header"` inside the component. Pass content from the usage site by adding `data-bascik-slot="header"` on the element you want to inject.

```astro
<!-- src/components/PageLayout.astro (Astro - before) -->
<div class="layout">
  <header><slot name="header" /></header>
  <main><slot /></main>
  <footer><slot name="footer" /></footer>
</div>

<!-- Usage -->
<PageLayout>
  <h1 slot="header">Page Title</h1>
  <p>Main content.</p>
  <p slot="footer">© 2026 Acme</p>
</PageLayout>
```

```html
<!-- src/components/page-layout/page-layout.html (Bascik - after) -->
<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
  <footer><div data-bascik-slot="footer"></div></footer>
</div>

<!-- Usage -->
<page-layout>
  <p>Main content.</p>
  <div data-bascik-slot="header"><h1>Page Title</h1></div>
  <div data-bascik-slot="footer"><p>© 2026 Acme</p></div>
</page-layout>
```

## Astro Scoped `<style>` → Paired .css Files

Astro scopes `<style>` blocks inside `.astro` files to that component. Bascik's equivalent is a paired `.css` file in the same directory as the component HTML. Remove the `<style>` block from the component file and paste its contents into the `.css` file. Class names, element selectors (including descendant chains such as `nav a` and `ul li *`), and `@keyframes` are scoped automatically at build time, and selectors that only target markup in the same component need no changes. The exception is markup that belongs to another component, covered below.

```astro
<!-- SiteNav.astro (Astro - before) -->
<nav class="nav">
  <a href="/" class="logo">Acme</a>
</nav>

<style>
  .nav { display: flex; gap: 16px; }
  .logo { font-weight: bold; }
</style>
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <a href="/" class="logo">Acme</a>
</nav>
```

```css
/* src/components/site-nav/site-nav.css */
.nav {
  display: flex;
  gap: 16px;
}
.logo {
  font-weight: bold;
}
```

One difference: in Astro a parent's selector such as `nav a { }` can also style the root element of a child component placed inside that `nav`. In Bascik it cannot, because each component's CSS applies only to markup written in its own template. Put a class on the child's usage tag and define it in the parent's CSS instead. See [Styling a Child Component from Its Parent](/attribute-inheritance#styling-a-child-component-from-its-parent).

> **Coming from Astro 7:** Astro 7's Rust compiler requires every non-void element to have a closing tag and passes invalid nesting through uncorrected, so templates that compile there are already well-formed HTML. Bascik is more lenient: an unclosed component tag is treated as self-closing, and unclosed standard HTML passes through for the browser to handle (see the [FAQ](/faq)). Astro 7 also defaults `compressHTML` to `'jsx'`, which strips whitespace between inline elements, so templates written for it may carry `{" "}` to keep a space. Replace each one with a real space: the component file is plain HTML, and a space between inline elements is a space.

### Build Script Output

Markup that a component's build script prints is scoped like the rest of the template, including markup returned by an imported helper. So a helper in `src/lib/` can print a post card, and the component's `.card` and `h2 a` rules still match it. Classes the component's own stylesheet does not define are never scoped, so a global stylesheet listed in `assets.inlineStyles` can always style them.

## Content Collections → Dynamic Routes

Astro's Content Collections provide a typed, validated interface to Markdown and MDX files. In Bascik, read the same source files directly from the filesystem in a build script using Node.js `fs` and a Markdown/front-matter parser, and generate one page per entry with a [dynamic route](/dynamic-routes).

```astro
<!-- src/pages/blog/[slug].astro (Astro 5 and later - before) -->
---
import { getCollection, render } from 'astro:content';

export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts.map(post => ({ params: { slug: post.id }, props: { post } }));
}

const { post } = Astro.props;
const { Content } = await render(post);
---
<h1>{post.data.title}</h1>
<Content />
```

> **Astro 4 and earlier:** the same page read `post.slug` and called `await post.render()` on the entry. Astro 5 kept that form working only behind the `legacy.collections` flag, and Astro 6 removed that flag, leaving the narrower `legacy.collectionsBackwardsCompat` migration helper as the only way to run it, so a project still written that way is on the pre-Content-Layer API whichever major it runs. The Bascik side below is the same either way, because both `post.slug` and `post.id` come from the file name.

In Bascik, the same job is one template file. `src/pages/blog/[slug]/index.html` lists the slugs in a `<script data-bascik-routes>` block, and each generated page reads its slug from `BASCIK_ROUTE`. The directory form produces trailing-slash URLs such as `/blog/first-post/`, matching Astro; `src/pages/blog/[slug].html` would produce `/blog/first-post.html` instead.

```html
<!-- src/pages/blog/[slug]/index.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <script data-bascik-routes>
      import { getPosts } from "@/lib/posts.ts";

      export default async function () {
        const posts = await getPosts();
        return posts.map((post) => ({ params: { slug: post.id } }));
      }
    </script>
    <script data-bascik-build>
      import { getPost } from "@/lib/posts.ts";
      import { escapeHtml } from "@/lib/site.ts";

      export default async function () {
        const { params } = JSON.parse(process.env.BASCIK_ROUTE);
        const { data } = await getPost(params.slug);
        return `<title>${escapeHtml(data.title)}</title>`;
      }
    </script>
  </head>
  <body>
    <site-nav></site-nav>
    <script data-bascik-build>
      import { getPost } from "@/lib/posts.ts";
      import { renderPost } from "@/lib/render.ts";

      export default async function () {
        const { params } = JSON.parse(process.env.BASCIK_ROUTE);
        return renderPost(await getPost(params.slug));
      }
    </script>
    <site-footer />
  </body>
</html>
```

`getPosts`, `getPost`, and `renderPost` are your own helpers in `src/lib/`, imported with the `@/` alias. They read `content/blog/*.md`, validate the front matter, render the Markdown, and escape titles before returning them. Bascik converts every `params` value to a string, as Astro 5's `getStaticPaths()` did; Astro 6 and later reject a numeric id instead, so a `String()` call written for them is harmless here and simply optional. Bascik adds every generated URL to `sitemap.xml`. Do not write generated page files into `src/pages/`.

Because these scripts read `content/`, which Bascik cannot see as an import, exclude them from the build-script cache and watch the folder in development:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik";

export default defineConfig({
  pipeline: { watchPaths: ["content/", "src/lib/"] },
  scripts: { cache: { exclude: ["src/pages/blog/**"] } },
});
```

## import.meta.env → process.env

Astro reads environment variables through `import.meta.env`, and since Astro 5 also through the typed `astro:env/client` and `astro:env/server` modules. Inside a `<script data-bascik-build>` block, use standard Node.js `process.env` instead. Values are plain strings with no schema and no coercion, which matches Astro 6 and later, where `import.meta.env` values are inlined and never coerced. Before Astro 6, `import.meta.env` turned `"true"` into a boolean, and an `astro:env` schema still does, so compare with `=== "true"` or call `Number()` yourself. Runtime client-side scripts use `window` or data attributes to access values that were baked in at build time, there is no equivalent of Astro's `import.meta.env.PUBLIC_*` exposure to the browser.

```astro
<!-- Before (Astro frontmatter) -->
---
import { API_URL } from 'astro:env/server'; // Astro 5 and later, typed
const apiUrl = import.meta.env.API_URL; // any version
---
```

```html
<!-- After (Bascik build script) -->
<script data-bascik-build>
  const apiUrl = process.env.API_URL;

  export default async function () {
    const data = await fetch(apiUrl).then((r) => r.json());
    return `<p>${data.message}</p>`;
  }
</script>
```

This fetch runs during the build, so the build machine needs network access to `API_URL`. Bascik itself provides `BASCIK_SITE_URL`, `BASCIK_PAGE_PATH`, `BASCIK_ROUTE`, and `BASCIK_BUILD` to build scripts; see [Environment Variables](/environment-variables). `BASCIK_SITE_URL` is the counterpart of `import.meta.env.SITE`, which Astro 6 recommends over `Astro.site` inside `getStaticPaths()`, and it is available to `data-bascik-routes` scripts as well.

## MDX → Markdown with Component Tags

Astro supports `.mdx` files with embedded component usage. Bascik has no native MDX support, but Markdown parsers such as `marked` pass raw HTML through, and Bascik expands any component tag that a build script prints. So rename the file to `.md`, delete the `import` lines, and write the component as its tag, in the same place in the text.

<!-- prettier-ignore -->
```mdx
<!-- src/content/blog/intro.mdx (Astro - before) -->
---
title: Introduction
---

import CodeExample from '../components/CodeExample.astro';

Welcome to our docs.

<CodeExample lang="js" code="console.log('hello')" />

## Next steps
```

<!-- prettier-ignore -->
```md
<!-- content/blog/intro.md (Bascik - after) -->
---
title: Introduction
---

Welcome to our docs.

<code-example data-bascik-prop-lang="js" data-bascik-prop-code="console.log('hello')"></code-example>

## Next steps
```

The post page renders this Markdown in a build script, as in the dynamic route above. The `<code-example>` tag stays between the two paragraphs and is expanded into the component in the next pass. Props are text only, so JavaScript expressions in MDX props become literal strings. Client behavior is plain HTML and JavaScript in the component; there is no hydration step and no equivalent of `client:*` directives.

Your Markdown pipeline moves with the files, and which pipeline that is depends on the Astro version. Before Astro 7, `.md` and `.mdx` went through remark and rehype, and any `remarkPlugins` or `rehypePlugins` from `astro.config.mjs` run unchanged in a Bascik build script with `unified` (see [Markdown](/how-to/markdown)). Astro 6.4 moved those options under `markdown.processor: unified({ … })`, and Astro 7 made the Rust-based Sätteri processor the default, which runs no remark or rehype plugins; any `mdastPlugins` or `hastPlugins` a site passed to `satteri({ … })` need a `unified` or `marked` equivalent instead. Two details to compare in the rendered output: Astro highlights code blocks with Shiki, and Astro 6 stopped stripping trailing hyphens from heading ids, so choose a highlighter and a slugger that produce the anchors your existing links expect.

## What Has No Built-In Equivalent

These Astro integrations are not part of Bascik:

| Astro                                                                       | Bascik replacement                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@astrojs/rss`                                                              | A `pipeline.exec` script with `phase: 'post'` that writes `rss.xml` to the output directory, using a feed library such as `feed`                                                                                                                                                                                  |
| `@astrojs/sitemap`                                                          | Built in. `sitemap.xml` and `robots.txt` are generated by `bascik --build` when a site URL is set. See [Sitemap & robots.txt](/sitemap)                                                                                                                                                                           |
| `astro:assets` image optimization                                           | None. Ship images at the sizes you authored, with `width` and `height`, or resize them in your own exec script                                                                                                                                                                                                    |
| Shiki syntax highlighting                                                   | None. Highlight in your Markdown render step with a library such as `prismjs` or `shiki` itself                                                                                                                                                                                                                   |
| `<Font />` and fallback metrics (experimental in Astro 5.7, stable since 6) | None. Declare `@font-face` in a global stylesheet and preload the files yourself                                                                                                                                                                                                                                  |
| `security.csp` (stable since Astro 6)                                       | `generate.cspHashes: true` writes the SHA-256 hashes of each page's inline scripts and styles to `.bascik/dist/csp-hashes.json`; the policy itself is yours to serve. See [Content Security Policy](/how-to/content-security-policy)                                                                              |
| `<ClientRouter />` (`<ViewTransitions />` before Astro 5)                   | None. Navigation is an ordinary page load; `@view-transition { navigation: auto; }` in a global stylesheet gives cross-document transitions in browsers that support them. See [Interactivity](/how-to/interactivity)                                                                                             |
| Server islands (`server:defer`)                                             | [Stream scripts](/stream-scripts) flush the page shell first and stream the slow part into place, on the production server or a serverless adapter rather than in a static build                                                                                                                                  |
| Actions, Sessions, middleware, live content collections, route caching      | Features that need on-demand rendering through an adapter, except middleware, which also runs at build time for prerendered pages. Form handlers map to [API Routes](/api-routes) in `src/api/` and per-request markup to [Server Scripts](/server-scripts); sessions, middleware, and caching have no equivalent |
| `@astrojs/cloudflare`                                                       | [`@bascik/adapter-cloudflare`](/deployment/cloudflare) serves the static build from the CDN and runs server scripts, stream scripts, and API routes in a generated Worker                                                                                                                                         |
| `@astrojs/db` (removed in Astro 7)                                          | A build script or API route can use `node:sqlite`, Drizzle ORM, or any database library directly, the same replacements Astro's v7 guide suggests                                                                                                                                                                 |
| `Astro.url` for canonical and active links                                  | `BASCIK_PAGE_PATH` and `BASCIK_SITE_URL`, read in a [build script with page context](/how-to/page-aware-scripts)                                                                                                                                                                                                  |
