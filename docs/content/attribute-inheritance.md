# Attribute Inheritance

Any attribute on a component usage tag that is not a Bascik-specific attribute (`data-bascik-*`) is automatically merged onto the component's root element. This is analogous to Vue's "fallthrough attributes".

## How It Works

When Bascik transpiles a component, it reads the usage tag, extracts any inheritable attributes, and merges them onto the first element of the compiled output. The component template and the usage attributes are combined: classes are appended, and all other attributes are forwarded.

If a component template contains multiple root elements (for example, a heading followed by a paragraph), inherited attributes are merged onto the **first** root HTML element in the component template.

Leading text nodes and metadata elements such as `<link>` and `<meta>` remain in place and do not consume inherited attributes. Bascik continues to the first content element, even when its quoted attribute values contain `>`.

The demo above shows the usage tag and component template separately under Source, then combines them under Output → HTML.

## Class Merging

When the root element already has a scoped `class`, the inherited class is **appended** rather than replacing it.

In the demo output, the scoped `inherit-card` class and usage-site `featured-card` class both remain on the root `<article>`.

When both the component root and usage tag define `style`, Bascik appends the usage declarations after the root declarations. Normal CSS cascade rules therefore let the usage declaration win when both set the same property.

An inherited value keeps its meaning whatever quotes the usage tag and the root use. HTML allows a raw `"` inside a single-quoted value and a raw `'` inside a double-quoted one, so when Bascik moves a value onto the root it encodes the quote the value is written in: `"` as `&quot;` in a double-quoted value, `'` as `&#39;` in a single-quoted one. Every other character, the other quote included, is copied byte for byte.

## What Gets Inherited

All attributes on the usage tag are inherited **except** `data-bascik-*` attributes, which are consumed by Bascik for slots, props, and build instructions.

Common use cases:

- **Layout classes:** `class="sticky"`, `class="hidden"`
- **Accessibility:** `aria-label`, `role`, `aria-hidden`
- **Testing hooks:** `data-testid`, `data-cy`
- **Custom data:** any `data-*` attribute except `data-bascik-*`
- **Framework directives:** `@click="open()"`, `x-on:click.prevent="go()"`, `:class="{ active }"`, `hx-on::after-request="done()"`. An attribute name is read the way the browser reads it, up to whitespace, `/`, `=` or `>`, so `@`, `.`, `:` and `#` stay part of the name and the value comes along.

Inherited values are copied exactly as written, with one exception: see [Attributes That Become URLs on the Root](#attributes-that-become-urls-on-the-root). An inherited `class` or `style` merges into the root's own `class` or `style` only, never into text another inherited value carries.

When the root already has an attribute the usage tag also sets, the root's value stays, except for `class` and `style`, which merge, and `data-testid`, where the usage tag's value replaces the root's. That lets a component ship a default test id on its root (`data-testid="plan-card"`) while a page names one instance (`<plan-card data-testid="plan-card-featured" />`), so a test can find it with `getByTestId` instead of counting instances. See [End-to-End Testing](/testing/e2e-testing#recommended-pattern-data-testid-attributes).

Attribute inheritance is root-only. To send a prop to an attribute on a non-root element, use [`data-bascik-attr-{attribute}="{propName}"`](/props#put-a-prop-in-an-attribute). Use slots when the consumer should provide the element or richer markup itself.

### Attributes That Become URLs on the Root

Bascik copies an inherited attribute exactly as written, with one exception. An attribute that becomes a URL only because of the root's tag gets the same URL check that `html` and URL prop bindings use (see [Security](/security#what-bascik-guarantees)). That means `data` on an `<object>` root, and `to`, `from`, `by` and `values` on an SVG animation root such as `<animate>`. Values that are script URLs such as `javascript:` become `about:invalid` there. So does any `data:` URL (`data:image/...` included), because an `<object>` can load any page, and Bascik prints a warning that names the component file. Every other URL, such as `https:` or a relative path, is kept as written. To inherit such a value as written, for example a `data:application/pdf` URL you control, turn the check off with [`security.blockScriptUrls: false`](/configuration#security); it then applies to every URL binding, so do it only when no visitor can choose the URL.

Only this case is checked because [`html`](/security), or your own escaping, sees `<my-embed data="...">` and cannot know the root is an `<object>`, where `data` loads a page.

Everything else is yours and is inherited as written, including your own `onclick`, `style` and `href`. To put visitor data in markup safely, build it with `html` as [Security](/security) shows: `html` already refuses visitor data in event handlers, `srcdoc` and `style`, and checks `href`, `src`, `action` and `formaction` as URLs on any tag.

In the demo below, the `https:` URL is kept and the `javascript:` URL becomes `about:invalid`. The first line of each code block names the file; it is an ordinary comment, so it also appears in the Output. The docs site blocks `<object>` embeds, so the Preview shows each embed's fallback text, and the difference is in the `data` attribute in the Output. The build prints this warning for the second usage:

```text
<my-embed> (components/my-embed/my-embed.html): inherited attribute data received a script URL such as javascript:, so data on the root <object> is set to about:invalid.
```

<!-- demo:url-root-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Frother manual</title>
  </head>
  <body>
    <my-embed data="https://example.com/frother-manual.html"></my-embed>
    <my-embed data="javascript:alert(1)"></my-embed>
  </body>
</html>
```

<!-- demo:url-root-source-html -->

```html
<!-- src/components/my-embed/my-embed.html -->
<object type="text/html" data-testid="my-embed">
  <p>The embedded page is not shown here.</p>
</object>
```

<!-- demo:url-root-output-html -->

```html
<!-- src/components/my-embed/my-embed.html -->
<object
  type="text/html"
  data-testid="my-embed"
  data="https://example.com/frother-manual.html"
>
  <p>The embedded page is not shown here.</p>
</object>

<!-- src/components/my-embed/my-embed.html -->
<object type="text/html" data-testid="my-embed" data="about:invalid">
  <p>The embedded page is not shown here.</p>
</object>
```

## What Happens with `id`

`id` is treated like any other inheritable attribute **unless the component root already has its own `id`**.

The demo passes `id="featured-inheritance"` to a template root with no ID; Output → HTML shows it forwarded unchanged.

If the template root already defines an `id`, Bascik keeps the template's root `id` and does not overwrite it with the usage-site `id`. That prevents root-level collisions while still letting you anchor page-level CSS or JavaScript to a component root that does not already declare one.

> **Practical rule:** If page code needs to target a component root by `id`, put the `id` on the usage tag only when the component root does not already define one.

## Interaction with Scoped Classes

Inherited class names are not scoped to the component they land on; they are treated as global classes. This is intentional: you are passing a page-level concern onto the component's root element.

```html
<my-card class="featured">
  <p>Featured content</p>
</my-card>
```

The `featured` class is a global class that you define in your page-level stylesheet, separate from the component's scoped CSS.

> **Self-closing syntax works too:** Attribute inheritance works with both paired and self-closing usage syntax: `<my-icon class="large" aria-hidden="true" />`

## Styling a Child Component from Its Parent

A component's CSS applies only to markup written in that component's own template. A child component's root element belongs to the child, so a parent's element selector such as `nav a { }` does not match an `<a>` that a child component renders as its root. Components stay isolated from each other.

To style a child's root from the parent, put a class on the child's usage tag and define that class in the parent's CSS. Bascik scopes the class to the parent, then merges it onto the child's root element:

```html
<!-- site-nav.html: the parent -->
<nav>
  <nav-link class="item" href="/">Home</nav-link>
  <nav-link class="item" href="/blog">Blog</nav-link>
  <a href="/about">About</a>
</nav>
```

```css
/* site-nav.css: .item is scoped to site-nav and lands on each nav-link root */
.item {
  padding: 1em 0.5em;
  border-bottom: 4px solid transparent;
}
nav a {
  color: inherit;
}
```

```html
<!-- nav-link.html: the child; its root is an anchor -->
<a><span data-bascik-slot></span></a>
```

```html
<!-- compiled output (identifier minification off) -->
<nav class="bascik__site-nav__el__nav">
  <a class="bascik__site-nav__item" href="/">Home</a>
  <a class="bascik__site-nav__item" href="/blog">Blog</a>
  <a class="bascik__site-nav__el__a" href="/about">About</a>
</nav>
```

The `.item` class reaches both children because it is written in the parent's template. The `nav a` rule styles only the plain `<a href="/about">` the parent wrote itself, and it never matches the anchors rendered by `nav-link`.

The same applies when a build script or a slot produces the markup. Anything that renders a child component should put the class on the usage tag, as in `<nav-link class="item" …>`.

When a class is not defined in the parent's CSS, it passes through unscoped, so a page-level stylesheet can style it. That is the global-class behavior described above.

> **Coming from Astro.** Astro's scoped `<style>` lets a parent selector such as `nav a` reach into a child component's root element. Bascik does not. Replace those selectors with a class on the child's usage tag, as shown above.

**MDN reference.** Bascik forwards standard HTML attributes instead of inventing a new API. Use [MDN's HTML attribute reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes) as the primary guide for what each inherited attribute means.

## Disabling It

Attribute inheritance is enabled by default. Set `scoping.inheritAttributes` to `false` in `bascik.config.ts` when you want every component root to be controlled only by its own template:

```ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  scoping: {
    inheritAttributes: false,
  },
});
```

## See it in action

This example forwards a class, an ID, an accessibility label, and a testing hook onto the component root.

<!-- demo:source-usage -->

```html
<inherit-demo-card
  class="featured-card"
  id="featured-inheritance"
  aria-label="Featured inheritance demo"
  data-testid="inherit-demo"
>
</inherit-demo-card>
```

<!-- demo:source-html -->

```html
<article class="inherit-card">
  <p class="inherit-card-kicker">Template root</p>
  <h3 class="inherit-card-title">Attribute inheritance</h3>
  <p class="inherit-card-body">
    Usage attributes merge onto this root element at build time.
  </p>
</article>
```

<!-- demo:source-css -->

```css
.inherit-card {
  width: min(100%, 34rem);
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px;
}

.inherit-card-kicker {
  margin: 0 0 10px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #d3ff8d;
}

.inherit-card-title {
  margin: 0 0 10px;
  font-size: 1.05rem;
}

.inherit-card-body {
  margin: 0;
  color: #8d929e;
}
```

<!-- demo:output-html -->

```html
<article
  class="bascik__inherit-demo-card__inherit-card featured-card"
  id="featured-inheritance"
  aria-label="Featured inheritance demo"
  data-testid="inherit-demo"
>
  <p class="bascik__inherit-demo-card__inherit-card-kicker">Template root</p>
  <h3 class="bascik__inherit-demo-card__inherit-card-title">
    Attribute inheritance
  </h3>
  <p class="bascik__inherit-demo-card__inherit-card-body">
    Usage attributes merge onto this root element at build time.
  </p>
</article>
```
