# Scoped Styles

Scoped styles namespace a component's CSS at build time, keeping its selectors and animations from leaking into the rest of the page.

## Where Scoped CSS Can Live

You can define component CSS in either of these places:

- one or more inline `<style>` tags inside the component HTML
- a paired `.css` file next to the component HTML

Both approaches are fully equivalent in functionality. At build time, Bascik extracts inline `<style>` tags from component HTML files, applies the full scoping pipeline, deduplicates the CSS across all instances on the page, and injects the compiled styles into the page `<head>`. Component markup in the `<body>` stays clean with no `<style>` tags left behind.

<!-- demo:style-hoisting-example -->
```html
<!-- src/components/site-card.html -->
<style>
  .card { padding: 20px; border: 1px solid #3a3d40; }
</style>
<article class="card">
  <div data-bascik-slot></div>
</article>

<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<body>
  <site-card><p>Card content</p></site-card>
</body>
</html>

<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__site-card__card { padding: 20px; border: 1px solid #3a3d40; }
  </style>
</head>
<body>
  <article class="bascik__site-card__card">
    <p>Card content</p>
  </article>
</body>
</html>
```

If a component contains multiple `<style>` tags or both a paired `.css` file and inline `<style>` tags, Bascik combines all stylesheets before scoping.

> **Readability & Maintainability:** While Bascik supports multiple `<style>` tags in a single component file, using multiple `<style>` tags (or mixing an inline `<style>` tag with a companion `.css` file) is not recommended for readability and maintainability. Choose one stylesheet pattern per component.

Use paired files for most components so the HTML and CSS stay easy to scan. Inline `<style>` tags are convenient when keeping a small component in a single file is preferred.

## CSS File Pairing

Scoped styles are defined in a `.css` file with the same name as the component, placed in the same directory:

```text
src/components/
  site-nav/
    site-nav.html
    site-nav.css  ← scoped to site-nav
```

## How Scoped Names Are Formed

Class names are scoped to the **component type** so every instance of the same component shares identical scoped class names. This is intentional: it allows Bascik to emit a single `<style>` block per component regardless of how many times it appears on the page.

ID and `name` attributes are scoped per **component instance** so multiple instances on the same page always have distinct DOM identifiers.

```text
class  →  bascik__<componentName>__<originalName>
id     →  bascik__<componentName>__<instanceId>__<originalName>
name   →  bascik__<componentName>__<instanceId>__<originalName>
```

In production builds (`minify.identifiers: true`, the default), these verbose names are hashed to short alphanumeric strings such as `b2Y4G9eD1K8b` for name compression. The HTML, CSS, and JavaScript are all rewritten with the same hashed names so they stay in sync. This is entirely a build-time transformation with no runtime overhead.

## Selector and animation lab

This component combines a class, an ID selector, bare `h3` and `p` selectors, a local custom property, a media query, and a keyframe animation. Inspect Source and Output to see Bascik rewrite them while the pulse runs in the preview.

<!-- demo:scope-lab-usage -->
```html
<scope-lab />
```

<!-- demo:scope-lab-html -->
```html
<section class="scope-lab">
  <span class="scope-lab-pulse" id="signal" aria-hidden="true"></span>
  <div>
    <h3>Scoped selectors are active</h3>
    <p>Bare element selectors, keyframes, and custom properties stay inside this component.</p>
  </div>
</section>
```

<!-- demo:scope-lab-css -->
```css
.scope-lab {
  --signal-color: #d3ff8d;
  display: flex;
  gap: 16px;
}

.scope-lab-pulse {
  background: var(--signal-color);
  animation: scope-pulse 1.6s ease-in-out infinite;
}

#signal {
  outline: 3px solid color-mix(in srgb, var(--signal-color) 22%, transparent);
}

h3 { color: #f0f1f2; }
p { color: #8d929e; }

@keyframes scope-pulse {
  50% { opacity: 0.35; transform: scale(0.72); }
}

@media (max-width: 600px) {
  .scope-lab { align-items: flex-start; }
}
```

<!-- demo:scope-lab-output-html -->
```html
<section class="bascik__scope-lab__scope-lab">
  <span class="bascik__scope-lab__scope-lab-pulse bascik__scope-lab__id__signal"
        id="bascik__scope-lab__a1b2__signal" aria-hidden="true"></span>
  <div>
    <h3 class="bascik__scope-lab__el__h3">Scoped selectors are active</h3>
    <p class="bascik__scope-lab__el__p">Bare element selectors stay local.</p>
  </div>
</section>
```

<!-- demo:scope-lab-output-css -->
```css
.bascik__scope-lab__scope-lab {
  --bascik__scope-lab__signal-color: #d3ff8d;
}

.bascik__scope-lab__scope-lab-pulse {
  background: var(--bascik__scope-lab__signal-color);
  animation: bascik__scope-lab__keyframe__scope-pulse 1.6s ease-in-out infinite;
}

.bascik__scope-lab__id__signal {
  outline: 3px solid color-mix(in srgb, var(--bascik__scope-lab__signal-color) 22%, transparent);
}

.bascik__scope-lab__el__h3 { color: #f0f1f2; }
.bascik__scope-lab__el__p { color: #8d929e; }

@media (max-width: 600px) {
  .bascik__scope-lab__scope-lab { align-items: flex-start; }
}
```

## Class Scoping

Every class name in the `.css` file is prefixed with a unique instance ID. The corresponding HTML attributes are updated to match.

Both demos on this page show the source class names under Source and their rewritten names under Output.

## Global Utility & Accessibility Classes

Class names in a component's HTML template are only scoped if they are declared in the component's stylesheet (`.css` file or inline `<style>` block).

If a class name is **not** defined in the component's CSS, Bascik leaves it unscoped. This allows global utility classes (such as `skip-link`, `flex`, `hidden`, or global design tokens) defined in your global stylesheet (e.g. `src/css/styles.css`) to pass through and match normally across any component.

```html
<!-- src/components/site-nav.html -->
<a href="#main-content" class="skip-link dnav-logo">Skip to main content</a>
```

```css
/* src/components/site-nav.css */
/* .dnav-logo is declared locally → Bascik scopes it */
.dnav-logo {
  display: inline-flex;
  align-items: center;
}
```

```css
/* src/css/styles.css (global stylesheet) */
/* .skip-link is NOT in site-nav.css → Bascik leaves it unscoped */
.skip-link {
  position: absolute;
  top: -100px;
}
.skip-link:focus {
  top: 16px;
}
```

```html
<!-- dist/index.html (compiled output) -->
<a href="#main-content" class="skip-link bascik__site-nav__dnav-logo">
  Skip to main content
</a>
```

## Element Selector Scoping

Bare element selectors like `p {}` or `h2 {}` are converted to generated class selectors and injected onto matching elements inside the component.

The selector and animation lab above uses this exact pattern. Its Source CSS contains bare selectors; its Output tabs show the generated classes in both CSS and HTML.

> **Isolation guarantee:** Element styles only affect elements inside the component. A `p {}` rule in `my-comp.css` will never affect `<p>` tags on the page or in other components.

## @media Support

Media queries work normally. Class names inside them are scoped like any other rule:

The selector and animation lab includes a mobile media query. Open Output → CSS to see its `.scope-lab` selector rewritten inside the unchanged `@media` wrapper.

## @keyframes Scoping

Keyframe names are also prefixed so animations from different components never collide:

The pulsing indicator in the lab is driven by `@keyframes scope-pulse`. Open Output → CSS to see the scoped keyframe name and rewritten `animation` declaration.

## CSS ID Selectors

CSS `#id` selectors are converted to scoped class selectors, and the generated class is injected onto the matching element in the HTML. This means `#btn {}` in a component is fully isolated, the same ID name in another component or on the page produces a completely different selector.

The lab styles `#signal`. Output → CSS shows its generated class selector; Output → HTML shows that class injected beside the per-instance scoped `id`.

> **Specificity note:** Converting `#id` to a class drops specificity from `(0,1,0,0)` to `(0,0,1,0)`. `[id]` and `[id="…"]` attribute-selector forms are stripped at compile time, use a class selector instead.

## CSS Custom Properties

`--var-name` declarations in a component's CSS are automatically scoped. All `var(--var-name)` references within the same file are updated to match, so custom properties stay isolated to their component.

The lab declares `--signal-color` and uses it for the animated indicator. Its Output CSS shows both the scoped declaration and rewritten `var()` reference.

> **Only locally-declared properties are scoped.** If a component uses `var(--global-var)` but doesn't declare `--global-var` in its own CSS, that reference is left untouched so it still resolves from a global stylesheet.

### Using global design tokens in a component

Define your design tokens once in a global stylesheet, then consume them inside any component. Because the component never declares those properties locally, Bascik leaves the `var()` references as-is and they resolve from the global stylesheet at render time.

```css
/* src/styles.css: design tokens, linked in every page <head> */
:root {
  --brand:     #d3ff8d;
  --card-bg:   #1e2022;
  --text-muted: #8d929e;
}
```

```html
<!-- src/components/brand-card.html -->
<style>
  .card {
    padding: 24px 28px;
    background: var(--card-bg);    /* global: Bascik leaves untouched */
    border-top: 3px solid var(--brand);
    border-radius: 10px;
  }
  .card-label {
    color: var(--text-muted);
  }
</style>
<div class="card">
  <p class="card-label" data-bascik-prop-label></p>
  <div data-bascik-slot></div>
</div>
```

```css
/* dist/ output: class names scoped, var() refs preserved */
.bascik__brand-card__card {
  padding: 24px 28px;
  background: var(--card-bg);
  border-top: 3px solid var(--brand);
  border-radius: 10px;
}
.bascik__brand-card__card-label {
  color: var(--text-muted);
}
```

## CSS @import

Bascik supports standard CSS `@import` statements in component CSS (`.css` files and inline `<style>` blocks):

- **Local file imports:** Local relative paths (e.g. `@import "./tokens.css"`, `@import "../shared/theme.css"`) are resolved and inlined recursively at build time. All selectors, custom properties, and keyframes inside imported stylesheets are automatically scoped to the component instance.
- **Remote URL imports:** External URLs (e.g. `@import "https://fonts.googleapis.com/..."`) are preserved and automatically hoisted to the top of the compiled stylesheet per W3C CSS specifications.
- **Conditions & Cascade Layers:** Optional conditions such as `layer(...)`, `supports(...)`, and media query lists attached to `@import` rules are fully preserved and wrapped around the inlined CSS.

## Toggling Scoping

All scoping can be controlled in [`bascik.config.ts`](/configuration):

```js
export default {
  scopeAttribute: {
    class: true, // scope class names
    id: true,    // scope id attributes
    name: true,  // scope name attributes
  },
};
```

> **MDN reference.** Scoped CSS changes how selectors are rewritten at build time, but the CSS you write is still normal CSS. Use [MDN's CSS reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference) as the primary source for selectors, at-rules, and properties.

## Class Selectors in Component Scripts

Because all instances of the same component share the same scoped class names (for CSS deduplication), `document.querySelector('.myClass')` inside a component script will always return the **first** matching element on the page, not necessarily the element belonging to the current instance. If you have multiple instances of the same component, each instance's script will target the same (first) element.

**The correct pattern** is to use an `id` attribute as your root anchor. `id` attributes are scoped per-instance, so `getElementById` always finds exactly the right element:

```html
<!-- my-comp.html -->
<div id="root" class="wrapper">
  <button id="btn">Click</button>
</div>

<script>
  const root = document.getElementById('root');  // ✓ unique per instance
  const btn  = root.querySelector('button');      // ✓ scoped to this instance
</script>
```

Avoid this anti-pattern:

```html
<div class="wrapper">
  <button class="btn">Click</button>
</div>

<script>
  // ✗ finds the FIRST .wrapper on the page - wrong for instance 2+
  const root = document.querySelector('.wrapper');
</script>
```

By default, all instances of the same component share identical scoped class names so Bascik can emit a single `<style>` block per component, regardless of how many times it appears on the page. If you genuinely need class selectors to be unique per instance (for example, to use `querySelector` safely across multiple instances), set `deduplicateCss: false`:

```js
export default {
  deduplicateCss: false, // each instance gets its own unique class names
};
```

### `deduplicateCss` Trade-Off Comparison

Setting `deduplicateCss` in `bascik.config.ts` controls whether class names are scoped per component type or per component instance.

> **Go deeper.** To understand how Bascik collects, scopes, and compiles CSS blocks at the parser level, check out the [CSS Deduplication internals guide](/internals/scoping-system#css-deduplication).

| Feature / Aspect | `deduplicateCss: true` (Default) | `deduplicateCss: false` |
| --- | --- | --- |
| **Class Scoping Scheme** | `bascik__card__wrapper` (shared per component) | `bascik__card__a1b2c3d4__wrapper` (unique per instance) |
| **CSS Payload** | Single `<style>` block per component type, zero CSS duplication | Multiplied `<style>` blocks (one block per component instance) |
| **`querySelector('.cls')` Behavior** | Targets the first instance on the page | Targets the matching element inside that specific instance |
| **Instance Isolation Model** | Use `id` + `getElementById()` for per-instance script isolation | Class selectors inherently isolate per instance |
| **Best For** | Virtually all production sites and design systems | Migrating legacy or third-party code that relies on class queries |

#### Side-by-Side Code Example

Given two instances of `<my-card>` on the same page:

```html
<!-- Input Page HTML -->
<my-card></my-card>
<my-card></my-card>
```

**Output with `deduplicateCss: true` (Default, Shared Class Scope):**

```html
<!-- HTML Output: Shared classes, unique IDs -->
<div class="bascik__my-card__wrapper" id="bascik__my-card__a1b2c3d4__root">...</div>
<div class="bascik__my-card__wrapper" id="bascik__my-card__e5f6g7h8__root">...</div>

<!-- CSS Output: Emitted once in <head> -->
<style>
  .bascik__my-card__wrapper { padding: 1rem; }
</style>
```

**Output with `deduplicateCss: false` (Per-Instance Class Scope):**

```html
<!-- HTML Output: Unique classes per instance -->
<div class="bascik__my-card__a1b2c3d4__wrapper" id="bascik__my-card__a1b2c3d4__root">...</div>
<div class="bascik__my-card__e5f6g7h8__wrapper" id="bascik__my-card__e5f6g7h8__root">...</div>

<!-- CSS Output: Emitted for every instance -->
<style>
  .bascik__my-card__a1b2c3d4__wrapper { padding: 1rem; }
  .bascik__my-card__e5f6g7h8__wrapper { padding: 1rem; }
</style>
```

Using the `id`-based pattern with `getElementById()` is recommended because it gives you per-instance JS isolation while keeping `deduplicateCss: true` for minimal CSS payload.

## Vendor Prefixing & BYOMinifier Post-Processing (PostCSS, LightningCSS)

Bascik's built-in CSS scoping pipeline is ultra-fast, zero-dependency, and lightweight. It handles selector scoping, custom property isolation, and whitespace minification out of the box.

Thanks to Bascik's **BYOMinifier (Bring Your Own Minifier)** feature, if your project requires browser vendor prefixing (such as `-webkit-` prefixes for Safari cross-browser compatibility) or advanced CSS transformations, you can plug custom CSS processors like **PostCSS with Autoprefixer** or **LightningCSS** directly into `minify.css` in `bascik.config.ts`.

### PostCSS with Autoprefixer

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';

export const build = defineConfig({
  minify: {
    css: async (css) => {
      const result = await postcss([autoprefixer]).process(css, { from: undefined });
      return result.css;
    },
  },
});
```

### LightningCSS

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';
import { transform } from 'lightningcss';

export const build = defineConfig({
  minify: {
    css: (css) => {
      const { code } = transform({
        filename: 'style.css',
        code: Buffer.from(css),
        minify: true,
        targets: { safari: (15 << 16) },
      });
      return code.toString();
    },
  },
});
```

When configured, Bascik runs your custom `minify.css` transformer on all scoped component `<style>` blocks, inlined global stylesheets, and static `.css` files during `bascik --build` and `bascik --server`.

## How Scoping Works

This guide focuses on the CSS behavior you write and observe. The compiler implementation is documented separately.

> **Under the hood.** Read the [Scoping System internals](/internals/scoping-system) for the scoping passes, generated attribute maps, selector transformations, and deduplication model.

## See it in action

Click the card to toggle its active state. Hover for the hover state. Both are isolated to this component.

### Source and output

**Source** (`my-card.html`, CSS, HTML, and JS in one file):

<!-- demo:source-usage -->
```html
<my-card>
  <h3>Isolated Styles</h3>
  <p>Click to toggle the active state.</p>
</my-card>
```

<!-- demo:source-html -->
```html
<style>
  .card {
    padding: 26px 28px;
    background: #242628;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;

    h3 { margin: 0 0 8px; color: #f0f1f2; }
    p  { margin: 0; color: #8d929e; }

    &:hover {
      border-color: rgba(211,255,141,0.35);
      box-shadow: 0 0 0 1px rgba(211,255,141,0.12);
    }

    &.active {
      background: rgba(211,255,141,0.07);
      border-color: rgba(211,255,141,0.5);
      box-shadow: 0 0 0 1px rgba(211,255,141,0.25), 0 0 20px rgba(211,255,141,0.08);

      h3 { color: #d3ff8d; }
    }
  }
</style>
<div class="card" id="card">
  <div data-bascik-slot></div>
</div>
<script>
  const card = document.getElementById('card');
  card.addEventListener('click', () => {
    card.classList.toggle('active');
  });
</script>
```

**Compiled output** (class names and IDs scoped, script wrapped in IIFE):

<!-- demo:output-html -->
```html
<style>
  .bascik__my-card__card {
    padding: 26px 28px;
    background: #242628;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 10px;
  }
  .bascik__my-card__card .bascik__my-card__el__h3 {
    margin: 0 0 8px;
    color: #f0f1f2;
  }
  .bascik__my-card__card .bascik__my-card__el__p {
    margin: 0;
    color: #8d929e;
  }
  .bascik__my-card__card:hover {
    border-color: rgba(211, 255, 141, 0.35);
    box-shadow: 0 0 0 1px rgba(211, 255, 141, 0.12);
  }
  .bascik__my-card__card.bascik__my-card__active {
    background: rgba(211, 255, 141, 0.07);
    border-color: rgba(211, 255, 141, 0.5);
    box-shadow: 0 0 0 1px rgba(211, 255, 141, 0.25), 0 0 20px rgba(211, 255, 141, 0.08);
  }
  .bascik__my-card__card.bascik__my-card__active .bascik__my-card__el__h3 {
    color: #d3ff8d;
  }
</style>
<div class="bascik__my-card__card" id="bascik__my-card__a1b__card">
  <h3>Isolated Styles</h3>
  <p>Click to toggle the active state.</p>
</div>
<script>
  (function(){
  const card = document.getElementById('bascik__my-card__a1b__card');
  card.addEventListener('click', () => {
    card.classList.toggle('bascik__my-card__active');
  });
  })();
</script>
```
