# Markdown

Bascik does not ship a Markdown pipeline, but build-time scripts are Node.js, so any Markdown library works. This page shows common patterns using `marked`, `gray-matter`, `markdown-it`, and the `unified` / `remark` ecosystem.

## See it in action

The same Markdown source appears as vanilla HTML in the preview and compiled output.

## marked

[marked](https://marked.js.org) is a fast, zero-dependency Markdown parser. Install it once and import it in any build script.

```sh
npm install marked
```

Read a Markdown file and output the HTML:

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';

  const md = await readFile('./content/intro.md', 'utf8');
  console.log(marked(md));
</script>
```

The output replaces the script tag in the compiled HTML with no client-side JavaScript runs.

<!-- demo:source-md -->
```md
## A practical heading

Markdown stays comfortable for authors, while the published page stays **vanilla HTML**.

> Add an editorial treatment with ordinary CSS.
```

<!-- demo:output-html -->
```html
<h2>A practical heading</h2>
<p>Markdown stays comfortable for authors, while the published page stays <strong>vanilla HTML</strong>.</p>
<blockquote>
<p>Add an editorial treatment with ordinary CSS.</p>
</blockquote>
```

## Styling Rendered Markdown

A Markdown parser returns ordinary HTML such as `<h2>`, `<p>`, `<ul>`, `<blockquote>`, and `<pre>`. There is no separate Markdown styling system: once Bascik injects that HTML, the browser applies CSS through the normal cascade.

### Option 1: A Page or Global Stylesheet

Wrap the generated content with a stable class and link a regular stylesheet from the page:

```html
<head>
  <link rel="stylesheet" href="/css/content.css" />
</head>
<body>
  <main class="markdown-body">
    <script data-bascik-build>
      import { readFile } from 'node:fs/promises';
      import { marked } from 'marked';

      const md = await readFile('./content/article.md', 'utf8');
      console.log(marked(md));
    </script>
  </main>
</body>
```

Then style the HTML elements the parser emits:

```css
/* src/pages/css/content.css */
.markdown-body {
  max-width: 68ch;
  margin-inline: auto;
  color: #25282d;
  font: 1.05rem/1.75 Georgia, serif;
}

.markdown-body h2 {
  margin-block: 2.5rem 0.75rem;
  font: 700 1.75rem/1.2 system-ui, sans-serif;
}

.markdown-body a {
  color: #086f83;
  text-decoration-thickness: 0.12em;
  text-underline-offset: 0.16em;
}

.markdown-body blockquote {
  margin-inline: 0;
  padding: 1rem 1.25rem;
  border-left: 4px solid #d7b329;
  background: #fff9df;
}

.markdown-body pre {
  overflow-x: auto;
  padding: 1rem;
  color: #f7f7f2;
  background: #202329;
}
```

This is the simplest choice when several pages share one editorial design. The generated elements are vanilla HTML, so responsive styles, custom properties, print styles, and media queries all work normally.

### Option 2: A Scoped Bascik Component

For a portable content style, create a component whose default slot receives the generated HTML:

```html
<!-- src/components/markdown-content/markdown-content.html -->
<article class="markdown-content">
  <div data-bascik-slot></div>
</article>
```

Pair it with component CSS. Start selectors with the wrapper class so the rules apply to HTML inserted through the slot:

```css
/* src/components/markdown-content/markdown-content.css */
.markdown-content {
  max-width: 68ch;
  margin-inline: auto;
  color: #25282d;
  font: 1.05rem/1.75 Georgia, serif;
}

.markdown-content h2 {
  margin-block: 2.5rem 0.75rem;
  color: #142c35;
  font: 700 1.75rem/1.2 system-ui, sans-serif;
}

.markdown-content blockquote {
  margin-inline: 0;
  padding: 1rem 1.25rem;
  border-left: 4px solid #d7b329;
  background: #fff9df;
}

.markdown-content img {
  display: block;
  max-width: 100%;
  height: auto;
}
```

Have the build script emit the component tag around the parsed Markdown:

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';

  const md = await readFile('./content/article.md', 'utf8');
  console.log(`<markdown-content>${marked(md)}</markdown-content>`);
</script>
```

Bascik runs the script first, sees the emitted `<markdown-content>` tag, resolves it, fills its slot, and includes its scoped CSS. Only that component's wrapper receives the generated scoped class; selectors such as `.markdown-content h2` then style the ordinary heading descendants inside it.

> **Use a wrapper selector for slot content.** A bare `h2 {}` rule in component CSS is transformed by Bascik and attached to headings present in the component template. Markdown headings arrive through the slot later, so write `.markdown-content h2 {}` for generated content.

### What Reaches the Browser

Given this Markdown:

```md
## A practical heading

Markdown stays comfortable for authors, while the published page stays **vanilla HTML**.

> Content can have a distinct editorial treatment without adding a client runtime.
```

The parser produces normal elements inside the resolved component:

```html
<article class="bascik__markdown-content__markdown-content">
  <h2>A practical heading</h2>
  <p>Markdown stays comfortable for authors, while the published page stays <strong>vanilla HTML</strong>.</p>
  <blockquote>
    <p>Content can have a distinct editorial treatment without adding a client runtime.</p>
  </blockquote>
</article>
```

The generated class name may be shortened in production when identifier minification is enabled. You continue writing `.markdown-content` in the source; Bascik keeps the HTML and CSS names synchronized.

## Front Matter with gray-matter

Most content workflows attach metadata (title, date, author, tags) to Markdown files using YAML front matter. [gray-matter](https://github.com/jonschlinkert/gray-matter) parses it out cleanly.

```sh
npm install gray-matter marked
```

```md
---
title: My First Post
date: 2026-07-05
tags: [css, performance]
---

This is the post body.
```

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';
  import matter from 'gray-matter';

  const raw = await readFile('./content/post.md', 'utf8');
  const { data, content } = matter(raw);

  console.log(`
    <article>
      <h1>${data.title}</h1>
      <time datetime="${data.date}">${new Date(data.date).toLocaleDateString('en-US', { dateStyle: 'long' })}</time>
      ${marked(content)}
    </article>
  `);
</script>
```

## Building a Content Collection

Read an entire folder of Markdown files and generate a list or index page:

```html
<script data-bascik-build>
  import { readdir, readFile } from 'node:fs/promises';
  import matter from 'gray-matter';

  const files = (await readdir('./content/posts'))
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // newest first if files are date-prefixed

  const posts = await Promise.all(files.map(async file => {
    const raw = await readFile(`./content/posts/${file}`, 'utf8');
    const { data } = matter(raw);
    const slug = file.replace(/\.md$/, '');
    return { slug, ...data };
  }));

  const items = posts.map(p => `
    <li>
      <a href="/posts/${p.slug}">${p.title}</a>
      <time>${p.date}</time>
    </li>
  `).join('\n');

  console.log(`<ul class="post-list">\n${items}\n</ul>`);
</script>
```

> **Tip.** Each post's HTML can live on its own page too. Create `src/pages/posts/[slug].html` as a template, or use a build script to generate static output files programmatically.

## markdown-it

[markdown-it](https://markdown-it.github.io) is an alternative parser with a rich plugin ecosystem, syntax highlighting, footnotes, custom containers, and more.

```sh
npm install markdown-it
```

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import MarkdownIt from 'markdown-it';

  const md = new MarkdownIt({ html: true, typographer: true });
  const source = await readFile('./content/article.md', 'utf8');
  console.log(md.render(source));
</script>
```

Add a plugin for syntax highlighting with [highlight.js](https://highlightjs.org):

```sh
npm install markdown-it highlight.js
```

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import MarkdownIt from 'markdown-it';
  import hljs from 'highlight.js';

  const md = new MarkdownIt({
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return '';
    }
  });

  const source = await readFile('./content/article.md', 'utf8');
  console.log(md.render(source));
</script>
```

Then include the highlight.js stylesheet in your page `<head>`:

```html
<link rel="stylesheet"
  href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" />
```

## remark / unified

The [unified](https://unifiedjs.com) ecosystem provides an AST-based pipeline. It is more involved to set up but gives precise control over parsing, transforming, and serializing Markdown.

```sh
npm install unified remark-parse remark-html
```

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { unified } from 'unified';
  import remarkParse from 'remark-parse';
  import remarkHtml from 'remark-html';

  const md = await readFile('./content/article.md', 'utf8');
  const file = await unified()
    .use(remarkParse)
    .use(remarkHtml)
    .process(md);

  console.log(String(file));
</script>
```

The unified plugin system lets you add transformations like automatic heading IDs, GFM tables, and math rendering using `remark-*` packages.

## CMS-Sourced Markdown

If your content comes from a headless CMS that returns Markdown via an API, fetch it at build time:

```html
<script data-bascik-build>
  import { marked } from 'marked';

  const res = await fetch('https://your-cms.example.com/api/page/home', {
    headers: { Authorization: `Bearer ${process.env.CMS_TOKEN}` }
  });
  const { body } = await res.json();
  console.log(marked(body));
</script>
```

The Markdown is converted to HTML and baked into the static output. No CMS API calls happen in the browser, users see vanilla HTML.
