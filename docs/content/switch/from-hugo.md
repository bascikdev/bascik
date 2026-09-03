# From Hugo

Hugo is a static site generator; Bascik is a build tool for HTML components. Both produce vanilla HTML with no client-side framework runtime. The main conceptual shift is that Hugo uses Go template syntax in `.html` layout files, while Bascik uses vanilla HTML component files composed by tag name. Partials become component files, base template blocks become slot-based layout components, and Go template logic becomes Node.js build scripts.

## Layouts and Partials → HTML Component Files

Hugo organizes templates under `layouts/` with partials in `layouts/partials/`. In Bascik, every reusable piece of markup is a plain `.html` file under `src/components/`, identified by its hyphenated folder name.

```text
Before (Hugo)                After (Bascik)
layouts/                     src/components/
  _default/                    site-nav/
    baseof.html                  site-nav.html
    single.html                site-footer/
    list.html                    site-footer.html
  partials/                    site-layout/
    nav.html                     site-layout.html
    footer.html                  post-card/
  shortcodes/                    post-card.html
    callout.html               src/pages/
content/                         index.html
  posts/                         about.html
    my-post.md                   posts/
static/                            my-post.html
  css/
    main.css
```

## `{{ partial }}` → Bascik Component Tags

A Hugo `{{ partial "nav.html" . }}` call becomes a self-contained Bascik component tag. The hyphenated folder name is the tag name.

```html
<!-- layouts/partials/nav.html (Hugo - before) -->
<nav class="nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/blog">Blog</a>
</nav>

<!-- Used in a layout with: -->
{{ partial "nav.html" . }}
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/blog">Blog</a>
</nav>

<!-- Used in a page with: -->
<site-nav></site-nav>
```

## Base Templates → Slot-based Layout Components

Hugo's `baseof.html` with `{{ block "main" . }}` / `{{ define "main" }}` maps to a Bascik layout component that uses `data-bascik-slot` for the page body. Named blocks become named slots.

```html
<!-- layouts/_default/baseof.html (Hugo - before) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>{{ .Title }} - Acme</title>
  {{ partial "head-extra.html" . }}
</head>
<body>
  {{ partial "nav.html" . }}
  <main>{{ block "main" . }}{{ end }}</main>
  {{ partial "footer.html" . }}
</body>
</html>

<!-- layouts/_default/single.html (Hugo - before) -->
{{ define "main" }}
  <article>
    <h1>{{ .Title }}</h1>
    {{ .Content }}
  </article>
{{ end }}
```

```html
<!-- src/components/site-layout/site-layout.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title data-bascik-prop-title></title>
</head>
<body>
  <site-nav></site-nav>
  <main><div data-bascik-slot></div></main>
  <site-footer></site-footer>
</body>
</html>

<!-- src/pages/posts/my-post.html (Bascik - after) -->
<site-layout data-bascik-prop-title="My Post - Acme">
  <article>
    <h1>My Post</h1>
    <p>Post body goes here.</p>
  </article>
</site-layout>
```

## Template Variables → data-bascik-prop-*

Hugo's `{{ .Title }}` and `{{ .Params.description }}` pull values from front matter at build time. Bascik uses `data-bascik-prop-*` attributes, the value is set on the component tag at the usage site, and the attribute (with no value) marks the receiver element inside the component.

```html
<!-- layouts/partials/post-card.html (Hugo - before) -->
<div class="post-card">
  <h3>{{ .Title }}</h3>
  <p>{{ .Params.description }}</p>
  <a href="{{ .RelPermalink }}">Read more</a>
</div>
```

```html
<!-- src/components/post-card/post-card.html (Bascik - after) -->
<div class="post-card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-description></p>
  <a data-bascik-prop-href>Read more</a>
</div>

<!-- Usage -->
<post-card
  data-bascik-prop-title="My Post"
  data-bascik-prop-description="A short summary."
  data-bascik-prop-href="/posts/my-post"
></post-card>
```

> **Text only:** Bascik props carry plain text strings. For rich HTML content, such as a post body rendered from Markdown, use a slot instead of a prop.

## `{{ range }}` Loops → `<script data-bascik-build>`

Hugo's `{{ range .Pages }}` iterates over content at build time. The Bascik equivalent is a `<script data-bascik-build>` block that reads files with Node.js and prints HTML to stdout.

```html
<!-- layouts/_default/list.html (Hugo - before) -->
{{ define "main" }}
<ul class="post-list">
  {{ range .Pages }}
  <li>
    <a href="{{ .RelPermalink }}">{{ .Title }}</a>
    <span>{{ .Date.Format "2006-01-02" }}</span>
  </li>
  {{ end }}
</ul>
{{ end }}
```

```html
<!-- src/pages/blog.html (Bascik - after) -->
<ul class="post-list">
  <script data-bascik-build>
    import { readdir, readFile } from 'node:fs/promises';
    import matter from 'gray-matter';
    const files = (await readdir('./content/posts')).filter(f => f.endsWith('.md'));
    const posts = await Promise.all(files.map(async f => {
      const { data } = matter(await readFile(`./content/posts/${f}`, 'utf8'));
      const slug = f.replace('.md', '');
      return { slug, title: data.title, date: data.date };
    }));
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    console.log(posts.map(p =>
      `<li><a href="/posts/${p.slug}">${p.title}</a><span>${p.date}</span></li>`
    ).join('\n'));
  </script>
</ul>
```

> **No Hugo data layer:** Bascik has no equivalent of Hugo's data directory or content type system. Read Markdown and JSON files directly with Node.js `fs` and a parser such as `gray-matter`.

## Shortcodes → Components

Hugo shortcodes (`{{< callout >}}text{{< /callout >}}`) are reusable template fragments. In Bascik, they become component files. For shortcodes that wrap content, use `data-bascik-slot`.

```html
<!-- layouts/shortcodes/callout.html (Hugo - before) -->
<div class="callout">{{ .Inner }}</div>

<!-- Used in Markdown with: -->
{{< callout >}}This is a tip.{{< /callout >}}
```

```html
<!-- src/components/my-callout/my-callout.html (Bascik - after) -->
<div class="callout">
  <div data-bascik-slot></div>
</div>

<!-- Used in a page with: -->
<my-callout><p>This is a tip.</p></my-callout>
```

## SCSS / Sass → Plain CSS

Hugo ships a built-in asset pipeline with SCSS/Sass support via `resources.ToCSS`. Bascik does not include a CSS preprocessor, write vanilla CSS in the paired `.css` file alongside each component. Bascik's scoping engine handles selector scoping automatically, so there is rarely a need for nesting or variables beyond what native CSS custom properties and `:is()` provide.

```text
Before (Hugo)                After (Bascik)
assets/
  scss/                      src/components/
    _vars.scss                 site-nav/
    nav.scss                     site-nav.html
    footer.scss                  site-nav.css   ← vanilla CSS, auto-scoped
                               site-footer/
                                 site-footer.html
                                 site-footer.css
```

## Front Matter Data → Build Scripts or Inline HTML

Hugo reads YAML/TOML front matter from content files and makes it available in templates as `.Params`. In Bascik, individual pages are HTML files, front matter has no direct runtime equivalent. For pages generated from Markdown (a blog, for example), read the front matter with `gray-matter` inside a `<script data-bascik-build>` block and inline the values into the HTML.

```yaml
# content/posts/my-post.md (Hugo - before)
---
title: My Post
description: A short summary.
date: 2026-07-05
---
Post body here.
```

```html
<!-- src/pages/posts/my-post.html (Bascik - after) -->
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import matter from 'gray-matter';
  import { marked } from 'marked';
  const src = await readFile('./content/posts/my-post.md', 'utf8');
  const { data, content } = matter(src);
  console.log(`
    <h1>${data.title}</h1>
    <p class="description">${data.description}</p>
    ${await marked.parse(content)}
  `);
</script>
```
