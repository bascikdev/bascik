# Templating

Bascik does not ship a proprietary template language or a custom server-side component framework. The core compiler focuses on what it does best: compiling static HTML components, scoping CSS and JavaScript, and executing plain Node.js scripts at build time or request time. When a project requires loops, partials, or layout composition, you can use native JavaScript features or any template engine from the npm ecosystem.

This page outlines recommended patterns for data-driven markup in Bascik projects.

## Why Bascik stays out of the template layer

Traditional web frameworks often bundle proprietary templating languages, custom JSX compilers, or bespoke reactivity runtimes. Bascik intentionally avoids this layer for several reasons:

- **Standard web technologies:** Bascik treats HTML as standard HTML. Rather than introducing a custom DSL that requires dedicated parser plugins, custom syntax highlighters, and bespoke IDE tooling, your markup remains standard vanilla HTML.
- **Node.js as the execution environment:** Both build-time scripts (`data-bascik-build`) and request-time scripts (`data-bascik-server`) run as standard Node.js processes. This means you have full, direct access to the entire JavaScript language and the npm package ecosystem without needing framework-specific adapters.
- **Transparent data flow:** There are no hidden global contexts, magic lifecycle hooks, or implicit reactive state trees. Data is retrieved, transformed into standard HTML strings using your preferred method, and printed to standard output via `console.log`.
- **Ecosystem flexibility:** Simple sites often only need native JavaScript template literals and a small helper module. Content-heavy publications or complex applications might prefer EJS, Nunjucks, or Handlebars. You choose the right tool for your project without framework lock-in.

## Plain JS template literals

For many pages, the simplest approach is still ordinary JavaScript string templates. They require no external dependencies and work identically in both build-time (`data-bascik-build`) and request-time (`data-bascik-server`) scripts.

```html
<script data-bascik-server>
  const { headers } = JSON.parse(process.env.BASCIK_REQUEST);
  const user = String(headers['x-display-name'] ?? 'Guest')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  console.log(`
    <section class="welcome">
      <h2>Hello, ${user}</h2>
      <ul>
        <li>Overview</li>
        <li>Reports</li>
        <li>Settings</li>
      </ul>
    </section>
  `);
</script>
```

This is often enough for dashboards, landing pages, and one-off server-rendered sections. It is explicit, familiar, and easy to reason about.

## A tiny shared HTML helper

When the same escaping or list-rendering logic appears repeatedly, keep it in a small helper module and import it.

```js
// lib/html.mjs
export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const renderList = (items) =>
  `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
```

```html
<script data-bascik-server>
  import { escapeHtml, renderList } from './lib/html.mjs';

  const { searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const items = (searchParams.tags ?? 'news,updates').split(',');
  const safeTags = items.map(v => escapeHtml(v.trim())).filter(Boolean);

  console.log(`
    <section>
      <h2>Topics</h2>
      ${renderList(safeTags)}
    </section>
  `);
</script>
```

> **Why `escapeHtml` is not applied automatically.** Bascik injects the standard output of your script directly into the HTML document. If Bascik automatically escaped script output, scripts could not emit raw HTML elements or component tags. Escaping untrusted user inputs before interpolating them into HTML strings keeps data flow safe and explicit.

## EJS for loops and includes

If the project needs more structure, use a template library like EJS for layout fragments and repeated markup.

```sh
npm install ejs
```

```html
<script data-bascik-server>
  import { readFile } from 'node:fs/promises';
  import ejs from 'ejs';

  const rows = [
    { title: 'First post', href: '/posts/first' },
    { title: 'Second post', href: '/posts/second' },
  ];

  const template = await readFile('./templates/post-list.ejs', 'utf8');
  console.log(ejs.render(template, { rows }));
</script>
```

```ejs
<!-- templates/post-list.ejs -->
<ul class="post-list">
  <% rows.forEach((row) => { %>
    <li><a href="<%= row.href %>"><%= row.title %></a></li>
  <% }); %>
</ul>
```

This works well when the HTML is large, repetitive, or needs layout-like partials. EJS automatically HTML-escapes values printed with `<%= ... %>`. To output unescaped HTML when you have already sanitized the markup, use `<%- ... %>`.

## Nunjucks for richer template composition

Nunjucks is a good fit for pages that want includes, layout blocks, and more opinionated template syntax without turning Bascik into a framework.

```sh
npm install nunjucks
```

```html
<script data-bascik-server>
  import nunjucks from 'nunjucks';

  const html = nunjucks.render('./templates/page.njk', {
    title: 'Projects',
    items: ['Alpha', 'Bravo', 'Charlie'],
  });

  console.log(html);
</script>
```

```njk
{# templates/page.njk #}
<section>
  <h2>{{ title }}</h2>
  <ul>
    {% for item in items %}
      <li>{{ item }}</li>
    {% endfor %}
  </ul>
</section>
```

Nunjucks is useful when the site has a lot of repetitive HTML and a real template structure. Bascik still remains the static compiler; the template library just renders fragments into ordinary HTML before they are injected. Nunjucks automatically escapes variable output by default.

## Handlebars

Handlebars is a good choice when the team prefers a logic-less template syntax and wants helpers registered separately from template files.

```sh
npm install handlebars
```

```html
<script data-bascik-server>
  import { readFile } from 'node:fs/promises';
  import Handlebars from 'handlebars';

  const { searchParams } = JSON.parse(process.env.BASCIK_REQUEST);
  const page = Math.max(1, Number(searchParams.page ?? 1));

  const src = await readFile('./templates/article-list.hbs', 'utf8');
  const template = Handlebars.compile(src);

  const items = [
    { title: 'First article', href: '/posts/first' },
    { title: 'Second article', href: '/posts/second' },
  ];

  console.log(template({ items, page }));
</script>
```

```hbs
{{! templates/article-list.hbs }}
<section>
  <h2>Articles (Page {{page}})</h2>
  <ul>
    {{#each items}}
      <li><a href="{{href}}">{{title}}</a></li>
    {{/each}}
  </ul>
</section>
```

Handlebars HTML-escapes `{{value}}` expressions by default. Use the triple-stache `{{{value}}}` only when you have already sanitized the value yourself.
