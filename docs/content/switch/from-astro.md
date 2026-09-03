# From Astro

Astro and Bascik are both build-time component systems that output zero-JS HTML by default. The concepts translate closely: `.astro` files become `.html` component files, frontmatter code blocks become `<script data-bascik-build>` tags, `Astro.props` becomes `data-bascik-prop-*` attributes, and Astro's `<slot />` becomes Bascik's `data-bascik-slot` attribute.

## .astro Files → .html Component Files

Rename the file from `ComponentName.astro` to the hyphenated tag name `component-name.html`. Move it to `src/components/`. Remove the frontmatter fences (`---`) and convert the template HTML, the Bascik component file contains only the HTML markup of the component.

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

Astro's frontmatter block (`---`) runs on the server at build time. The direct equivalent in Bascik is `<script data-bascik-build>`. The script runs as a Node.js ESM module at build time; its stdout is injected into the page in place of the tag. Top-level `import` and top-level `await` are supported.

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
<!-- src/pages/blog.html (Bascik - after) -->
<ul>
  <script data-bascik-build>
    import { readdir, readFile } from 'node:fs/promises';
    import matter from 'gray-matter';
    const files = (await readdir('./content/blog')).filter(f => f.endsWith('.md'));
    const items = await Promise.all(files.map(async f => {
      const { data } = matter(await readFile(`./content/blog/${f}`, 'utf8'));
      const slug = f.replace('.md', '');
      return `<li><a href="/blog/${slug}">${data.title}</a></li>`;
    }));
    console.log(items.join('\n'));
  </script>
</ul>
```

> **No Astro content helpers:** Bascik has no equivalent of `getCollection` or `astro:content`. Read Markdown files directly with Node.js `fs` and a Markdown parser such as `marked` or `gray-matter`.

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

Astro scopes `<style>` blocks inside `.astro` files to that component. Bascik's equivalent is a paired `.css` file in the same directory as the component HTML. Remove the `<style>` block from the component file and paste its contents into the `.css` file. Class names, element selectors, and `@keyframes` are scoped automatically at build time with no changes to selectors needed.

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
.nav { display: flex; gap: 16px; }
.logo { font-weight: bold; }
```

## Content Collections → `<script data-bascik-build>`

Astro's Content Collections provide a typed, validated interface to Markdown and MDX files. In Bascik, read the same source files directly from the filesystem in a build script using Node.js `fs` and a Markdown/front-matter parser.

```astro
<!-- src/pages/blog/[slug].astro (Astro - before) -->
---
import { getCollection, getEntry } from 'astro:content';

export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts.map(post => ({ params: { slug: post.slug }, props: { post } }));
}

const { post } = Astro.props;
const { Content } = await post.render();
---
<h1>{post.data.title}</h1>
<Content />
```

In Bascik, generate one page file per slug before running the build:

```js
// scripts/generate-blog.js
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import matter from 'gray-matter';
import { marked } from 'marked';

await mkdir('./src/pages/blog', { recursive: true });
const files = (await readdir('./content/blog')).filter(f => f.endsWith('.md'));

for (const file of files) {
  const raw = await readFile(`./content/blog/${file}`, 'utf8');
  const { data, content } = matter(raw);
  const slug = file.replace('.md', '');
  const body = marked(content);

  await writeFile(`./src/pages/blog/${slug}.html`, `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${data.title}</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <site-nav></site-nav>
  <main class="prose">
    <h1>${data.title}</h1>
    ${body}
  </main>
  <site-footer></site-footer>
</body>
</html>`);
}
```

```json
{
  "scripts": {
    "generate": "node scripts/generate-blog.js",
    "dev": "npm run generate && bascik",
    "build": "npm run generate && bascik --build"
  }
}
```

## import.meta.env → process.env

Astro uses `import.meta.env` for environment variables. Inside a `<script data-bascik-build>` block, use standard Node.js `process.env` instead. Runtime client-side scripts use `window` or data attributes to access values that were baked in at build time, there is no equivalent of Astro's `import.meta.env.PUBLIC_*` exposure to the browser.

```astro
<!-- Before (Astro frontmatter) -->
---
const apiUrl = import.meta.env.API_URL;
---
```

```html
<!-- After (Bascik build script) -->
<script data-bascik-build>
  const apiUrl = process.env.API_URL;
  const data = await fetch(apiUrl).then(r => r.json());
  console.log(`<p>${data.message}</p>`);
</script>
```

## MDX → HTML Component + Build Script

Astro supports `.mdx` files as pages with embedded component usage. Bascik has no native MDX support. Convert MDX pages by processing the Markdown content with a build script and adding any interactive sections as plain Bascik components around the generated HTML.

```mdx
<!-- src/content/blog/intro.mdx (Astro - before) -->
---
title: Introduction
---

import CodeExample from '../components/CodeExample.astro';

# Introduction

Welcome to our docs.

<CodeExample lang="js" code="console.log('hello')" />
```

```html
<!-- src/pages/blog/intro.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Introduction</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <site-nav></site-nav>
  <main class="prose">
    <script data-bascik-build>
      import { readFile } from 'node:fs/promises';
      import { marked } from 'marked';
      const md = await readFile('./content/blog/intro.md', 'utf8');
      console.log(marked(md));
    </script>
    <code-example
      data-bascik-prop-lang="js"
      data-bascik-prop-code="console.log('hello')"
    ></code-example>
  </main>
  <site-footer></site-footer>
</body>
</html>
```

The Markdown prose is rendered at build time by the build script and injected as HTML. Bascik component tags that follow (or are output by the build script) are then expanded in the next pass.
