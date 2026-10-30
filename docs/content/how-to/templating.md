# Templating

Bascik does not ship a proprietary template language or a custom server-side component framework. The core compiler focuses on what it does best: compiling static HTML components, scoping CSS and JavaScript, and executing plain Node.js scripts at build time or request time. When a project requires loops, partials, or layout composition, you can use native JavaScript features or any template engine from the npm ecosystem.

## Why Bascik stays out of the template layer

Traditional web frameworks often bundle proprietary templating languages, custom JSX compilers, or bespoke reactivity runtimes. Bascik intentionally avoids this layer for several reasons:

- **Standard web technologies:** Bascik treats HTML as standard HTML. Rather than introducing a custom DSL that requires dedicated parser plugins, custom syntax highlighters, and bespoke IDE tooling, your markup remains standard vanilla HTML.
- **Node.js as the execution environment:** Both build-time scripts (`data-bascik-build`) and request-time scripts (`data-bascik-server`) run as standard JavaScript modules on Node.js (request-time scripts also run in a Cloudflare Worker). This means you have full, direct access to the entire JavaScript language and the npm package ecosystem without needing framework-specific adapters.
- **Transparent data flow:** There are no hidden global contexts, magic lifecycle hooks, or implicit reactive state trees. Data is retrieved, transformed into standard HTML strings using your preferred method, and returned from the default export function.
- **Ecosystem flexibility:** Simple sites often only need native JavaScript template literals and a small helper module. Content-heavy publications or complex applications might prefer EJS, Nunjucks, or Handlebars. You choose the right tool for your project without framework lock-in.

## html, built in

For markup built in a server, stream or build script, start with [`html`](/html-helpers) from `@bascik/bascik/html`. It is a plain tagged template, with nothing to install: each `${...}` is escaped for where it lands, URLs are checked for `javascript:` and the like, and places escaping cannot make safe (an `onclick` value, a `<script>` body) throw a located error. Arrays of `html` values nest without `.join("")`.

<!-- demo:html-script -->

```html
<script data-bascik-server type="text/typescript">
  import { html } from "@bascik/bascik/html";

  export default function (request: Request) {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const items = [
      { title: "First article", href: "/posts/first" },
      { title: "Second article", href: "/posts/second" },
    ];
    return html`<section>
      <h2>Articles matching ${q}</h2>
      <ul>
        ${items.map((item) => html`<li><a href="${item.href}">${item.title}</a></li>`)}
      </ul>
    </section>`;
  }
</script>
```

Server and stream scripts handle data from the request, so they are where escaping matters most; see [Security](/security). The template libraries below suit templates that live in their own files, and they are fine in any script. Like `html`, they escape text by default, but none of them checks URL schemes: `href="{{url}}"` keeps `javascript:alert(1)`. Pass a URL that comes from data through `safeUrl` from `@bascik/bascik/html` before it reaches the template.

## Handlebars

**Handlebars is the recommended templating library** for templates kept in their own files. It is small, its logic-less design fits a build-time system where the template is evaluated once and the result is static HTML, and it escapes values by default so a forgotten escape does not become an injection bug.

Install Handlebars once and import it in any build or server script.

<!-- demo:handlebars-install -->

```sh
npm install handlebars
```

Keep the template in a `.hbs` file so editors can highlight it and the script stays readable.

<!-- demo:handlebars-script -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import { readFile } from "node:fs/promises";
  import Handlebars from "handlebars";

  export default async function () {
    const src = await readFile("./templates/article-list.hbs", "utf8");
    const template = Handlebars.compile(src);

    const items = [
      { title: "First article", href: "/posts/first" },
      { title: "Second article", href: "/posts/second" },
    ];

    return template({ items, page: 2 });
  }
</script>
```

<!-- demo:handlebars-template -->

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

## A dependency-free interpolation helper

`html` covers templates written in a script. For a template kept as a plain string, such as one read from a file or a CMS field, this small helper fills `${path}` placeholders without installing anything. It resolves dotted paths against a plain object, escapes HTML by default, and renders a missing key as an empty string so a data typo degrades quietly instead of throwing. It does not check URLs, so do not put a placeholder at the start of an `href` or `src`.

<!-- demo:helper-module -->

```ts
// src/lib/interpolate.ts
export const escape = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const interpolate = (
  template: string,
  data: Record<string, unknown>,
): string =>
  template.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
    const value = path
      .trim()
      .split(".")
      .reduce<unknown>(
        (obj, key) =>
          obj == null ? undefined : (obj as Record<string, unknown>)[key],
        data,
      );
    return value == null ? "" : escape(value);
  });
```

Use it from a build script:

<!-- demo:helper-usage -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import { interpolate } from "@/lib/interpolate.ts";

  export default function () {
    const data = { article: { title: "Hello, Bascik" } };
    return interpolate("<h2>${article.title}</h2>", data);
  }
</script>
```

If the helper grows past about twenty lines, that is the signal to reach for Handlebars. A helper that keeps growing new features is a template engine you now have to maintain yourself.

> **Why nothing escapes automatically.** Bascik injects the returned HTML of your script directly into the HTML document. If Bascik automatically escaped script output, scripts could not emit raw HTML elements or component tags. Escaping happens where you put a value into markup: `html` does it for you, one value at a time, and a template library or this helper does it for its own placeholders. See [Security](/security).

## EJS and Nunjucks, if you already know them

If your team already knows EJS or Nunjucks, or the project already depends on one, keep using it. Both work in build and server scripts with no integration layer, and both escape variable output by default.

<!-- demo:ejs-install -->

```sh
npm install ejs
```

<!-- demo:ejs-script -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import { readFile } from "node:fs/promises";
  import ejs from "ejs";

  export default async function () {
    const rows = [
      { title: "First post", href: "/posts/first" },
      { title: "Second post", href: "/posts/second" },
    ];

    const template = await readFile("./templates/post-list.ejs", "utf8");
    return ejs.render(template, { rows });
  }
</script>
```

<!-- demo:ejs-template -->

```ejs
<!-- templates/post-list.ejs -->
<ul class="post-list">
  <% rows.forEach((row) => { %>
    <li><a href="<%= row.href %>"><%= row.title %></a></li>
  <% }); %>
</ul>
```

EJS escapes values printed with `<%= ... %>`. Use `<%- ... %>` only for markup you have already sanitized.

<!-- demo:njk-install -->

```sh
npm install nunjucks
```

<!-- demo:njk-script -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import nunjucks from "nunjucks";

  export default function () {
    return nunjucks.render("./templates/page.njk", {
      title: "Projects",
      items: ["Alpha", "Bravo", "Charlie"],
    });
  }
</script>
```

<!-- demo:njk-template -->

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

Nunjucks is useful when the site has a lot of repetitive HTML and a real template structure with includes and layout blocks. Bascik still remains the static compiler; the template library just renders fragments into ordinary HTML before they are injected.

## The fetch-once pattern

When a data-driven page needs the same data in several places, fetch or read it **once at page level** in a single `data-bascik-build` script, then apply it everywhere on the page. Not once per component instance.

<!-- demo:fetch-once-script -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import { readFile } from "node:fs/promises";
  import { html } from "@bascik/bascik/html";

  interface Article {
    title: string;
    href: string;
  }

  export default async function () {
    // One read at page level; every block below reuses this data.
    const data: { site: string; articles: Article[] } = JSON.parse(
      await readFile("./content/data.json", "utf8"),
    );

    const list = data.articles.map(
      (a) => html`<li><a href="${a.href}">${a.title}</a></li>`,
    );

    return html`<section>
      <h2>${data.site}</h2>
      <ul>
        ${list}
      </ul>
    </section>`;
  }
</script>
```

The same `data` object can feed a second script on the page, a JSON payload for client JavaScript, or a component prop, without a second network round trip or file read.

> **Build script caching cannot see network fetches.** The build script cache keys on the script body and its statically scanned local dependencies. A script whose output depends on a remote API will be served from cache with stale data across builds, and nothing will tell you. If a script fetches from the network, reads a directory with `readdir`, or uses computed file paths, exclude it from caching in `bascik.config.ts`:
>
> The `include` and `exclude` globs are relative to the project root, so `src/pages/live-feed/**` and `src/components/api-cards/**` match those source paths even though the compiler may pass absolute file paths internally.
>
> ```ts
> // bascik.config.ts
> import { defineConfig } from "@bascik/bascik/config";
>
> export default defineConfig({
>   scripts: {
>     cache: {
>       enabled: true,
>       exclude: ["src/pages/live-feed/**", "src/components/api-cards/**"],
>     },
>   },
> });
> ```
>
> See [Build Scripts](/build-scripts#performance-output-caching) for the full cache key and invalidation limits.

## A JSON payload for client JavaScript

Sometimes the data needs to drive **interaction**, not initial render. Emit it once as a `<script type="application/json">` block at build time, and read it from client JavaScript.

This is the one approach on this page that **requires client-side JavaScript**, which is a real cost on a zero-runtime site. It is worth it when the data drives interaction, not when it drives initial render. If the rendered HTML is the only consumer, render it server or build side and skip the JSON block entirely.

<!-- demo:json-payload-script -->

```html
<!-- src/pages/articles.html -->
<script data-bascik-build type="text/typescript">
  import { readFile } from "node:fs/promises";
  import { html, json } from "@bascik/bascik/html";

  export default async function () {
    const data = JSON.parse(await readFile("./content/data.json", "utf8"));

    // json() escapes <, > and &, so no title can end this block early.
    return html`<script type="application/json" id="page-data">
      ${json({ site: data.site, articles: data.articles })}
    <\/script>`;
  }
</script>
```

<!-- demo:json-payload-client -->

```html
<script type="text/typescript">
  // In a component, the id is scoped at build time. Write getElementById with
  // the source name; Bascik rewrites the selector to the scoped name.
  interface Article {
    title: string;
    href: string;
  }

  const payload: { site: string; articles: Article[] } = JSON.parse(
    document.getElementById("page-data")!.textContent!,
  );

  document.getElementById("sort-btn")!.addEventListener("click", () => {
    payload.articles.sort((a, b) => a.title.localeCompare(b.title));
    // ...re-render the sorted list from payload
  });
</script>
```

**The gotcha:** in a page, as here, the `id` ships as written. Move the block into a component and its `id` is **scoped per instance at build time**, so client code must use `getElementById` with the source name and let Bascik rewrite the selector to the scoped name. This is the same rule as everywhere else in Bascik: inside an `<article-list>` component, `getElementById('page-data')` in the source becomes `getElementById('bascik__article-list__f23dc087__page-data')` in the compiled output (a short hash once `minify.identifiers` is on), and the two always stay in sync because the rewrite is automatic. Never hardcode the scoped name yourself; it contains a per-instance hash you cannot predict.
