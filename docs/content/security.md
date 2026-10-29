# Security

Server and stream scripts return HTML, and most of that HTML carries data: a search query, a user name, a row from a database, a field from an API. This page explains why that is the riskiest code on a Bascik site, what Bascik guarantees on its own, what stays your job, and how `html` from `@bascik/bascik/html` makes the safe way the easy way.

## Why string-returning servers are risky

A server script's return value is markup by contract. Bascik cannot escape it as a whole, or every `<li>` you wrote would show as text. Escaping can only apply to the values you put into the markup, and only you know where each one lands: between tags, inside a quoted attribute, in an `href`, or inside a `<script>`. Each place needs a different treatment, and some places cannot be made safe at all.

When one value slips through unescaped, a visitor writes markup into your page. On a Bascik site that markup can be more than an `<img onerror>`: it can be the tag of any of your components, with props, slots and attributes the visitor chose, and each component's own server and stream scripts then run with the current request. The [`html`](#using-html) template exists so that this cannot happen by accident.

## What Bascik guarantees

When the values in your output are escaped, Bascik keeps escaped data from ever becoming code. The rules are the same on the dev server, `bascik --server`, and Cloudflare Workers, and for the same tag written in a page at build time:

- **A prop is text.** Its value is decoded once and escaped again where it lands, so it becomes element text or one attribute value, never markup. A prop receiver on a `<script>` or `<style>` is never filled.
- **Inherited attributes keep their quoting and their value.** A usage attribute that the component's root has inherited stays one attribute on the component's root, whatever quote the root uses, with the value as written. The one exception is an attribute that becomes a URL only because of the root's tag; see [Attributes That Become URLs on the Root](/attribute-inheritance#attributes-that-become-urls-on-the-root). An inherited `class` or `style` merges into the root's own one, so a value that spells ` class=` stays a value. See [Attribute Inheritance](/attribute-inheritance#what-gets-inherited).
- **URL bindings are checked.** A prop bound to a URL attribute becomes `about:invalid` when it is a `javascript:`, `vbscript:`, `livescript:`, `mocha:` or non-image `data:` URL. This is the one URL rule `html` uses too. Any other URL is kept as the browser would take it (see [Loading scripts and styles from other sites](#loading-scripts-and-styles-from-other-sites)).
- **Some bindings are refused.** A prop is never bound to an `on*` event handler, `srcdoc`, a `<meta http-equiv>` value, the attribute an SVG animation sets, or a `style` that runs script or imports CSS. See [Put a Prop in an Attribute](/props#put-a-prop-in-an-attribute).
- **Nested scripts get no usage data.** A script inside a returned component receives the request, never the usage tag's props, slot or attributes.
- **Markers cannot be forged.** Only the markers Bascik creates for the current request run nested scripts. A marker spelled in the output is text.
- **Budgets stop hostile output.** One script output may expand to 1000 component instances and 4 MiB of HTML, one response may run 64 nested component scripts 4 levels deep, and rereading is bounded. Past a budget the script fails like any other error. See [Rules for returned tags](/server-scripts#rules-for-returned-tags).

## What is yours

- **Escaping what you interpolate.** Build output with `html`, or escape every value yourself.
- **HTML from a CMS or Markdown.** Sanitize it before it reaches the page; escaping would destroy it.
- **Component scripts.** A component's client script should treat its own markup as data, never as code to run.
- **The Content-Security-Policy.** Bascik sends none by default. The [`contentSecurityPolicy`](/how-to/content-security-policy) option sends one with your directives and the build's hashes.
- **Third-party URLs.** Script and stylesheet URLs from data load whatever site they name. See [below](#loading-scripts-and-styles-from-other-sites).
- **Names and ids.** A value you write into `id` or `name` can shadow a global in client JavaScript (DOM clobbering). Prefix such values, or keep them in `data-*` attributes.

## Where values land

| Where the value lands                                        | Plain template literal                    | `html`                                                             |
| :----------------------------------------------------------- | :---------------------------------------- | :----------------------------------------------------------------- |
| Text between tags, including in component tags               | Inserted raw: a visitor can write any tag | Escapes `& < > " '`                                                |
| Quoted attribute value, `data-bascik-prop-*`                 | Inserted raw: a `"` ends the attribute    | Escapes `& < > " '`                                                |
| URL attribute (`href`, `src`, `action`, `srcset`, `ping`)    | `javascript:` runs                        | Script URLs become `about:invalid`, then escapes                   |
| `<textarea>`, `<title>`                                      | `</title>` ends it early                  | Escapes; refuses nested markup                                     |
| Unquoted attribute (`class=${x}`)                            | A space starts a new attribute            | Throws `unquoted-attribute`                                        |
| `on*` event handler (`onclick`), `style` attribute, `srcdoc` | Runs as code                              | Throws                                                             |
| `<script>` or `<style>` body                                 | Runs as code                              | Throws, except `json(value)` in `<script type="application/json">` |
| Tag name, attribute name, comment                            | Chooses the element or attributes         | Throws                                                             |

Every refusal is a located `HtmlError` naming the template, the hole and the fix. [HTML Helpers](/html-helpers) lists each one.

## Using html

Import `html` and use it as a tag on the template you return. Each value is escaped for the place it lands, and nested `html` values (or arrays of them) are inserted as they are, so `.map` needs no `.join("")`:

```html
<script data-bascik-server>
  import { html } from "@bascik/bascik/html";

  export default async function (request) {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const rows = await search(q);
    return html`<h2>Results for ${q}</h2>
      <ul>
        ${rows.map((row) => html`<li><a href="${row.url}">${row.title}</a></li>`)}
      </ul>`;
  }
</script>
```

`html` returns a `SafeHtml` object. A server or stream script can return it on Node and on Cloudflare Workers, and a build script can too. It is not a string: call `String(value)` before using string methods on it, for example in a [handler test](/testing/server-scripts), and type a helper that returns it as `SafeHtml` (see [html](/html-helpers#html)). Keep `html` at every level: joining fragments with `+` or `.join("")` makes a plain string, which an outer `html` then escapes, so the page shows `&lt;li&gt;`.

Two habits from plain templates need a different shape. A hole cannot add or remove an attribute, so write a boolean attribute such as `selected` or `checked` in the template and choose between two fragments in code; `checked="${false}"` renders `checked=""`, which is still checked. See [Boolean attributes](/html-helpers#boolean-attributes). And when `html` refuses a template, the browser shows a plain `500 Internal Server Error` page in development too: the located message (template, hole, file and line) is in the terminal that runs `bascik`.

Build scripts deserve the same care when their data comes from somewhere others can edit, such as a CMS, a JSON file from an API, or a spreadsheet. A value there runs on every visitor's page (stored XSS) the same way. Building build script output with `html` costs nothing at request time, since it runs once per build.

### Search with html

The search page below echoes the query and renders a `<product-card>` (the card from [Render a card per search result](/server-scripts#render-a-card-per-search-result)) for each product whose name contains it. The Output is the body `bascik --server` sent for `GET /find?q=kettle`, built with the same minification-off config as the server script demos. There is no Preview because this docs site cannot run a server script.

<!-- demo:security-search-source-usage -->

```html
<!-- src/pages/find.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Find</title>
  </head>
  <body>
    <script data-bascik-server>
      import { html } from "@bascik/bascik/html";

      const catalog = [
        { name: "Milk frother", price: "$129" },
        { name: "Pour-over kettle", price: "$48" },
      ];

      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        const matches = catalog.filter((p) =>
          p.name.toLowerCase().includes(q.toLowerCase()),
        );
        return html`<p class="results">Results for ${q}</p>
          ${matches.map(
            (p) =>
              html`<product-card
                data-bascik-prop-name="${p.name}"
                data-bascik-prop-price="${p.price}"
              ></product-card>`,
          )}`;
      }
    </script>
  </body>
</html>
```

<!-- demo:security-search-output -->

```html
<!-- src/pages/find.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Find</title>
  </head>
  <body>
    <style>
      .bascik__product-card__card {
        display: grid;
        gap: 6px;
        padding: 16px;
        border: 1px solid #3a3d40;
        border-radius: 12px;
        background: #242628;
        color: #f0f1f2;
      }

      .bascik__product-card__name {
        margin: 0;
        font-size: 1rem;
      }

      .bascik__product-card__price {
        margin: 0;
        color: #8d929e;
      }

      .bascik__product-card__badge {
        justify-self: start;
        padding: 2px 10px;
        border-radius: 999px;
        background: rgba(211, 255, 141, 0.15);
        color: #d3ff8d;
        font-size: 0.75rem;
        font-weight: 600;
      }

      .bascik__product-card__save {
        justify-self: start;
        padding: 4px 12px;
        border: 1px solid #3a3d40;
        border-radius: 8px;
        background: transparent;
        color: #f0f1f2;
        cursor: pointer;
      }

      .bascik__product-card__save[aria-pressed="true"] {
        border-color: rgba(211, 255, 141, 0.6);
        color: #d3ff8d;
      }
    </style>
    <p class="results">Results for kettle</p>
    <!-- src/components/product-card/product-card.html -->
    <article class="bascik__product-card__card" data-testid="product-card">
      <h3 class="bascik__product-card__name">Pour-over kettle</h3>
      <p class="bascik__product-card__price">$48</p>
      <span class="bascik__product-card__badge">Standard</span>
      <button
        class="bascik__product-card__save"
        type="button"
        aria-pressed="false"
        data-testid="product-card-save"
      >
        Save
      </button>
    </article>
    <script>
      (function () {
        // src/components/product-card/product-card.js
        // One click listener serves every card on the page. The text is the same in
        // every instance (no scoped id), so one CSP hash covers cards a server script
        // renders at request time too.
        if (!document.documentElement.hasAttribute("data-product-card-save")) {
          document.documentElement.setAttribute("data-product-card-save", "");
          document.addEventListener("click", (event) => {
            const save = event.target.closest(".bascik__product-card__save");
            if (save === null) return;
            const saved = save.getAttribute("aria-pressed") !== "true";
            save.setAttribute("aria-pressed", String(saved));
            save.textContent = saved ? "Saved" : "Save";
          });
        }
      })();
      //# sourceURL=src/components/product-card/product-card.js
    </script>
  </body>
</html>
```

## A malicious ?q= comes back as text

### The same page, attacked

Here the same page gets a query that holds a component tag and an `<img>` with an `onerror` handler. The Output is the body `bascik --server` sent for `GET /find?q=%3Cproduct-card%20data-bascik-prop-name%3Dx%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%3C%2Fproduct-card%3E`. The query comes back as escaped text: no card is rendered, no `<img>` element exists, and nothing runs. There is no Preview because this docs site cannot run a server script.

<!-- demo:security-malicious-q-output -->

```html
<!-- src/pages/find.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Find</title>
  </head>
  <body>
    <p class="results">
      Results for &lt;product-card data-bascik-prop-name=x&gt;&lt;img src=x
      onerror=alert(1)&gt;&lt;/product-card&gt;
    </p>
  </body>
</html>
```

## The helpers

`@bascik/bascik/html` exports four more plain functions. Each one is a call you can see in code; nothing runs on its own.

- `raw(value)` marks HTML you trust, such as sanitized CMS or Markdown output, so `html` inserts it as it is.
- `esc(value)` returns an entity-escaped string for code that builds strings without `html`. Inside `html` it escapes twice.
- `safeUrl(value, { base, origins, image })` returns the URL, or `about:invalid` when it could run script or sits on an origin you did not list.
- `json(value)` returns JSON that is safe as the only content of `<script type="application/json">`.

See [HTML Helpers](/html-helpers) for every option, the contexts and values tables, and every error message.

## CMS and Markdown content

HTML from a CMS, a Markdown renderer or an API is already markup, so escaping would show its tags as text. Sanitize it with an allowlist, then insert it with `raw()`. With a headless CMS or a Markdown renderer there is often no save step to sanitize in, so do it when you render:

```html
<script data-bascik-server>
  import { html, raw } from "@bascik/bascik/html";
  import sanitizeHtml from "sanitize-html";
  import { getPost } from "@/lib/cms.ts";

  export default async function (request) {
    const post = await getPost(new URL(request.url).searchParams.get("id"));
    const body = sanitizeHtml(post.bodyHtml, {
      allowedTags: [
        "p",
        "h2",
        "h3",
        "a",
        "strong",
        "em",
        "ul",
        "ol",
        "li",
        "blockquote",
        "code",
        "pre",
      ],
      allowedAttributes: { a: ["href"] },
      allowedSchemes: ["https", "mailto"],
    });
    return html`<article>
      <h1>${post.title}</h1>
      ${raw(body)}
    </article>`;
  }
</script>
```

Install the sanitizer as a dependency of the site (`npm install sanitize-html`); an inline server script imports it like any package. If the CMS cleans HTML when an editor saves it, you can sanitize there instead, once.

Choose a sanitizer that runs where your scripts run: a pure JavaScript one such as `sanitize-html` works on Node and in a Cloudflare Worker. A tag of one of your components in sanitized HTML still renders that component, so allow only the elements you expect.

## Dynamic components with html fragments

A value never chooses which element to write: `html` refuses a hole in a tag name position (`<${tag}>`). To render one of several components, choose between fixed `html` fragments in code:

```js
const card = (item) =>
  item.kind === "video"
    ? html`<video-card data-bascik-prop-title="${item.title}"></video-card>`
    : html`<article-card
        data-bascik-prop-title="${item.title}"
      ></article-card>`;
```

The same holds for attributes: write each attribute in the template with a quoted value, and choose between fixed fragments when the set of attributes changes.

## Client data via data-\* and json

Give client scripts request data through a `data-*` attribute, which `html` escapes, or through a JSON script filled with `json(value)`:

<!-- prettier-ignore -->
```html
<script data-bascik-server>
  import { html, json } from "@bascik/bascik/html";

  export default async function (request) {
    const user = await currentUser(request);
    return html`<div class="profile" data-name="${user.name}"></div>
      <script type="application/json">${json(user)}<\/script>`;
  }
</script>
```

`json()` escapes `<`, `>`, `&`, U+2028 and U+2029, so the data cannot end the script early. Any other value in a `<script>` makes `html` throw. Inside an inline server script, write the closing tag of a returned script as `<\/script>`, or the page's own script ends there.

## Loading scripts and styles from other sites

Bascik allows a script, stylesheet or other loaded URL on any site, like the browser does. A prop bound to `<script src>`, `<base href>` or a stylesheet `<link href>`, and a value in `html` at the start of such an attribute, keep any `http:` or `https:` URL. Only script URLs (`javascript:` and the like) become `about:invalid`.

That is a risk when the URL comes from data a visitor can influence: a query parameter, a profile field, a CMS entry anyone can edit. Whoever picks a `<script src>` URL picks the code that runs on your page, a `<base href>` changes where every relative URL points, and a stylesheet can restyle or leak the page. Protect them with any of these:

- **A Content-Security-Policy** with `script-src` and `style-src` listing the origins you load from. The browser then refuses any other origin. Bascik can send it for you with [`contentSecurityPolicy`](/how-to/content-security-policy).
- **`safeUrl(value, { origins })`** in the script, listing the origins you accept: `safeUrl(theme.css, { origins: ["https://cdn.example.com"] })` returns `about:invalid` for any other origin, and keeps same-site paths.
- **The URL written in the template**, not taken from data, whenever it is fixed.
- **Fixed variants chosen in code**: map a visitor's choice to one of a few URLs you wrote (`themes[name] ?? themes.default`), so the value only selects.

## CSP and request-time components

With `generate.cspHashes` or `contentSecurityPolicy`, every route lists the hashes of its own inline scripts and styles. A route with a server or stream script also lists the hashes of every component that can be rendered at request time, because any of them can be returned. A hash-only policy still blocks a `<script>` or `<style>` a visitor writes, since its text has no hash. A component tag injected through an escaping bug, though, runs that component's own client script, which is why `html` and component scripts that treat markup as data matter even with a policy. The [Content Security Policy](/how-to/content-security-policy) how-to has a recipe for each host.

Two things to settle before you turn a policy on:

- **Component scripts must be the same in every instance.** A client script that calls `getElementById` on the component's own id carries the instance id in its text, so the build cannot hash it for a request-time render, and its button stays dead under the policy. `bascik --check` lists such components (the starter's `<my-counter>` and `<site-header>` among them). [Components rendered at request time](/how-to/content-security-policy#components-rendered-at-request-time) shows how to rewrite one, using the `<product-card>` from the search demo above.
- **Inline `style` attributes.** Once `style-src` lists a hash, browsers block every `style="..."` attribute, and the starter pages use a few. List `'unsafe-inline'` in `style-src` for now (Bascik then adds no style hashes to it), or set `hashes: { scripts: true, styles: false }`. See [Styles](/how-to/content-security-policy#styles).

## The linter

The language server, the VS Code extension and `bascik --check` warn with `server-script-unescaped-markup` when a server or stream script interpolates a value into a markup template without `html`:

```text
src/pages/search.html:14:31 - warning: (server-script-unescaped-markup) This markup template (line 14) interpolates ${q} (hole 1) without html. Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.
```

The rule follows values through string concatenation (`${first + last}`) and through later assignments to a `let` or `var`, and checks templates tagged with `String.raw` or a `dedent`-style tag like untagged ones. It reads code, not data flow, so it cannot see every path a value takes: treat a clean report as a check, and build markup with `html` anyway.

In the editor, the quick fix **Wrap template in html\`...\`** adds the tag and the import. It is not offered where `html` would throw (a tag name, an attribute name, a comment) or where the name `html` and the alias `safeHtml` are both taken. `bascik --check --fix` does not apply it, because the value changes from a string to an `html` value. Inside `html` templates, the sink rules become errors where `html` would throw. See the [Linter](/tools/linter#server-script-unescaped-markup) for configuration and suppression.

![VS Code showing a server script whose template interpolates a query parameter without html: the hole is underlined, the hover names server-script-unescaped-markup, and the quick fix wraps the template in html and adds the import](/assets/vscode/unescaped-markup-still@2x.webp)

## Checklist

- Every server and stream script that returns markup with data in it uses `html`.
- No value lands in an `on*` attribute, a `style`, a `<script>` or a `<style>`; client data goes in `data-*` or `json()`.
- CMS and Markdown HTML is sanitized with an allowlist, then inserted with `raw()`.
- Script and stylesheet URLs are fixed in the template, chosen from fixed variants, or checked with `safeUrl(value, { origins })`.
- `bascik --check` reports no `server-script-unescaped-markup` warning.
- A Content-Security-Policy is on, through `contentSecurityPolicy` or your host.
- Component client scripts never run their own markup as code.
- The self-test below passes on every host you deploy to.

## Self-test

Send a query that holds a component tag and an `onerror` payload to a page that echoes `?q=`, on the dev server, after `bascik --build && bascik --server`, and on a Cloudflare preview:

```sh
curl -s "http://localhost:8080/find?q=%3Cproduct-card%20data-bascik-prop-name%3Dx%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%3C%2Fproduct-card%3E"
```

The body must show `&lt;product-card data-bascik-prop-name=x&gt;&lt;img src=x onerror=alert(1)&gt;` as text, with no `<img` element and no rendered card. In a browser, open the same URL: the page shows the query as text and no alert appears. Then try `?q=javascript:alert(1)` on a page that puts the query in an `href`: the link must read `about:invalid`. If any check fails, find the template with [Troubleshooting](/testing/troubleshooting#server-script-safety) and the linter.
