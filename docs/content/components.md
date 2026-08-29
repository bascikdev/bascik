# Components

Components are the core building block in Bascik. Each component is a `.html` file in `src/components/`. The file name becomes the tag name used in your pages and in other components.

## HTML-Only Components

The simplest component is just markup. No CSS, no JavaScript required.

<!-- demo:source-usage-hello -->
```html
<!DOCTYPE html>
<html lang="en">
<body>
  <hello-card />
</body>
</html>
```

<!-- demo:source-html-hello -->
```html
<article class="hello-card">
  <p class="hello-card-kicker">One file. One tag.</p>
  <h3 class="hello-card-title">Plain HTML, ready to reuse.</h3>
  <p class="hello-card-body">Bascik replaces the custom tag at build time and ships the finished markup.</p>
</article>
```

> **Styles omitted for clarity.** This demo component includes a companion `.css` file that styles the card. The CSS is not shown in the source view so the demo stays focused on the HTML structure. Note that output code examples across the documentation show unminified output (HTML, CSS, JS, and identifier names) for readability.

<!-- demo:output-html-hello -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__hello-card__hello-card {
      width: min(100%, 32rem);
      padding: 24px;
      background: var(--elevated);
      border: 1px solid var(--border);
      border-top: 3px solid var(--accent);
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <article class="bascik__hello-card__hello-card">
    <p class="bascik__hello-card__hello-card-kicker">One file. One tag.</p>
    <h3 class="bascik__hello-card__hello-card-title">Plain HTML, ready to reuse.</h3>
    <p class="hello-card-body">Bascik replaces the custom tag at build time and ships the finished markup.</p>
  </article>
</body>
</html>
```

Components can appear in other components too. If `site-layout.html` uses `<page-footer></page-footer>`, every page that uses `<site-layout>` gets the footer automatically.

## HTML with CSS

Add a `<style>` block to style the component inline. Bascik scopes the CSS to the component at build time so selectors from one component never affect another.

<!-- demo:source-usage-badge -->
```html
<comp-badge />
```

<!-- demo:source-html-badge -->
```html
<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: #d1fae5;
    color: #065f46;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .badge-dot {
    width: 6px;
    height: 6px;
    background: #10b981;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
<span class="badge">
  <span class="badge-dot"></span>
  All systems operational
</span>
```

<!-- demo:output-html-badge -->
```html
<span class="bascik__comp-badge__badge">
  <span class="bascik__comp-badge__badge-dot"></span>
  All systems operational
</span>
```

<!-- demo:output-css-badge -->
```css
.bascik__comp-badge__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #d1fae5;
  color: #065f46;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
}

.bascik__comp-badge__badge-dot {
  width: 6px;
  height: 6px;
  background: #10b981;
  border-radius: 50%;
  flex-shrink: 0;
}
```

> **More on the next page.** [Scoped Styles](/scoped-styles) covers exactly how class names and selectors are namespaced and what CSS patterns are supported.

## HTML with JavaScript

Add a `<script>` block for interactive behavior. Use `id` on any element you need to target from JS and reach it with `getElementById`.

<!-- demo:source-usage-toggle -->
```html
<comp-toggle />
```

<!-- demo:source-html-toggle -->
```html
<div class="toggle-wrap">
  <p>Bascik assembles components at build time and ships vanilla HTML files with no framework runtime.</p>
  <div id="detail" hidden>
    <p>No JavaScript is added to the page. Every script in the output was written by you.</p>
  </div>
  <button id="btn" type="button">Read more</button>
</div>
```

<!-- demo:source-js-toggle -->
```js
const btn = document.getElementById('btn');
const detail = document.getElementById('detail');
btn.addEventListener('click', () => {
  detail.hidden = !detail.hidden;
  btn.textContent = detail.hidden ? 'Read more' : 'Show less';
});
```

> **Styles omitted for clarity.** This demo component includes a companion `.css` file that styles the card. The CSS is not shown in the source view so the demo stays focused on the JavaScript. Note that output code examples across the documentation show unminified output (HTML, CSS, JS, and identifier names) for readability.

<!-- demo:output-html-toggle -->
```html
<div class="bascik__comp-toggle__toggle-wrap">
  <p class="bascik__comp-toggle__el__p">Bascik assembles components at build time and ships vanilla HTML files with no framework runtime.</p>
  <div id="bascik__comp-toggle__a1b__detail" hidden>
    <p class="bascik__comp-toggle__el__p">No JavaScript is added to the page. Every script in the output was written by you.</p>
  </div>
  <button class="bascik__comp-toggle__el__button" id="bascik__comp-toggle__a1b__btn" type="button">Read more</button>
</div>
<script>
  (function(){
  const btn = document.getElementById('bascik__comp-toggle__a1b__btn');
  const detail = document.getElementById('bascik__comp-toggle__a1b__detail');
  btn.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    btn.textContent = detail.hidden ? 'Read more' : 'Show less';
  });
  })();
</script>
```

<!-- demo:output-css-toggle -->
```css
.bascik__comp-toggle__toggle-wrap {
  padding: 24px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r);
  max-width: 420px;
}

.bascik__comp-toggle__toggle-wrap .bascik__comp-toggle__el__p {
  color: var(--text-muted);
  margin: 0 0 16px;
}

.bascik__comp-toggle__toggle-wrap .bascik__comp-toggle__el__button {
  display: inline-block;
  padding: 8px 18px;
  background: var(--accent);
  color: #18191b;
  border: none;
  border-radius: var(--r-sm);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}
```

> **See also.** [Scoped JavaScript](/scoped-javascript) explains how Bascik rewrites selectors so multiple instances of the same component on the same page stay fully independent.

## HTML, CSS, and JavaScript Together

All three can live in a single file. A `<style>` block, the markup, and a `<script>` block in any order; Bascik handles all of them.

<!-- demo:source-usage-alert -->
```html
<comp-alert />
```

<!-- demo:source-html-alert -->
```html
<style>
  .alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid #f59e0b;
    border-radius: 8px;
    background: #fffbeb;
  }
  .alert-body {
    flex: 1;
    margin: 0;
    font-size: 0.9rem;
    color: #92400e;
  }
  .alert-close {
    background: none;
    border: none;
    cursor: pointer;
    color: #b45309;
    font-size: 1.2rem;
    line-height: 1;
    padding: 0;
  }
</style>
<div class="alert" id="alert">
  <p class="alert-body">Scheduled maintenance Sunday, 2am–4am UTC.</p>
  <button id="close" class="alert-close" aria-label="Dismiss">×</button>
</div>
<script>
  document.getElementById('close').addEventListener('click', () => {
    document.getElementById('alert').hidden = true;
  });
</script>
```

<!-- demo:output-html-alert -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__comp-alert__alert {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid #f59e0b;
      border-radius: 8px;
      background: #fffbeb;
    }
    .bascik__comp-alert__alert-body {
      flex: 1;
      margin: 0;
      font-size: 0.9rem;
      color: #92400e;
    }
    .bascik__comp-alert__alert-close {
      background: none;
      border: none;
      cursor: pointer;
      color: #b45309;
      font-size: 1.2rem;
      line-height: 1;
      padding: 0;
    }
  </style>
</head>
<body>
  <div class="bascik__comp-alert__alert" id="bascik__comp-alert__a1b__alert">
    <p class="bascik__comp-alert__alert-body">Scheduled maintenance Sunday, 2am–4am UTC.</p>
    <button id="bascik__comp-alert__a1b__close" class="bascik__comp-alert__alert-close" aria-label="Dismiss">×</button>
  </div>
  <script>
    (function(){
      document.getElementById('bascik__comp-alert__a1b__close').addEventListener('click', () => {
        document.getElementById('bascik__comp-alert__a1b__alert').hidden = true;
      });
    })();
  </script>
</body>
</html>
```

<!-- demo:output-css-alert -->
```css
.bascik__comp-alert__alert {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  background: #fffbeb;
}

.bascik__comp-alert__alert-body {
  flex: 1;
  margin: 0;
  font-size: 0.9rem;
  color: #92400e;
}

.bascik__comp-alert__alert-close {
  background: none;
  border: none;
  cursor: pointer;
  color: #b45309;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0;
}
```

## Companion CSS and Script Files

Choosing between inline `<style>` or `<script>` blocks and companion `.css` or `.ts`/`.js`/`.mjs` files is a matter of personal preference.

Create a `.css` file or companion script files alongside the `.html` file if you prefer to keep your styles or JavaScript separate. Companion `.css` files in the same component directory are merged automatically. Companion script files explicitly referenced via `<script src="counter.ts"></script>` are resolved, inlined, and scoped at build time.

> **Directory Isolation Rule:** Path resolution for companion files is strictly scoped to the component's directory or base filename. A component inside `src/components/demo-counter/` can only reference script or style files located inside its own folder. It cannot access files across other component directories.

<!-- demo:source-usage-card -->
```html
<feature-card
  data-bascik-prop-title="Build-time Components"
  data-bascik-prop-desc="Bascik resolves tags and ships vanilla HTML.">
</feature-card>
```

<!-- demo:source-html-card -->
```html
<div class="fcard">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-desc></p>
</div>
```

<!-- demo:source-css-card -->
```css
.fcard {
  padding: 24px;
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;

  h3 { color: #f0f1f2; }
  p  { font-size: 0.875rem; color: #8d929e; }

  &:hover {
    border-color: rgba(211,255,141,0.35);
    box-shadow: 0 0 0 1px rgba(211,255,141,0.12);
  }
}
```

<!-- demo:output-html-card -->
```html
<div class="bascik__feature-card__fcard">
  <h3>Build-time Components</h3>
  <p>Bascik resolves tags and ships vanilla HTML.</p>
</div>
```

<!-- demo:output-css-card -->
```css
.bascik__feature-card__fcard {
  padding: 24px;
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
}

.bascik__feature-card__fcard .bascik__feature-card__el__h3 {
  color: #f0f1f2;
}

.bascik__feature-card__fcard .bascik__feature-card__el__p {
  font-size: 0.875rem;
  color: #8d929e;
}

.bascik__feature-card__fcard:hover {
  border-color: rgba(211,255,141,0.35);
  box-shadow: 0 0 0 1px rgba(211,255,141,0.12);
}
```

## Subfolder Layout

For components with multiple files, a subfolder keeps things tidy. Name the subfolder and the files inside it the same:

```text
src/components/
  feature-card/
    feature-card.html
    feature-card.css
```

Bascik derives the tag name from the `.html` filename, not the folder. `feature-card/feature-card.html` still produces `<feature-card>`.

> **No restart needed.** The dev server watches `src/components/` for new and changed files. Drop in a new `.html` or `.css` file and all affected pages re-transpile and reload automatically.

## File Structure Flexibility

Bascik gives you complete freedom to structure your components however you prefer. You can mix and match different layouts across your project depending on the size and complexity of each component:

1. **HTML-only file:** Just a `.html` file inside `src/components/`. No CSS/JS files needed.
2. **Single-file component:** An `.html` file inside `src/components/` containing both your markup and `<style>`/`<script>` blocks.
3. **Companion files in the root:** An `.html` file and a `.css` file side-by-side in `src/components/` (e.g. `src/components/my-card.html` and `src/components/my-card.css`).
4. **Subfolder organization:** A folder inside `src/components/` containing the matching files (e.g. `src/components/my-card/my-card.html` and `src/components/my-card/my-card.css`).

You can choose any of these arrangements at any time. There is **no functionality or performance difference** between them. At build time, Bascik treats them identically, extracting and scoping your styles and bundling them into the page's final compiled output.

## Component Naming and Hyphens

Under the **WHATWG HTML standard (§4.13.1.2)**, custom elements must contain at least one hyphen (such as `<site-nav>`, `<hello-card>`, or `<my-button>`).

Naming your components with hyphens ensures they never collide with native HTML tags or future web standards. Bascik's CLI compiler and the official Bascik VS Code Extension validate component names at build time and in your editor:

- If a component shares the name of a native HTML element (such as `header.html` or `dialog.html`), Bascik issues a build-time warning indicating that it may collide with standard HTML elements.
- If a component filename is not hyphenated (such as `card.html`), Bascik compiles it for backward compatibility, but issues a warning recommending a hyphenated name like `my-card.html` or `site-card.html`.

Always use lowercase hyphenated filenames in `src/components/` (e.g. `src/components/feature-card.html` for `<feature-card>`).

## Multiple Root Elements

Unlike traditional JavaScript frameworks (such as React or Vue 2) that historically required a single root wrapper element or explicit fragment components, Bascik component templates naturally support **multiple top-level HTML elements** in a single `.html` file.

```html
<h2>Section Heading</h2>
<p class="intro">Introductory paragraph text.</p>
<div class="card">Card content</div>
```

When transpiled, all root-level elements are inserted directly into the page markup in order. No unnecessary wrapper `<div>` or `<Fragment>` tags are added to your rendered HTML. Bascik's scoping engine automatically handles CSS rules, class names, IDs, element selectors, and scripts across every element in the component template.

> **Attribute Inheritance:** If non-`data-bascik-*` attributes are passed on a usage tag (such as `class="extra"` or `aria-label="Section"`), Bascik merges them onto the **first** root HTML element in the component template.

## Void / Self-Closing Component Tags

When utilizing your components inside pages or other components, you can use standard opening and closing tags, or you can use self-closing/void syntax:

```html
<!-- Standard paired tags -->
<site-nav></site-nav>

<!-- Void (self-closing) syntax -->
<site-nav />
```

If your component does not use a `<slot>` to accept inner children, you can choose to use it as a void/self-closing component. Both forms are fully supported and compile to the exact same output, with no difference in behavior or performance. You can choose whichever style matches your personal preference or project guidelines.

## Component Structure & Tag Ordering

When writing component files containing both styles and scripts alongside HTML, always place `<style>` tags above the HTML markup as a style guide, and always place `<script>` tags below the HTML markup.

## Multiple Style Blocks

You can include multiple `<style>` blocks in a single component file. For example, you can organize styles into separate blocks for general layout, media queries, or themes.

```html
<style>
  .card { padding: 16px; background: #1a1b1e; }
</style>

<div class="card">
  <h3>Card Title</h3>
</div>

<style media="(min-width: 768px)">
  .card { padding: 24px; }
</style>
```

At build time, Bascik extracts every `<style>` block from the component file, combines them with any companion `.css` file, applies class and selector scoping, and injects the resulting CSS into the document `<head>`.

> **Readability & Maintainability:** While Bascik supports multiple `<style>` tags in a single component file, using multiple `<style>` tags (or mixing an inline `<style>` tag with a companion `.css` file) is not recommended for readability and maintainability. Choose a single stylesheet pattern per component.

## Multiple Script Blocks

Component templates can also contain multiple `<script>` tags. Bascik handles each script according to its type and attributes:

- **Client scripts:** Standard JavaScript blocks (without `data-bascik-server` or `data-bascik-build`) are each wrapped in an isolated IIFE `(function() { ... })();`. You can include multiple client scripts in a component template, and each receives its own scope so local variables do not bleed into other blocks.
- **Build scripts (`<script data-bascik-build>`):** Executed during build or dev time in Node.js, replacing the tag with its stdout. Multiple build scripts execute concurrently.
- **Server scripts (`<script data-bascik-server>`):** Executed on the server at request time in Node.js. They are not wrapped in browser IIFEs.
- **Data scripts (e.g., `type="application/ld+json"`):** Preserved intact without IIFE wrapping or JavaScript minification.

> **Clean Code Recommendation:** Using separate `<script>` tags for distinct, unrelated concerns within a component (for example, a modal controller vs. an analytics handler) is recommended for code readability and maintainability. Because Bascik wraps each client script in its own IIFE, local variables stay safely isolated without polluting a single monolithic script block. Avoid splitting closely related code for no reason, but use separate `<script>` tags whenever a component handles multiple independent interactive features.
