# Components Reference

A component is one `.html` file inside a component root (default `src/components/`). Its tag name is the lowercase file name without `.html`. Subfolders are for organization only; the tag still comes from the file name, and duplicate names anywhere in the roots are a build error.

## Naming

- WHATWG custom element names contain a hyphen: `<site-nav>`, `<hello-card>`, `<my-button>`.
- Single-word names (`card.html`) still compile, but the CLI and editor warn. Use a hyphenated name.
- A file named after a native element (`header.html`, `nav.html`, `dialog.html`) warns and then replaces every element of that name on the page, which almost always breaks the site.
- Names are lowercased on load. `My-Card.html` registers as `my-card`. If two files differ only by case, the last one loaded wins. Always use lowercase file names.

## File shapes

HTML only:

```html
<!-- src/components/page-footer.html -->
<footer>
  <p>© 2026 My Site. All rights reserved.</p>
</footer>
```

HTML, CSS, and JavaScript in one file (style above, script below):

```html
<!-- src/components/alert-box.html -->
<style>
  .alert { display: flex; gap: 0.75rem; padding: 1rem; border: 1px solid #f59e0b; }
  .alert-close { margin-left: auto; }
</style>
<div class="alert" id="alert">
  <span>Maintenance on Sunday, 2am to 4am UTC.</span>
  <button id="close" class="alert-close" aria-label="Dismiss">×</button>
</div>
<script>
  document.getElementById('close').addEventListener('click', () => {
    document.getElementById('alert').hidden = true;
  });
</script>
```

Folder layout with companion files:

```text
src/components/
  alert-box/
    alert-box.html
    alert-box.css    merged and scoped automatically
    alert-box.ts     inlined and scoped via <script src="alert-box.ts"></script>
```

- A companion `.css` with the same base name is merged into the component's styles automatically.
- A companion script (`.ts`, `.js`, `.mjs`) is used only when the template references it with `<script src="alert-box.ts"></script>`. It is inlined, TypeScript-stripped, and scoped. Inline code inside that `<script src>` tag is dropped with a warning, matching the browser, so keep the code in the file.
- Companion paths resolve only within the component directory or by base file name.
- Pick one stylesheet pattern per component. Several `<style>` blocks, or a mix with a `.css` file, work but are harder to maintain.

## Multiple root elements

A template may have several top-level elements; they are inserted in order. Forwarded attributes from the usage tag land on the first root element.

## `@bascik` metadata comments

Document a component's public contract for editor hovers and completions with a leading comment:

```html
<!-- @bascik
Interactive demo box with Preview, Source, and Output panes.
@prop file - Monospace file path displayed in the meta bar.
@slot example - Content rendered in the live preview pane.
@slot default - Content for the un-named slot.
-->
<div class="demo-box">
  <div class="demo-meta" data-bascik-prop-file></div>
  <div data-bascik-slot="example"></div>
  <div data-bascik-slot></div>
</div>
```

- Place it before any markup, `<style>`, or `<script>`. Whitespace and ordinary comments may precede it.
- Markup is authoritative: `@prop` and `@slot` describe members that exist in the template; they cannot declare new ones.
- Syntax: `@prop <name> - <description>`, `@slot <name> - <description>`, `@slot default - <description>`.

## Slots

Slot content stays raw HTML, takes part in scoping, and may contain other components. Use slots, not props, for markup.

Default slot: put `data-bascik-slot` (no value) on an element. That element is replaced by the usage content. Its inner content is the fallback.

```html
<!-- my-card.html -->
<div class="card">
  <div data-bascik-slot><p>No content provided.</p></div>
</div>

<!-- usage -->
<my-card>
  <h2>Card Title</h2>
  <p>Card body text.</p>
</my-card>

<!-- output -->
<div class="bascik__my-card__card">
  <h2>Card Title</h2>
  <p>Card body text.</p>
</div>
```

Named slots: `data-bascik-slot="name"` in the template; wrap the content with the same attribute at the usage site. Content outside any named wrapper goes to the default slot.

```html
<!-- page-layout.html -->
<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
  <aside><div data-bascik-slot="sidebar"></div></aside>
</div>

<!-- usage -->
<page-layout>
  <p>Main body content.</p>
  <div data-bascik-slot="header"><h1>Page Title</h1></div>
  <div data-bascik-slot="sidebar"><nav>Sidebar nav</nav></div>
</page-layout>
```

- The wrapper at the usage site is removed. `<h1 data-bascik-slot="header">Title</h1>` produces `Title` with no `<h1>`, and an `<a>` loses its `href`. Always wrap in a `<div>`.
- Leading and trailing whitespace of slot content is trimmed; inner whitespace is kept.
- To forward a component's default content into an inner component, put a default slot marker between the inner tags: `<inner-box><div data-bascik-slot>fallback</div></inner-box>`.

## Props

```html
<!-- alert-box.html -->
<aside class="alert">
  <strong data-bascik-prop-title>Notice</strong>
  <p data-bascik-prop-message>Fallback text.</p>
</aside>

<!-- usage -->
<alert-box
  data-bascik-prop-title="Success"
  data-bascik-prop-message="Your changes were saved." />
```

- The prop value replaces the element's inner content; existing inner content is the fallback. The `data-bascik-prop-*` marker is removed; other attributes stay.
- Values are HTML-escaped on injection. Entity-encode quotes inside the usage attribute (`&quot;`, `&#39;`).
- Values are strings. Booleans and numbers arrive as text. Objects, arrays, and functions are not possible; print one component per item from a build script instead.
- Props are read only from the component's own opening tag; a nested component's props never leak upward.
- Prop names are lowercase with hyphens: `data-bascik-prop-alt-text`.

Send a prop to an attribute with `data-bascik-attr-{attribute}="{propName}"`:

```html
<img data-bascik-attr-src="image" data-bascik-attr-alt="alt">
<a data-bascik-attr-href="link">Read more</a>
```

The directive is removed. A missing prop adds no attribute. If the attribute already exists, the prop wins and Bascik warns. Bound `id`, `name`, and `class` values are scoped normally. A prop can drive content and an attribute at the same time.

## Attribute inheritance

Non-`data-bascik-*` attributes on the usage tag are merged onto the component's first root element (`scoping.inheritAttributes`, default `true`). `class` values are appended. `id` is forwarded unless the template root already has one.

```html
<!-- usage -->
<site-nav class="sticky" aria-label="Main navigation" />

<!-- site-nav.html -->
<nav class="nav"><a href="/">Home</a></nav>

<!-- output -->
<nav class="bascik__site-nav__nav sticky" aria-label="Main navigation">
  <a href="/">Home</a>
</nav>
```

Inherited classes are global unless the parent component defines them (see below).

## Styling a child component from its parent

A component's CSS applies only to markup in its own template. A parent selector like `nav a {}` never matches a child component's root. To style a child's root, put a class on the child's usage tag and define that class in the parent's CSS; Bascik scopes it to the parent and merges it onto the child root.

```html
<!-- site-nav.html (parent); site-nav.css defines .item { padding: 1em 0.5em; } -->
<nav>
  <nav-link class="item" href="/">Home</nav-link>
</nav>
<!-- output: <a class="bascik__site-nav__item" href="/">Home</a> -->
```

The same applies to child tags produced by a build script or a slot: put the class on each child usage tag.

## Self-closing tags and head components

Components without slot content use self-closing syntax: `<site-nav />`, `<site-nav class="top" />`.

Components work inside `<head>`. Extract the shared head once:

```html
<!-- src/components/site-head.html -->
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" href="/css/styles.css" />
```

```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <site-head />
  <title>Home - My Site</title>
  <meta name="description" content="Page-specific description." />
</head>
<body>
  <site-header />
  <main><h1>Welcome</h1></main>
  <site-footer />
</body>
</html>
```

Component styles are merged into the document `<head>`. A component cannot own `<html>`, `<head>`, or `<body>`.

## Literal tags are text

Component tag text inside `<script>`, `<style>`, `<textarea>`, or HTML comments (for example `<my-card>` inside a JSON-LD string) is never expanded. By default nothing inside `<code>` is transpiled either, so code samples stay literal.

## Third-party custom elements

Hyphenated tags with no component file (for example `<model-viewer>`, `heading-anchors`) pass through unchanged, but each one prints `Unresolved component tag` and shows up in `bascik --check`. Declare them:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  components: { external: ['heading-anchors', 'vendor-*'] },
});
```

Entries are exact names or `*` wildcards, case-insensitive. This changes diagnostics only: a real component with the same name still expands, and typos are still reported.

To ship an npm custom element: copy its ready-to-use module into `dist/` with a `phase: 'pre'` exec script (files in `node_modules` are never copied, and bare specifiers in client scripts are not rewritten), load it with `<script type="module" src="/assets/vendor/name.js">`, and declare the tag in `components.external`. Bundle it with esbuild instead when it imports other packages.

## Sharing components

`bascik add <package>` copies components from an installed npm package into the first component root. The copies are project files you commit. `bascik-lock.json` records hashes; unmodified files update on re-add, and locally modified files are never overwritten without `--force`. Name collisions abort the add.

For a monorepo, `directory.components` accepts an array of roots (for example `['../../shared/components', 'src/components']`). See the `bascik-config` skill.
