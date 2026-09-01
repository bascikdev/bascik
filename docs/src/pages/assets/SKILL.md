---
name: bascik
description: Comprehensive guide for building with Bascik, a file-based web component framework. Use when creating components, writing scoped CSS or JavaScript, configuring props or slots, using the CLI, setting up the build, or debugging Bascik-specific behavior.
---

# Bascik Developer & Usage Copilot Skill (`SKILL.md`)

This file contains the **complete, centralized documentation and development skill guide** for Bascik. It is designed to provide Copilot and external developers with everything needed to build, compile, maintain, and write components for the Bascik project.

**Note on Code & Script Examples:** Code examples throughout this skill guide demonstrate patterns, capabilities, and API structures. Adapt file paths, script names, tag names, and configuration values to match the specific project requirements rather than copying illustrative names literally.

---

## 1. What Bascik Is & Does

> Bascik is a build tool for HTML components. It scopes and assembles reusable HTML component files into vanilla HTML pages at build time. It adds zero JavaScript to the output. You write HTML, CSS, and JavaScript; Bascik scopes and assembles them.

* **Resolves custom HTML tags** (e.g. `<my-nav></my-nav>`) to their component source HTML at build time.
* **Scopes CSS class names, element selectors, `@keyframes`, and CSS custom properties** per component so they never collide.
* **Rewrites DOM selector calls** (`getElementById`, `querySelector`, etc.) in component scripts to match scoped attribute names.
* **Wraps component scripts in IIFEs** so variables do not leak between components.
* **Outputs a `dist/` directory of plain `.html` files** with zero runtime dependencies and no client-side JS added by Bascik itself.

### What Bascik Does NOT Do
* It is not a JavaScript framework. There is no virtual DOM, no reactive state, no client-side routing.
* It does not add any JavaScript to pages. Every script in the output was written by you.
* It does not require Web Components, Shadow DOM, or any browser-specific API.

### End-to-End Example: Input → Output

One component file, its usage, and the scoped build output:

```html
<!-- src/components/my-card.html -->
<style>
  .card {
    padding: 26px 28px;
    border: 1px solid #3a3d40;
    border-radius: 10px;
    &.active { border-color: #d3ff8d; }
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

```html
<!-- src/pages/index.html -->
<my-card>
  <h3>My Card</h3>
  <p>Any HTML goes inside as slot content.</p>
</my-card>
```

```html
<!-- dist/index.html - classes and selectors scoped, script wrapped in IIFE -->
<style>
  .bascik__my-card__card {
    padding: 26px 28px;
    border: 1px solid #3a3d40;
    border-radius: 10px;
    &.bascik__my-card__active { border-color: #d3ff8d; }
  }
</style>
<div class="bascik__my-card__card" id="bascik__my-card__a1b__card">
  <h3>My Card</h3>
  <p>Any HTML goes inside as slot content.</p>
</div>
<script>
  (function () {
    const card = document.getElementById('bascik__my-card__a1b__card');
    card.addEventListener('click', () => {
      card.classList.toggle('bascik__my-card__active');
    });
  })();
</script>
```

Because IDs are scoped per instance, the same component can appear multiple times on one page and each instance's JS stays fully isolated. Plain `getElementById` / `querySelector` calls just work.


### How Bascik Compares to Other Tools
* **Vanilla HTML with Build-Time Components:** Bascik is built for content sites, landing pages, and documentation portals where shipping 80+ KB of React or framework runtime is unnecessary.
* **Contrast with Svelte:** Svelte compiles to a JavaScript runtime for reactive DOM management. Bascik compiles to plain HTML with zero runtime added.
* **Complements HTMX and Alpine.js:** Bascik resolves components at build time, while HTMX and Alpine add behavior at runtime. They compose cleanly together.
* **Contrast with Eleventy / Hugo / Jekyll:** Those tools focus on content pipelines (Markdown collections and template engines). Bascik focuses on HTML page composition and component reuse without a template language.

### Source Vocabulary and Browser Compatibility
* The custom component tags in a Bascik project are the components the developer creates; Bascik does not provide a framework-owned component catalog.
* Build instructions such as `data-bascik-slot`, `data-bascik-prop-*`, and `data-bascik-build` use HTML's standards-valid `data-*` extension mechanism.
* Bascik consumes those instructions at build time. They are not runtime directives that require a client library to interpret them.
* **Tag structure ordering rule:** When writing component files containing both styles and scripts alongside HTML, always place `<style>` tags above the HTML markup as a style guide, and always place `<script>` tags below the HTML markup.

### Repository Layout and the Create App

The repo is split into four top-level folders:

```text
bascik/
  pkg/          ← the @bascik/bascik npm package
  create/       ← the standalone generator used by `npm create bascik@latest`
  docs/         ← the docs site and internal developer guide
  extensions/   ← editor tooling, including the VS Code extension for component navigation and scoping checks
```

The `create/` folder is intentionally separate from `pkg/`. Contributor work in this monorepo uses Yarn 4 with `yarn.lock`, while generated projects intentionally use npm and receive their own `package-lock.json`. That split keeps contributor workflows Yarn-based while preserving the standard npm onboarding flow for generated apps.

The editor package in `extensions/vscode-bascik/` is intentionally separate from `pkg/`. It provides command-click component resolution and warnings for patterns that are unsupported or risky under Bascik's scoping model. The rules are generated from the compatibility matrix in `docs/content/compatibility.md` via `docs/scripts/generate-compatibility-rules.ts`, so the editor and the published capability table stay in sync automatically instead of drifting apart.

The generator in `create/src/index.ts` validates input, then calls `create/src/scaffold.ts` to write the project files. The generated app is not coupled to the monorepo layout. It just uses the published `@bascik/bascik` package and then runs as a normal Bascik site.

For local contributor testing of the generator itself, rebuild from `create/`, link it with `npm link`, and invoke it via `npx create-bascik ...`; that remains the working flow for exercising the local scaffold end-to-end. `npm link` runs the `prepare` script, which copies the latest SKILL.md from `docs/` and rebuilds `dist/` automatically, so no separate build step is needed after a fresh checkout.

---

## 2. Component Format

A component is one `.html` file inside `src/components/`. Its tag name is derived from the file name.

### Component Naming Conventions
Under the **WHATWG HTML standard (§4.13.1.2)**, custom elements should contain at least one hyphen (such as `<site-nav>`, `<hello-card>`, or `<my-button>`).
* Single-word component filenames (e.g., `card.html`) compile for backward compatibility, but Bascik's CLI compiler and VS Code extension issue warnings encouraging a hyphenated name (`my-card.html`).
* Filenames matching native HTML elements (e.g., `header.html` or `dialog.html`) issue a shadowing warning.
* Always use lowercase hyphenated filenames in `src/components/` (e.g., `src/components/feature-card.html` for `<feature-card>`).

**HTML-only component:**
```html
<!-- src/components/page-footer.html -->
<footer>
  <p>© 2025 My Site. All rights reserved.</p>
</footer>
```

**HTML with inline CSS:**
```html
<!-- src/components/promo-banner.html -->
<style>
  .banner { padding: 1rem 1.5rem; background: #e8f4fd; border-left: 4px solid #3b82f6; }
</style>
<aside class="banner">…</aside>
```

**HTML with inline JavaScript** (use `id` + `getElementById` for per-instance targeting):
```html
<!-- src/components/scroll-top.html -->
<button id="btn" type="button">Back to top</button>
<script>
  document.getElementById('btn').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
</script>
```

**All three in one file** (HTML + `<style>` + `<script>`):
```html
<!-- src/components/alert-box.html -->
<style>
  .alert { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; border: 1px solid #f59e0b; border-radius: 6px; background: #fffbeb; }
  .alert-close { margin-left: auto; background: none; border: none; cursor: pointer; }
</style>
<div class="alert" id="alert">
  <span>Maintenance on Sunday, 2am–4am UTC.</span>
  <button id="close" class="alert-close" aria-label="Dismiss">×</button>
</div>
<script>
  document.getElementById('close').addEventListener('click', () => {
    document.getElementById('alert').hidden = true;
  });
</script>
```

Use it in any page or other component:
```html
<alert-box></alert-box>
```
*Self-closing tags are also supported:* `<site-nav />` or `<site-nav class="top" />`

**Separate CSS file:** pair a `.css` file with the same base name:
```
src/components/
  alert-box.html
  alert-box.css   ← scoped to alert-box
```

**Subfolder layout** (same tag name regardless of folder):
```
src/components/
  alert-box/
    alert-box.html
    alert-box.css
    alert-box.ts    ← inlined and scoped via <script src="alert-box.ts"></script>
```

### Companion CSS and Script Files
Companion `.css` files in the component directory are merged automatically. Companion script files (`.ts`, `.js`, `.mjs`) explicitly referenced via `<script src="counter.ts"></script>` inside component HTML are resolved, inlined, and scoped at build time. Path resolution is strictly scoped to the component directory or base filename.

### Component Decomposition & Shared Head Tags
When structuring or migrating a site with Bascik, identify repeating HTML structures (especially shared `<head>` markup such as meta charset, viewport, favicons, fonts, Open Graph tags, and global CSS links, as well as site headers/footers) and extract them into reusable components.

Component tags can be placed inside `<head>` element blocks in your page shells:

```html
<!-- src/components/site-head.html -->
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" href="/styles.css" />
```

Page shells can then include `<site-head />` inside their `<head>`:

```html
<!-- src/pages/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <site-head />
  <title>Home - My Site</title>
</head>
<body>
  <site-nav />
  <main>
    <h1>Welcome</h1>
  </main>
  <site-footer />
</body>
</html>
```

At build time, Bascik expands `<site-head>` inside `<head>` and merges any component styles into the document `<head>` naturally. Proactively extract shared head elements, site headers, and site footers whenever initializing or refactoring a site into Bascik.

### Multiple Root Elements
Unlike other frameworks that require a single wrapper element or fragment, Bascik component templates support multiple top-level HTML elements in a single `.html` file. All root elements are inserted in order. If non-`data-bascik-*` attributes are passed on a usage tag, Bascik merges them onto the first root HTML element.

**No restart needed.** The dev server watches the components directory. Drop a new `.html` (or paired `.css`) file in and all pages that use that tag are automatically re-transpiled and reloaded with no server restart required.

---

## 3. Scoped CSS

Scoped CSS can live in a paired `.css` file or one or more inline `<style>` tags inside component HTML. Both go through the same scoping pipeline.

At build time, Bascik extracts all inline `<style>` blocks, combines them with any companion `.css` file, scopes them, and injects them into the document `<head>`. Using multiple `<style>` tags (or mixing them with a companion `.css` file) is supported but not recommended for readability and maintainability. Choose a single stylesheet pattern per component.

### Global Class Passthrough
Bascik checks whether a class name in a component template is defined in the component's CSS (paired `.css` or inline `<style>`). Only class names defined in the component's stylesheet are scoped (prefixed/hashed). Classes in component HTML that are NOT defined in the component's stylesheet (such as global utility classes like `skip-link`, `flex`, `hidden`, or design system classes) pass through as unscoped global classes so global stylesheets continue to match them.

Pair a `.css` file alongside the HTML in a same-named directory:

```
src/components/
  site-nav/
    site-nav.html
    site-nav.css
```

All class names, element selectors, `#id` selectors, `@keyframes`, `@layer`, `@container`, `:is()/.class`, `:where()/.class`, `:has()/.class`, child/sibling combinator selectors, and CSS custom properties in component CSS are automatically scoped to that component. SVG elements with `class` attributes inside component HTML are also scoped. CSS `#id` selectors are converted to generated class selectors and the class is injected on the matching HTML element.

`html`, `body`, and `head` are **never** converted to scoped classes. Cross-boundary selectors like `html[data-theme="light"] .foo {}` compile correctly: the root element name is preserved verbatim and only `.foo` is scoped, producing `html[data-theme="light"] .bascik__comp__foo {}`. This means theme-switching, dark/light mode, and other document-root state selectors in component CSS work as expected.

These rewrites compose normally in one component: bare element selectors receive generated classes, locally declared custom properties and their `var()` references are renamed together, and keyframe declarations stay synchronized with `animation` references.

```css
/* site-nav.css: source */
.nav a {
  color: white;
}
p {
  margin: 0;
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

```css
/* compiled output */
.bascik__site-nav__nav a { color: white; }
.bascik__site-nav__el__p { margin: 0; }
@keyframes bascik__site-nav__keyframe__fade { ... }
```

### Scoped CSS Custom Properties
CSS custom properties declared in the file are also scoped. `var(--prop, fallback)` with fallback values is fully supported, the property name is scoped and the fallback preserved:

```css
/* source */
:root {
  --brand: #d3ff8d;
}
.title {
  color: var(--brand);
  border-color: var(--brand, rgb(150, 150, 150)); /* fallback preserved */
}

/* compiled */
:root {
  --bascik__site-nav__brand: #d3ff8d;
}
.bascik__site-nav__title {
  color: var(--bascik__site-nav__brand);
  border-color: var(--bascik__site-nav__brand, rgb(150, 150, 150));
}
```

#### Using global design tokens in a component
Define your design tokens once in a global stylesheet, then consume them inside any component. Because the component never declares those properties locally, Bascik leaves the `var()` references as-is and they resolve from the global stylesheet at render time.

```css
/* src/styles.css: design tokens, linked in every page <head> */
:root {
  --brand: #d3ff8d;
  --card-bg: #1e2022;
  --text-muted: #8d929e;
}
```

```html
<!-- src/components/brand-card.html -->
<style>
  .card {
    padding: 24px 28px;
    background: var(--card-bg); /* global: Bascik leaves untouched */
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

### CSS Scoping Compatibility Notes
* CSS nesting: fully supports explicit `&` nesting (`& p`, `& > h2`, `&>h2`) and 2023 W3C relaxed direct nesting without `&` (`> h2`, `+ li`, `~ span`, direct nested element selectors)
* `@property`: `@property --name { }` declaration names are scoped along with any matching `--name:` declarations and `var(--name)` references in the same component
* `@starting-style`: class names and element selectors inside `@starting-style` blocks are scoped by the same passes that handle other at-rules; both standalone `@starting-style { .foo { } }` and nested `.foo { @starting-style { } }` forms work
* `@counter-style`: `@counter-style name { }` declaration names are scoped; references in `list-style`, `list-style-type`, `counter(counter, name)`, and `counters(counter, sep, name)` in the same CSS file are updated to match
* `view-transition-name`: ✓ values are scoped per component (`bascik__<comp>__vtn__<name>`); matching `::view-transition-old/new/group/image-pair()` pseudo-element references in the same file are updated; `none` and `auto` are not scoped
* `anchor-name` / `@position-try`: `anchor-name: --name` declarations are scoped per component; matching `position-anchor: --name` references and `@position-try --name { }` at-rules in the same CSS file are updated to match; only anchors declared in the component's own CSS are scoped
* `@scope` (native): class names in `@scope (.foo)` argument and optional `to (.clause)` are scoped normally, and class names inside the `@scope` block are scoped
* `:nth-child(An+B of .selector)`: class names in the `of <selector>` argument are scoped (same global `(?<=\.)` pass as `:is()`, `:where()`, `:has()`); works for `:nth-child` and `:nth-last-child`
* `@font-face`: passed through untouched; declare in a shared stylesheet to avoid duplicate injections
* `@import`: local file imports (`@import "./file.css"`) are inlined recursively and scoped to the component; remote URLs (`@import "https://..."`) are preserved and hoisted to the top of the compiled stylesheet
* Standalone attribute selectors (e.g. `[data-state]`): not scoped and can leak globally; anchor with a scoped class: `.card[data-state]`
* `[id]` selectors: `[id]` and `[id="..."]` attribute selectors in CSS are stripped at compile time because they cannot be scoped without DOM wrapping
* Compound element selectors: `.class element {}` and `.class > element {}` are scoped (element converted to class and injected on matching HTML elements); patterns with two bare elements (`div p {}`) still require a class anchor on the left
* Element names inside `:is()`, `:where()`, and `:has()` are not converted; use class selectors inside those pseudo-classes instead

---

## 4. Scoped JavaScript

**Key rule:** Use `id` attributes to identify elements you need to control per-instance, and `getElementById` to find them. Bascik rewrites selector strings at build time, you write your component as if it's the only one on the page.

DOM selectors in component scripts are rewritten to match scoped names:

```html
<!-- source -->
<button id="my-btn">Click</button>
<script>
  document
    .getElementById("my-btn")
    .addEventListener("click", () => alert("hi"));
</script>
```

```html
<!-- compiled -->
<button id="bascik__my-btn__a1b2__my-btn">Click</button>
<script>
  (function () {
    document
      .getElementById("bascik__my-btn__a1b2__my-btn")
      .addEventListener("click", () => alert("hi"));
  })();
</script>
```

### Supported DOM Methods (auto-rewritten)
* `document.getElementById("id")`
* `document.querySelector("#id")` / `document.querySelectorAll("#id")`
* `document.querySelector(".cls")` / `document.querySelectorAll(".cls")`: single OR compound selectors
* `document.querySelector(".foo .bar")` / `querySelector("#id .child")`: compound selectors supported
* `document.getElementsByClassName("cls")`
* `document.getElementsByName("name")`
* `element.closest("#id")` / `element.closest(".cls")`: compound-aware
* `element.matches("#id")` / `element.matches(".cls")`: works for event delegation too
* `element.classList.add/remove/toggle/contains("cls")`: all single and multi-argument forms
* `element.classList.replace("old", "new")`: both arguments rewritten
* `element.setAttribute("class", "cls")` / `setAttribute("id", "id-value")` / `setAttribute("name", "value")`: string literal values
* `element.className = "cls"` or `"cls1 cls2"` or `+= " cls"`: setter forms; space-separated multi-class strings fully rewritten
* `innerHTML` / `insertAdjacentHTML` string literals, known class names inside the HTML string are rewritten
* `removeAttribute`, `hasAttribute`, `toggleAttribute`: take attribute names (not values), no rewriting needed
* **JS-only class discovery:** class names referenced in `classList.*`, `.className` in selector strings, `el.className = "..."`, and `setAttribute("class", "...")` are automatically discovered and added to the class scope map before JS rewriting.

### Not Rewritten (known limitations)
* `el.id = "value"`: property setter not rewritten; use `getElementById` then work from the reference
* `el.style.setProperty("--my-var", value)`: runtime CSS custom property names are not rewritten; the scoped var name (e.g. `--bascik__comp__my-var`) is different from the source name
* Template literals: `` el.className = `box ${state}` ``, not rewritten; use `classList.add/remove` instead
* Template-literal replacement arguments in `classList.replace(oldName, \`${dynamic}\`)` are not rewritten safely; prefer `classList.add/remove/toggle` with static class names
* `querySelector("[name='username']")`: attribute-selector form for `name`; use `getElementsByName` instead
* `innerHTML` / `insertAdjacentHTML` string literals: scanning only recognizes class names that appear in the HTML template.

### Scoping Model
`id` and `name` attributes are scoped **per-instance:** each use of a component generates a different `instanceId`, guaranteeing unique DOM IDs even when the same component appears multiple times on a page. `class` attributes are scoped to the component name only (no instanceId), so all instances share the same class names and CSS deduplication emits a single `<style>` block.

Form inputs using `<input name="username">` receive per-instance scoped names (e.g. `bascik__comp__a1b2c3__username`), so `new FormData(form)` keys reflect the scoped name.

Literal component tags inside `<script>`, `<style>`, `<textarea>`, or HTML comments (`<!-- <my-card> -->`) are treated as text and never resolved into components.

```
class  →  bascik__<componentName>__<originalName>
id     →  bascik__<componentName>__<instanceId>__<originalName>
name   →  bascik__<componentName>__<instanceId>__<originalName>
```

### Multiple Script Blocks
Component templates can contain multiple `<script>` tags. Bascik processes each script tag according to its attributes:
* **Client scripts:** Standard JavaScript blocks are each wrapped in an isolated IIFE `(function() { ... })();` when `scopeScriptBlocks` is enabled. If you include multiple client `<script>` tags in a single component, each runs in its own IIFE so local variables do not collide.
* **Build scripts (`<script data-bascik-build>`):** Executed during build or dev time in Node.js to generate dynamic markup.
* **Server scripts (`<script data-bascik-server>`):** Executed on the server at request time in Node.js.
* **Data scripts (e.g. `type="application/ld+json"`):** Left untouched without IIFE wrapping or JavaScript minification.

Recommended Pattern: Keeping separate, unrelated concerns in dedicated client `<script>` tags (like form validation and UI animation) is recommended for code readability and maintainability.

### Multiple Instances
Using a component more than once works automatically, each use gets a different `instanceId`, so IDs never collide and each instance's scripts reference only its own elements.

### Class Selectors and Multiple Instances (PITFALL)
Because class names are scoped to the component **name** (not per-instance), `querySelector('.my-class')` and `querySelectorAll('.my-class')` **always return the first matching element in the document**, even after Bascik rewrites the class name. When the same component is used more than once on a page, every instance's script will target the first instance's elements, the other instances' buttons/inputs/etc. will appear non-functional.

**Rule:** In component scripts, always use `getElementById` (or `getElementsByName`) to locate specific elements, both are per-instance scoped and always resolve to the correct element. Never use `querySelector`/`querySelectorAll` with a class selector to find an element you need to control per-instance.

```html
<!-- ❌ Broken for multiple instances -->
<button class="my-btn">Click</button>
<script>
  document.querySelector('.my-btn').addEventListener('click', () => { … });
</script>

<!-- ✅ Correct: id is per-instance -->
<button id="my-btn" class="my-btn">Click</button>
<script>
  document.getElementById('my-btn').addEventListener('click', () => { … });
</script>
```

**Escape hatch:** Set `deduplicateCss: false` in `bascik.config.ts` to switch to per-instance class scoping. By default, all instances of the same component share identical scoped class names so Bascik emits one shared `<style>` block per component. With `deduplicateCss: false`, class selectors become unique per instance (like IDs), but Bascik emits a separate `<style>` block for each component instance.

### `deduplicateCss` Trade-Off Comparison

Setting `deduplicateCss` in `bascik.config.ts` controls whether class names are scoped per component type or per component instance.

| Feature or Aspect | `deduplicateCss: true` (Default) | `deduplicateCss: false` |
|---|---|---|
| **Class Scoping Scheme** | `bascik__card__wrapper` (shared per component) | `bascik__card__a1b2c3d4__wrapper` (unique per instance) |
| **CSS Payload** | Single `<style>` block per component type, zero CSS duplication | Multiplied `<style>` blocks (one block per component instance) |
| **`querySelector('.cls')` Behavior** | Targets the first instance on the page | Targets the matching element inside that specific instance |
| **Instance Isolation Model** | Use `id` and `getElementById()` for per-instance script isolation | Class selectors inherently isolate per instance |
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

### TypeScript in Component Scripts & BYOMinifier

Bascik ships vanilla JavaScript to the browser. If a project uses TypeScript inside component `<script>` blocks, type annotations must be stripped before output is served. Bascik's **BYOMinifier (Bring Your Own Minifier)** feature allows wiring Node 22.18+'s built-in `stripTypeScriptTypes` into the `minify.js` hook:

```ts
// bascik.config.ts (Illustrative example for projects using TypeScript in component script blocks)
import { stripTypeScriptTypes } from 'node:module';
import { defineConfig } from '@bascik/bascik/config';

export const build = defineConfig({
  minify: {
    js: (js) => stripTypeScriptTypes(js),
  },
});
```

Component scripts can then use TypeScript annotations freely. Bascik's scoping pipeline runs first (IIFE wrapping, selector rewriting), then `minify.js` strips the types. **Erasable syntax only:** `stripTypeScriptTypes` removes type annotations, interfaces, `as` casts, and `!` non-null assertions. Non-erasable syntax (`enum`, parameter properties, namespaces with runtime code) requires a separate compile step. Note that this configuration is only needed when component script blocks contain TypeScript syntax.

### Debugging Component Scripts & Virtual Source Files

When debugging component scripts in browser DevTools (Cmd+Option+I or F12), Bascik provides virtual source files and accurate stack traces:

* **Virtual Source Files:** Bascik appends a `//# sourceURL=src/components/name.html` directive and preserves line-offset padding in every component client `<script>` block. In browser DevTools under the **Sources** (or Debugger) panel, your component scripts appear as virtual files matching your project folder structure (e.g., `src/components/card.html`).
* **Console Logs & Breakpoints:** Because component scripts are listed as virtual files, you can search for them directly using `Cmd + P` or `Ctrl + P` in DevTools, set breakpoints, and step-debug. Runtime console logs and uncaught exceptions map directly to the original component file and line offset rather than the generated HTML page.

---

## 5. Dynamic Runtime Class Scoping & JS-Only Class Discovery

Class names referenced in JavaScript (`classList.add/remove/toggle/replace`, `.className` in selector strings, `el.className = "..."`, and `setAttribute("class", "...")`) are automatically discovered by Bascik's JS scanner and added to the component's class scope map before the JS rewrite runs.

This means dynamic modifier classes (such as `is-open` or `btn--active`) that only appear inside a `<script>` block and never in a `class="..."` HTML attribute are scoped automatically in both CSS and JS without needing any template annotations.

```html
<section class="card" id="card">
  <p id="status">Panel closed</p>
  <button id="toggle" type="button">Toggle</button>
</section>
<script>
  const toggle = document.getElementById('toggle');
  const status = document.getElementById('status');
  const card = document.getElementById('card');

  toggle.addEventListener('click', () => {
    const isOpen = card.classList.toggle('is-open'); // is-open is automatically discovered and scoped in CSS and JS
    status.textContent = isOpen ? 'Panel open' : 'Panel closed';
  });
</script>
```

The only exception is `innerHTML` / `insertAdjacentHTML` HTML string scanning, which only recognizes class names that appear as static `class="..."` attributes in the component HTML template.

---

## 6. Slots & Props

### Slots (Default & Named)

#### Default Slot

Add `data-bascik-slot` (no value) to any element in the component template. The element is replaced by the slot content at the usage site. Use the element's inner content as fallback when no slot content is provided.

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
<div class="card">
  <h2>Card Title</h2>
  <p>Card body text.</p>
</div>
```

#### Named Slots

Use `data-bascik-slot="name"` in the template to define named zones. At the usage site, wrap content with the same attribute.

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

### Slot Whitespace
Leading and trailing whitespace is trimmed from all slot content at build time. Whitespace *within* slot content is preserved exactly as written.
By default Bascik skips transpilation inside `<code>` elements, so raw code examples stay literal.

### Props
Inject text values into a component at usage time.

```html
<!-- alert-box.html -->
<div class="alert">
  <strong data-bascik-prop-title></strong>
  <p data-bascik-prop-message></p>
</div>

<!-- usage -->
<alert-box
  data-bascik-prop-title="Success"
  data-bascik-prop-message="Your changes were saved."
></alert-box>
```
Props in Bascik follow the same basic idea as React props, but the mechanism is vanilla HTML through `data-bascik-prop-*` attributes.
The `data-bascik-prop-*` marker is removed from compiled output, while the target element's other attributes are preserved.
*Props accept text values only. For rich HTML content, use slots.*

---

## 7. Attribute Inheritance & Tags

### Attribute Inheritance
Non-`data-bascik-*` attributes on a usage tag are merged onto the component's root element when `inheritAttributes` is `true` (the default). `id` is forwarded too unless the template root already defines its own `id`. Class names are appended, not replaced.

If a component template contains multiple root elements, inherited attributes are merged onto the first root HTML element in the component template.

```html
<!-- usage: attributes here are forwarded onto the component root -->
<site-nav class="sticky" aria-label="main navigation"></site-nav>

<!-- site-nav.html: component template -->
<nav class="nav"><a href="/">Home</a></nav>

<!-- compiled output: class appended, aria-label forwarded -->
<nav class="bascik__site-nav__nav sticky" aria-label="main navigation">
  <a href="/">Home</a>
</nav>
```

Inherited class names are not scoped, they are treated as global page-level classes. To disable inheritance: `inheritAttributes: false` in `bascik.config.ts`.

### Internal Masking vs. Preserving Element Contents

These two mechanisms serve distinct purposes:

* **Internal scanning mask (internal, hardcoded, not configurable):** Bascik temporarily blanks the contents of `<script>`, `<style>`, `<textarea>`, and HTML comments while scanning with regular expressions, so a component tag inside a JavaScript string, style block, or comment is not mistaken for real markup. The mask is discarded immediately after scanning. Authors never interact with or configure this behavior.
* **Preserve element contents (authoring choice):** The `skipTranspilingElementContents` option (default `['code']`) tells Bascik not to apply scoping transforms inside matching tags, so code samples displaying `class="card"` are not rewritten to scoped identifiers like `class="bascik__comp__card"`. *(Note: this option is renamed to `scoping.preserve` in an upcoming configuration update; the rename is not yet implemented)*.

### Self-Closing Tags
Components that do not contain inner slot content should always use self-closing void syntax:
```html
<site-nav />
<site-head />
<site-footer />
<site-nav class="top" />
```

### Head Components
Components work inside `<head>` to organize metadata and shared links:
```html
<!-- src/components/site-meta.html -->
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="My site" />

<!-- usage in page shell -->
<head>
  <site-meta />
  <title>Home</title>
</head>
```

---

## 8. Build-time Scripts

`<script data-bascik-build>` blocks are executed at transpile time as Node.js ESM modules. The script's stdout is injected in place of the tag. Runs in both dev and build modes.

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';
  const md = await readFile('./content/intro.md', 'utf8');
  console.log(marked(md));
</script>
```

* Top-level `import` and top-level `await` are supported.
* CWD is the project root. Relative paths resolve from there.
* Use `console.log()` or `process.stdout.write()` to output HTML.
* Build scripts run before component resolution, so their output can contain component tags.
* All build scripts on a page execute concurrently via `Promise.all` (capped by a memory semaphore), and output is assembled in document order once all scripts complete.
* On error, behavior is controlled by `onScriptError` in `bascik.config.ts`: `'warn'` (default in dev: log warning to stderr and replace tag with `""`), `'error'` (default in `--build` and `--serve`: log error to stderr and throw exception to stop build), or `'halt'` (alias for `'error'`).
* **Stack Trace Remapping:** For both `<script data-bascik-build>` and `<script data-bascik-server>` blocks, Bascik automatically intercepts child-process stack traces, filters out noisy Node.js internal files, stack frames, and `Command failed:` headers, and remaps temporary execution files back to your source HTML file and line offset (e.g., `src/pages/dashboard.html:25`). This filters out the noise of internal V8 loader frames and child process execution headers, leaving only the clean, actionable stack trace of your template and helper scripts. In VS Code or terminal emulators, you can Cmd+Click (or Ctrl+Click) the file reference in the error log to jump directly to the failing script's exact line.
* **Hard error:** combining `data-bascik-build` and `data-bascik-server` on the same tag throws and aborts the build. A script runs at build time or at request time, not both.

### Build Script Environment Variables

Build scripts receive these `process.env` variables:

| Variable | Description |
|---|---|
| `BASCIK_PAGE_PATH` | Normalized root-relative route path of the current page shell (e.g. `/getting-started`, `/switch/from-vue`, `/`). |
| `BASCIK_SOURCE_FILE` | Absolute path to the file currently being transpiled (page or component template). |
| `BASCIK_PAGE_FILE` | Absolute path of the current page file (e.g. `/project/src/pages/about.html`). Use this to generate page-specific output like canonical URLs. |
| `BASCIK_PAGES_DIR` | Absolute path to the configured pages directory. |
| `BASCIK_BUILD` | `"1"` during `bascik --build`, `"0"` during dev. Use to produce different output per mode. |
| `BASCIK_SITE_URL` | The site URL resolved from `--site-url`, the `BASCIK_SITE_URL` env var, or `.env`. Absent when unset, never an empty string. |
| `BASCIK_ROUTE` | JSON string `{ params, data }` passed to build scripts inside dynamic route templates. |

These are critical for scripts that generate per-page output. A script using `BASCIK_SOURCE_FILE`, `BASCIK_PAGE_FILE`, or `BASCIK_PAGE_PATH` gets a separate cache entry per page automatically.

### Build Script Output Cache

Each `<script data-bascik-build>` spawns a Node.js child process (~50–150 ms startup each). Bascik caches script output on disk so unchanged scripts skip the spawn on subsequent builds or server restarts.

**Cache location:** `node_modules/.cache/bascik/script-cache/<sha256>.json`

**Cache key:** SHA-256 of the script content + dev/build mode + the source file path (`BASCIK_SOURCE_FILE`) + the site URL + the full content of any `content/*.md` or `scripts/*.{mjs,js,ts}` files referenced as quoted path literals in the script. The file path is included so that scripts like `canonical.ts` that use `process.env.BASCIK_SOURCE_FILE` get a separate cache entry per page. Changing a referenced file produces a new key and a cache miss for that script only; all other scripts keep their cached output.

**To disable:** set `buildScriptCache: false` in your config (useful when debugging a script that reads external state not tracked by the cache key).

**To bust the entire cache** (e.g. after upgrading a build-time npm dependency):

```sh
rm -rf node_modules/.cache/bascik/script-cache
```

With `useWorkers: true`, multiple workers share the same cache directory. Workers that independently miss the same key both spawn a child process; last write wins with identical content. This is a minor inefficiency on a cold first build only.

### Rendering and Styling Markdown

Install a Markdown parser such as `marked`, read the source in a build script, and write the resulting HTML to stdout:

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';

  const md = await readFile('./content/article.md', 'utf8');
  console.log(marked(md));
</script>
```

Given this Markdown source:

```md
## A practical heading

Markdown stays comfortable for authors, while the published page stays **vanilla HTML**.

> Add an editorial treatment with ordinary CSS.
```

`marked()` emits:

```html
<h2>A practical heading</h2>
<p>Markdown stays comfortable for authors, while the published page stays <strong>vanilla HTML</strong>.</p>
<blockquote>
<p>Add an editorial treatment with ordinary CSS.</p>
</blockquote>
```

The parser emits ordinary HTML, so it can be styled by a global stylesheet or wrapped in a Bascik component. For reusable scoped styles, have the script emit `<markdown-content>${marked(md)}</markdown-content>` and give that component a default slot.

Use wrapper descendant selectors for generated slot content:

```css
.markdown-content h2 { margin-block: 2.5rem 0.75rem; }
.markdown-content blockquote { border-left: 4px solid currentColor; }
```

Do not rely on a bare `h2 {}` component rule for Markdown passed through a slot. Bare element rules are transformed before slot content is inserted; a scoped wrapper selector continues to match the generated descendants.

### Page-Aware Scripts

Some pages need content that is specific to the current page, such as a canonical URL in the head, an Open Graph image, a structured-data block, or even a page-specific sidebar. Hardcoding those values in every page file works. However, a shared script is easier to maintain. You can change the logic once and every page picks it up automatically.

Bascik makes this possible by injecting environment variables into every `data-bascik-build` subprocess: `BASCIK_SOURCE_FILE`, `BASCIK_PAGE_FILE`, `BASCIK_PAGES_DIR`, and `BASCIK_SITE_URL` (described in the Environment Variables table above).

#### Canonical URL Example

A canonical URL tag tells search engines which URL is the authoritative version of a page. Every docs page on this site uses a shared `scripts/canonical.ts` that derives the URL from `BASCIK_SOURCE_FILE`:

```ts
// scripts/canonical.ts
export async function canonical(): Promise<string> {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';

  if (!siteUrl || !pageFile || !pagesDir) return '';

  const relPath = pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  const withoutExt = relPath.replace(/\.html$/, '');
  const route = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '/');
  const urlPath = route ? `/${route}` : '/';

  return `<link rel="canonical" href="${siteUrl}${urlPath}" />`;
}
```

Use it from any page's `<head>`:

```html
<head>
  <script data-bascik-build>
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { canonical } = await import(
      pathToFileURL(join(process.cwd(), 'scripts/canonical.ts')).href
    );
    console.log(await canonical());
  </script>
</head>
```

#### Reading the Page's Own HTML

For richer outputs, including Open Graph tags or JSON-LD structured data, a script can also read the page file itself to extract metadata. `BASCIK_SOURCE_FILE` is an absolute path, so `readFile` works directly:

```ts
// scripts/article-schema.ts (simplified)
import { readFile } from 'node:fs/promises';

export async function articleSchema(): Promise<string> {
  const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  if (!pageFile || !siteUrl) return '';

  const html = await readFile(pageFile, 'utf8');
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  if (!titleMatch || !descMatch) return '';

  const headline = titleMatch[1].trim();
  const description = descMatch[1].trim();
  // ... compute url, build schema object, return JSON-LD script tag
}
```

The script runs on the source HTML before any other build scripts have fired, so `<title>` and `<meta name="description">` are always present as written.

### data-bascik-dev

Tag a browser script with `data-bascik-dev` to mark it as dev-only. In development the attribute is stripped and the script runs normally in the browser. In production builds (`bascik --build`) the entire script tag is removed.

```html
<script data-bascik-dev>
  console.log('dev only: stripped from production build');
</script>
```

Useful for debug logging, development overlays, or any browser script that should never ship to production.

> **dev vs. build:** `data-bascik-build` executes at transpile time and injects HTML into the page. `data-bascik-dev` runs in the browser, but only in dev mode.

### Dynamic Routes (data-bascik-routes)

Dynamic routes allow you to generate multiple static HTML files from a single template at build time. Use square brackets in the template filename (such as `src/pages/blog/[slug].html` or `src/pages/[category]/[id].html`) and include a `<script data-bascik-routes>` block:

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-routes>
  const posts = [
    { slug: 'hello-world', title: 'Hello World' },
    { slug: 'second-post', title: 'Second Post' }
  ];
  const routes = posts.map(p => ({
    params: { slug: p.slug },
    data: p
  }));
  console.log(JSON.stringify(routes));
</script>

<script data-bascik-build>
  const { params, data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
  console.log(`<h1>${data.title}</h1>`);
</script>
```

Rules:
* Script must output a valid JSON array of route objects with required `params` (matching all bracket names in the template path) and optional `data`.
* In build scripts, `process.env.BASCIK_ROUTE` provides the current `{ params, data }` payload.
* Dynamic route templates are expanded into concrete static HTML files during `bascik --build` and dev server startup.
* Concrete route URLs are automatically added to `sitemap.xml` with percent-encoding.
* `data-bascik-routes`, `data-bascik-build`, and `data-bascik-server` are mutually exclusive and cannot be combined on the same tag.

### data-bascik-server

Tag a `<script>` block with `data-bascik-server` to run it **at request time** on the server. Unlike `data-bascik-build` (which executes once at transpile time), server scripts execute on every request and are never cached. Use them to personalize pages per visitor, reading cookies, querying a database, rendering content based on query parameters.

```html
<script data-bascik-server>
  import { escapeHtml } from './lib/escape-html.mjs';

  const req = JSON.parse(process.env.BASCIK_REQUEST);
  const name = escapeHtml(req.headers['x-display-name'] ?? 'Guest');
  console.log(`<p>Welcome, ${name}!</p>`);
</script>
```

`process.env.BASCIK_REQUEST` is a JSON string with four keys:

* `path`: URL path without query string, e.g. `"/about"`
* `method`: HTTP method in uppercase, e.g. `"GET"`
* `headers`: request headers as string-to-string object (HTTP/2 pseudo-headers excluded)
* `searchParams`: parsed query params as string-to-string object

Bascik intentionally does not inject a global `escapeHtml()` helper into every server script. If you want a shared escape utility, keep it in a project file or import it explicitly.

Rules:
* Top-level `import` and `await` are supported.
* `data-bascik-server` blocks are preserved through `bascik --build` and executed at request time when served with `bascik --serve` or the dev server.
* They are NOT executed during `bascik --build` itself.
* Scripts are NOT wrapped in an IIFE (they are Node.js code, not browser JS).
* On error, a warning is logged and the tag is replaced with an empty string.

---

## 9. Configuration (`bascik.config.ts`)

Bascik is **zero-config by default**. You do NOT need a `bascik.config.ts` file unless you are customizing settings (like `generate.sitemapLastmod`, custom `exec` build scripts, or production `build` minification overrides).

Use `bascik.config.ts` (preferred) or `bascik.config.js` (takes precedence if both exist). Import `defineConfig` for full editor autocomplete and inline docs.

### Configuration is validated at startup

Bascik validates the config before anything reads it and reports every problem together: each error names the key, the received value, and the expectation. Unknown keys are rejected with a "did you mean" suggestion, so a typo like `minfy:` or `directroy:` fails loudly instead of being silently ignored. Referenced paths (`directory.pages`, `pipeline.exec[].script`, `pipeline.watchPaths`, `assets.inlineStyles`, TLS key/cert files) are checked for existence. `base` is normalized to a leading and trailing slash (`docs` becomes `/docs/`); only a full URL is rejected.

### The site URL is not a config key

`siteUrl` is a per-deployment value, so it never goes in `bascik.config.ts` (setting it there is an error). Three sources, in precedence order:

```text
--site-url flag  >  BASCIK_SITE_URL env var  >  .env file
```

The value must be an absolute `http` or `https` URL. Bascik loads `./.env` automatically (silently skipped when absent); `--env-file <path>` is repeatable with later files winning, and a missing explicit file is an error. A real environment variable always beats a file value. When `generate.sitemap` or `generate.robots` is enabled (both default to `true`) and no source provides the URL, the build fails with a message showing all three ways to set it.

### Minimal Configuration Example (Recommended)

When creating or editing `bascik.config.ts`, only include options that differ from built-in defaults:

```ts
// bascik.config.ts (minimal example)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: { sitemapLastmod: true },
});

// Applied only during `bascik --build` and `bascik --serve`.
export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});
```

### Anti-Pattern: Defaults-Only Configuration

Create `bascik.config.ts` only when a value differs from the default. If the configuration file would contain only defaults, **do not create the file**.

```ts
// DO NOT write this. Every value here is already the default for `bascik --build`.
export const build = {
  minify: true,
};
```

### Full Configuration Reference (Built-In Defaults)

You do not need to populate default options in `bascik.config.ts`. The reference below displays all available configuration options populated with their built-in default values for illustrative purposes only:

```ts
// bascik.config.ts (reference showing all default values)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    pages: 'src/pages',
    components: 'src/components',
    out: 'dist',
    public: undefined,
    api: 'src/api',
  },
  scoping: {
    scriptBlocks: true,
    inheritAttributes: true,
    attributes: {
      class: true,
      id: true,
      name: true,
    },
    preserve: ['code'],
    deduplicateCss: true,
  },
  minify: {
    html: false,
    css: false,
    js: false,
    identifiers: false,
  },
  assets: {
    inlineStyles: false,
    exclude: [],
  },
  generate: {
    sitemap: true,
    robots: true,
    sitemapLastmod: false,
    cspHashes: false,
    manifest: false,
  },
  pipeline: {
    watchPaths: [],
    exec: [],
    workers: false,
  },
  scripts: {
    cache: { enabled: true },
    onBuildScriptError: 'error',
    onRoutesScriptError: 'error',
    onServerScriptError: 'error',
    timeout: 30000,
  },
  onMinifyError: 'warn',
  http: {
    port: undefined,
    hostname: 'localhost',
    tls: {
      enabled: false,
    },
    rateLimit: true,
    trustProxy: false,
    cacheControl: 'public, max-age=3600',
    compression: true,
    maxBodySize: 1048576,
    apiTimeout: 10000,
  },
  logging: {
    level: 'info',
    requests: true,
    copies: true,
    deletes: true,
    transpiles: true,
  },
  base: '/',
});

// Applied only during `bascik --build` and `bascik --server`.
export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});
```

### Agent Guidelines for Configuration

When creating or modifying `bascik.config.ts`:
* **Do not create defaults-only config files:** Bascik is zero-config by default. Only create `bascik.config.ts` when a project requires non-default settings (such as `generate` toggles, custom `exec` scripts, or custom minifiers). If a config file would only restate defaults, omit the file entirely.
* **Keep `bascik.config.ts` minimal:** Do NOT add redundant default options like `directory: { pages: 'src/pages', components: 'src/components' }`, `scopeScriptBlocks: true`, `inheritAttributes: true`, `deduplicateCss: true`, `watch: []`, or empty `devServer`/`prodServer` blocks. Bascik already defaults to these settings. Only include options that differ from defaults (e.g. custom `exec` scripts or `build` minification rules).
* **Package.json `"type": "module"` and NPM scripts:** When initializing or configuring a Bascik project, ensure `package.json` specifies `"type": "module"` (since `bascik.config.ts` uses ES module imports) and includes standard npm scripts (`"dev": "bascik"`, `"build": "bascik --build"`, `"check": "bascik --check"`).
* **Proactively decompose shared layout components:** When creating or migrating a site, identify repeating layout sections (especially shared `<head>` tags such as `<site-head>`, site headers, and footers) and extract them into reusable components.
* **Prefer self-closing void syntax for components without slots:** Use self-closing void syntax (`<site-head />`, `<site-nav />`, `<site-footer />`) for any component tag that does not enclose inner slot content.
* **Do NOT invent non-existent `exec` scripts:** `exec` is only for executing existing custom pre-build script files. If no custom script file exists in the workspace, leave `exec` as an empty array `[]` or omit it.
* **Array Replacement in `build`:** Array properties like `exec`, `watch`, and `inlineStyles` are replaced as atomic values (not concatenated) when specified in `export const build`. When defining `build.exec`, include all scripts that should run in production builds.
* **Write artifacts to `dist/`:** Any custom lifecycle script run via `exec` or `<script data-bascik-build>` must write its generated files to `dist/`, never to `src/`.
* **Stick to recommended defaults:** Preserve `deduplicateCss: true`, `scopeScriptBlocks: true`, and `inheritAttributes: true` unless specifically instructed otherwise or integrating global utility frameworks like Tailwind CSS.
* **Set `BASCIK_SITE_URL` for production features:** Provide the site URL via the environment (e.g. `BASCIK_SITE_URL=https://example.com bascik --build`) when page-aware canonical scripts, sitemaps, or `robots.txt` generation are enabled. Never put `siteUrl` in `bascik.config.ts`.

**`minify.js`:** `true` (default) strips comments and collapses whitespace; it does not mangle identifiers. Pass a custom async function to plug in esbuild, terser, or `stripTypeScriptTypes`:

```ts
import { transform } from 'esbuild';
export const build = defineConfig({
  minify: {
    js: async (js) => (await transform(js, { minify: true, loader: 'js' })).code,
  },
});
```

---

## 10. Folder Structure, Static Assets, 404, and 500 pages

```
src/
  components/           ← component .html (+ optional .css) templates
  pages/                ← HTML routes, static assets, and subfolders
    index.html          → dist/index.html
    css/styles.css      → dist/css/styles.css (auto-minified)
    js/main.js          → dist/js/main.js (auto-minified)
    images/logo.svg     → dist/images/logo.svg
    404.html            → dist/404.html
```

### Static Assets and Subdirectories
* **Any Asset or Folder in `src/pages/`:** You can create any subfolders (`css/`, `js/`, `images/`, `fonts/`, `downloads/`) inside `src/pages/`. All non-`.html` files (CSS, JS, images, fonts, PDFs, JSON, etc.) are automatically copied to `dist/` replicating their exact directory structure.
* **Auto-Minification:** CSS and JS files placed in `src/pages/` are automatically minified at build time when `minify.css` / `minify.js` are enabled in `bascik.config.ts`. Custom BYOMinifier minifier/transformer functions (e.g. PostCSS/Autoprefixer, LightningCSS, esbuild, terser) can also be assigned to `minify.css` and `minify.js`.
* **No Passthrough Configuration:** No asset pipelines, passthrough copy configuration, or public folder settings are needed.

### Custom 404 & 500 Error Pages
* **404 Page (`src/pages/404.html`):** Picked up automatically by path convention in the dev server and under `bascik --serve` as a fallback for any non-existent routes (with a 404 status code). When built with `bascik --build`, it compiles to `dist/404.html`, which static hosting platforms (GitHub Pages, Cloudflare Pages, Netlify, Vercel) recognize and serve automatically.
* **500 Error Pages in Static vs. Server Contexts:**
  * **Static builds (`bascik --build`):** A 500 error page is meaningless in a fully static build, because static web hosts serve their own error pages if an infrastructure or server issue occurs. Do not port a 500 error page from Next.js, Remix, or any server-rendered framework into a static Bascik site.
  * **Production server (`bascik --serve`):** Custom `src/pages/500.html` support under `bascik --serve` will be convention-based with no config key *(Note: Not yet implemented, planned in an upcoming release)*. Currently, runtime server errors return built-in error responses.

---

## 11. CLI & Development Workflow

### Scaffold a New Project

The zero-friction way to start a new Bascik project:

```sh
npm create bascik@latest my-site -y
```

This scaffolds the project, installs dependencies, and starts the dev server in one shot. You're live at **http://localhost:8080**. Pass a different name to use it as both the directory name and the site title. Omit the name to be prompted for one (defaulting to `bascik-app`). Drop `-y` to step through the install and dev server prompts manually.

The scaffold creates a complete starter site: pages, components, global CSS, `bascik.config.ts`, `.gitignore`, and AI assistant skills at `.github/skills/bascik/SKILL.md` and `.claude/skills/bascik/SKILL.md`. When the dev server stops, the CLI prints a reminder:

```
To start again:  cd my-site && npm run dev
```

### Adding to an Existing Project

```sh
npm install @bascik/bascik
```

Then run `bascik init` to scaffold the starter files and folder structure, or add the scripts manually to `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "dev": "bascik",
    "build": "bascik --build"
  }
}
```

### CLI Commands

```sh
bascik                        # dev: transpile, start plaintext HTTP server at http://localhost:8080, watch
bascik --build                # production: transpile to dist/ only
bascik --build --log [path]   # write build output to a log file (default: .bascik/build.log)
bascik --serve                # production preview/server: serve a pre-built dist/ folder
bascik --check                # static analysis: validate pages and components without building
```

**`bascik --serve`:** starts the HTTP/2 server against a pre-built `dist/` directory. **Only needed when the site uses `data-bascik-server` scripts** for per-request dynamic content (personalized dashboards, user-specific data, server-rendered pagination). Sites with no server scripts can be deployed to any static host with no runtime server required. Run `bascik --build` first, then `bascik --serve`. Unlike the dev server, `--serve` does not watch files or inject live-reload. `data-bascik-server` scripts execute per-request in both modes.

**`prodServer` config block:** configure the production server in `bascik.config.ts`:
```ts
export default {
  cacheHttp: true,       // default in --serve; false in dev
  prodServer: {
    port: 8080,            // default (8080 HTTP, 8443 HTTPS)
    hostname: 'localhost', // set '0.0.0.0' to bind all interfaces
    enableTls: false,      // default; set true for HTTP/2 HTTPS
    keyFile: 'bascik-privkey.pem',
    certFile: 'bascik-cert.pem',
  },
};
```
When `enableTls: true` is set, TLS certs are generated automatically (mkcert if available, openssl fallback) when `keyFile`/`certFile` are absent. Provide your own certs from a public CA for production.

**`cacheHttp`:** defaults to `true` in `--serve` and `false` in the dev server. When `true`: pages receive `ETag` headers and the server returns `304 Not Modified` for unchanged content; static assets get `Cache-Control: public, max-age=3600`. Set `false` if a CDN manages caching externally.

**Production hardening (automatic in `--serve`):**
* **Security headers:** every response includes `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy: interest-cohort=()`. When serving over HTTPS/TLS (`enableTls: true` or `x-forwarded-proto: https`), `strict-transport-security: max-age=31536000; includeSubDomains` (HSTS) is automatically included per RFC 6797.
* **URL routing (dev and production):** pages are served at their filename without the `.html` extension. `dist/about.html` is at `/about`, `dist/blog/post.html` is at `/blog/post`, `dist/index.html` is at `/`. Unmatched paths fall through to `/404` if a `dist/404.html` exists.
* **Rate limiting:** 500 requests per 10 seconds per IP. Clients over the limit get `429 Too Many Requests` with `Retry-After`. Not active in the dev server. When behind a reverse proxy the limit applies to the proxy's IP; use the proxy's own rate limiting for per-client control.
* **Graceful shutdown:** SIGTERM and SIGINT stop accepting connections, destroy all open sessions and live-reload SSE connections, and drain in-flight requests before exiting. Force-exits after 10 seconds if anything hasn't drained.
* **Path traversal protection:** static asset URLs are validated against `dist/`; requests that escape with `/../` sequences get `400 Bad Request`.

**Deployment:** Bascik's server runs over unencrypted HTTP/1.1 by default. Edge platforms (Heroku, Fly.io, AWS ECS, Render) that terminate TLS at the load balancer can forward cleartext HTTP directly to the container. Key patterns:

* **VPS / dedicated**: bind `hostname: '0.0.0.0'`, supply Let's Encrypt certs via `keyFile`/`certFile` with `enableTls: true`, run as a `systemd` service.
* **Docker**: multi-stage build (build stage: `npx bascik --build`; serve stage: `npx bascik --serve`).
* **PaaS (Railway, Render, Fly.io)**: set start command to `bascik --build && bascik --serve` and bind port `8080`.

When using a reverse proxy, forward `X-Real-IP` and any auth headers so `data-bascik-server` scripts receive them via `headers` in `BASCIK_REQUEST`.

### Development Workflow & Server Output
Bascik's CLI is designed to provide clean, minimal, and informative terminal output.

#### 1. Starting the Dev Server
When you start the dev server, Bascik starts the HTTP server concurrently with page transpilation so the server is already bound to its port by the time the last page finishes. The `Server running at` line prints immediately after the transpilation summary with no gap between them. Pages are served from memory with no disk I/O at request time in dev mode. If port 8080 is in use, Bascik automatically tries the next available port (8081, 8082, etc.).

```terminal
Starting transpiling...
transpiled: pages/getting-started.html in 0.4ms
transpiled: pages/index.html in 0.6ms
transpiled: pages/about.html in 0.3ms

✓ 3 pages transpiled in 45ms
Server running at http://localhost:8080
```

On startup, Bascik computes the full component list and global styles **once**, then transpiles all pages. By default pages transpile sequentially on the main thread; setting `useWorkers: true` in `bascik.config.ts` distributes them across a pool of CPU-core worker threads instead. Worker startup has a fixed cost (each worker loads the transpiler's module graph independently), so `useWorkers` is opt-in and best suited to larger sites or CPU-heavy per-page work, small sites are usually faster with the sequential default. Brotli compression for each page runs in the background after storage and does not block the page from being marked ready or served; the server falls back to serving uncompressed content for any request that arrives before compression finishes. The server becomes ready as soon as memory is populated. In dev mode, pages are served from memory and compiled HTML is not written to `dist/`, while static assets are copied to `dist/`. Note: this dev-mode disk write gap is a known inconsistency being addressed in an upcoming update.

#### 2. Watching for File Changes (Watch Mode)
While the dev server is active, Bascik watches your file system and incrementally updates your build as files are added, updated, or removed:

* **Modifying/Adding Pages:** Editing or adding an HTML page in your pages directory (e.g., `src/pages/about.html`) triggers incremental transpilation of just that page:
  ```terminal
  transpiled: pages/about.html in 0.3ms
  ```
* **Modifying Components:** Editing a component (e.g., `src/components/site-nav/site-nav.html`) triggers selective transpilation. Bascik tracks dependency mappings and only rebuilds pages that actually reference that component:
  ```terminal
  transpiled: pages/index.html in 0.5ms
  transpiled: pages/about.html in 0.3ms
  ```
* **Open-Page Prioritization:** When a batch rebuild is triggered (such as an inlined stylesheet or shared component), Bascik checks active live-reload browser connections and prioritizes compiling currently open pages first, emitting reload signals immediately before compiling background pages.
* **Static Assets:** Replicating any non-HTML static assets (like custom CSS, JS files, or images) from pages directly into the output directory:
  ```terminal
  copied: pages/css/custom.css
  ```
* **Deleting Pages:** Removing a page from your pages directory automatically cleans up its compiled output counterpart to prevent dead files:
  ```terminal
  deleted file: pages/old-page.html
  ```

#### 3. Transpilation & Build Errors
If you introduce a syntax mistake or a runtime error inside a custom build script, Bascik prevents the server from crashing, gracefully logs a descriptive error with the file and exact line/column location, and continues running.

* **Component Transpilation Failure:** If a component markup or CSS scoping parser fails during transpilation:
  ```terminal
  [bascik] Transpilation failed for component <site-nav> during css-scoping in "pages/about.html" at (line 22, column 8)
    Defined in component template: "components/site-nav/site-nav.html"
    Error: ParseError: CSS Selector is invalid or could not be parsed.
  ```
* **Build Script Failure:** If a build-time JavaScript execution block (using `<script data-bascik-build>`) encounters an error:
  ```terminal
  [bascik] build script error in "pages/index.html" at (line 12, column 5):
  ReferenceError: marked is not defined
  ```
* **Unknown Component Tags:** If a page references a hyphenated tag with no matching component file, Bascik warns during transpilation:
  ```terminal
  [bascik] Unresolved component tag in "pages/about.html": <my-mistyped> - no matching component file found. Run `bascik --check` for a full report.
  ```

#### 4. Static Analysis (`bascik --check`)
Run `bascik --check` from your project root to validate pages and component files without starting the dev server or writing any output:

```sh
bascik --check
```

Bascik scans every `.html` file in your pages and components directories and reports:
* **Errors:** hyphenated tags with no matching component file (the tag renders as-is in the HTML output):
  ```terminal
  [bascik check] Unknown component in "pages/about.html": <my-missing> - no matching component file found
  ```
* **Warnings:** component files that are never referenced:
  ```terminal
  [bascik check] Unused component: <old-widget> - defined but never referenced
  ```
* **Success**:
  ```terminal
  [bascik check] ✓ 8 pages and 12 components checked - no errors
  ```

Exits with code `1` on errors, suitable for CI:
```sh
bascik --check && bascik --build
```

**What `bascik --check` does not cover:** it validates component references only, not CSS or JavaScript syntax. A CSS syntax error can cause bascik's scoping transforms to produce garbled output without any warning. Use external tools alongside `--check`:

| Tool | What it catches |
|---|---|
| VS Code built-in CSS | CSS syntax errors (squiggly lines, no install needed) |
| [Stylelint](https://stylelint.io) | CSS syntax, invalid properties, conventions |
| [HTMLHint](https://htmlhint.com) | HTML structure errors in `.html` files |
| [ESLint](https://eslint.org) | JS syntax and logic errors in `<script>` blocks |

Recommended CI pipeline with CSS validation:
```sh
npx stylelint "src/**/*.css" && bascik --check && bascik --build
```

#### Editor Configuration

Editors validate all `<script>` blocks in an HTML file as sharing one scope, causing false "variable already declared" errors. Bascik wraps each block in an IIFE at build time, so the errors are false positives.

**VS Code fix:** add `.vscode/settings.json`:
```json
{ "html.validate.scripts": false }
```

Commit this file so all contributors get the correct behavior automatically. Alternatively, add `// @ts-nocheck` as the first line inside any individual script block that triggers the warning.

#### 5. Inspecting `dist/` Output

`bascik --build` writes compiled HTML and static assets to `dist/` on disk, this is the ground truth of what Bascik produced for production. In dev mode (`bascik`), static assets are copied to `dist/`, but HTML pages are served directly from memory and not written to disk. The `dist/` structure mirrors `src/pages/` with the leading directory stripped:

```
src/pages/about.html       →  dist/about.html
src/pages/blog/post.html   →  dist/blog/post.html
```

What to check in compiled output:
* **Component resolution:** every custom tag (e.g. `<site-nav>`) should be replaced with expanded HTML. A hyphenated tag still present in `dist/` means no component file matched.
* **Scoped class names:** attributes like `class="bascik__site-nav__nav"` (or a short hash with `minify.identifiers`) confirm CSS scoping ran correctly.
* **Injected `<style>` block:** the `<head>` should contain one combined `<style>` with CSS from all components used on that page.
* **Build script output:** `<script data-bascik-build>` is replaced with stdout; if missing, check the terminal for a `[bascik] build script error` line.
* **Server script output:** `<script data-bascik-server>` is replaced at request time; if output is missing on a live request, check the terminal for a `[bascik] server script error` line. Remember these scripts run in Node.js, not the browser, they require `bascik --serve` or the dev server to execute.
* **Slot and prop values:** verify fallback and injected text appear in the right place.

The browser's **View Source** (or DevTools **Sources** panel) is equivalent to reading `dist/` and is often faster during development.

---

## 12. JavaScript Libraries & Progressive Enhancement

Bascik adds zero JavaScript to output pages by default, but places no restrictions on including external libraries.

**Note for AI Assistants:** The integration patterns below (petite-vue, Alpine.js, Tailwind CSS) demonstrate how to combine Bascik with external runtime libraries. Do not add or configure these libraries unless the project explicitly uses them or the user requests them.

### How to Include
Add a CDN `<script src>` tag to the page `<head>` or a shared head component. Bascik passes external script tags through completely unchanged.

```html
<head>
  <script src="https://unpkg.com/petite-vue" defer init></script>
</head>
```

### petite-vue
petite-vue (~5 KB) is a Vue-compatible progressive enhancement library. Declare `v-scope` on any element to give it isolated reactive state:

```html
<!-- src/components/my-counter.html -->
<div v-cloak v-scope="{ count: 0 }">
  {{ count }}
  <button @click="count++">+</button>
</div>
```

Load it once in the page `<head>` with `defer init` to auto-mount all `v-scope` elements:
```html
<script src="https://unpkg.com/petite-vue" defer init></script>
```

### Alpine.js
Alpine.js uses `x-data` for state and `@click` / `x-show` for events and visibility:

```html
<div x-data="{ open: false }">
  <button @click="open = !open">Toggle</button>
  <p x-show="open">Hidden content.</p>
</div>
<script src="https://unpkg.com/alpinejs" defer></script>
```

### Tailwind CSS
Tailwind utility classes are global by design. Bascik's class scoping would rename `class="flex gap-4"` to `class="bascik__comp__flex bascik__comp__gap-4"`, breaking Tailwind's CSS.

**Required config:** disable class scoping in `bascik.config.ts`:
```ts
export default {
  scopeAttribute: {
    class: false, // let Tailwind utility classes pass through unchanged
    id: true,
    name: true,
  },
};
```

Include Tailwind via CDN (development) or Tailwind CLI (production):
```html
<script src="https://cdn.tailwindcss.com"></script>
```

With `class: false`, utility classes work normally inside any component:
```html
<!-- src/components/feature-card.html -->
<div class="rounded-xl border border-gray-200 p-6 shadow-sm">
  <h3 class="mb-2 text-lg font-semibold" data-bascik-prop-title></h3>
  <p class="text-sm text-gray-600" data-bascik-prop-body></p>
</div>
```

Trade-off: with `class: false`, Bascik no longer isolates component class names. IDs and names remain scoped independently.

### HTMX, Stimulus, and Others
* **HTMX:** Uses `hx-get`, `hx-post` attributes for server-driven partial updates.
* **Stimulus:** Uses `data-controller` for attaching behavior to DOM structures.
* **Chart.js, D3, Leaflet:** Mounts to elements via `getElementById`; Bascik rewrites the ID and matching selectors at build-time so they stay in sync.

---

## 13. Testing

Bascik provides per-package commands and workspace-wide aggregators run from the root.

### Monorepo Aggregators

```sh
yarn typecheck:all     # typecheck pkg, create, docs, ext
yarn check:all         # spelling and web standards
yarn unit:all          # unit tests across all packages
yarn e2e:all           # Playwright E2E suites across all packages
yarn coverage:all      # update coverage across all packages
yarn test:all          # typecheck:all + check:all + unit:all + e2e:all + docs:lighthouse
```

### Unit Tests (Vitest)

```sh
yarn pkg:unit          # single run (@bascik/bascik)
yarn pkg:test          # watch mode
yarn create:unit       # create-bascik unit tests
yarn docs:unit         # bascik-docs unit tests
yarn ext:unit          # bascik-vscode unit tests
yarn pkg:bench         # benchmarks
```

Each `pkg/src/lib/*.ts` module has a paired `*.test.ts`. Because modules depend on `BascikConfig` (a singleton), unit tests use `vi.mock('../config.ts', ...)` to stub configuration, then import the module under test **after** the mock call.

### End-to-End Tests (Playwright)

```sh
yarn pkg:build                  # build package first
yarn pkg:e2e                    # run static production suite
yarn pkg:e2e:dev                # run dev server live-reload and watch suite
yarn pkg:e2e:prod               # run both HTTP/1.1 and HTTP/2 production server suites
yarn pkg:e2e:prod:http1         # run cleartext HTTP/1.1 prod server suite
yarn pkg:e2e:prod:http2         # run TLS HTTP/2 prod server suite
```

The E2E suite lives in `pkg/e2e/` and supports four execution modes:
1. **Static production suite (`playwright.config.ts`)**: builds the fixture site with `bascik --build` and serves static files via `server.ts` on port 4200.
2. **HTTP/1.1 production server suite (`playwright.server.config.ts`)**: boots cleartext `bascik --serve` over HTTP/1.1 on port 9443 to test `data-bascik-server` request-time script execution and cleartext server behavior.
3. **HTTP/2 production server suite (`playwright.server-http2.config.ts`)**: boots TLS-enabled `bascik --serve` over HTTP/2 on port 9444 to test `data-bascik-server` request-time script execution and encrypted server behavior.
4. **Dev server watch suite (`playwright.dev.config.ts`)**: boots `bascik --dev` on port 8080 to run the full test suite and live-reload watcher tests directly against the live dev server with SSE tracking and open-page priority re-transpilation.

The fixture config sets `minify.identifiers: false` so Playwright selectors can use readable scoped names like `bascik__my-comp__btn` instead of opaque hashes. However, in production builds (where `minify.identifiers: true` is enabled), Bascik compiles and minifies element IDs and class names. Consequently, relying on raw CSS selectors like `page.locator('.my-class')` or `page.locator('#my-id')` will fail because those identifiers are hashed and compressed.

To handle this, keep a clear distinction between compiler testing and application testing:
* **Compiler-Level E2E Tests (`pkg/e2e/`):** These verify that Bascik's scoping and transpilation systems work. They deliberately target exact compiled class names (e.g., `.bascik__my-comp__wrapper`) and rewritten IDs (e.g., `[id$="__btn"]`). Do not use generic `data-testid` attributes for these, as doing so would bypass verifying the actual compilation engine.
* **Application-Level E2E Tests (`docs/e2e/`):** These verify user-facing behavior of application widgets. To make them resilient to identifier minification and hashing, use standard `data-testid` attributes (e.g., `data-testid="search-input"`) with Playwright's native `page.getByTestId(...)` locator, or native accessibility-based locators like `page.getByRole(...)` and `page.getByPlaceholder(...)`.

**Adding a new e2e test:**
1. Add a component in `pkg/e2e/src/components/my-feature/`
2. Add a page in `pkg/e2e/src/pages/my-feature-test.html` with two or more instances (to verify isolation)
3. Add `pkg/e2e/tests/my-feature.test.ts` using the standard pattern:

```ts
import { test, expect } from '@playwright/test';

test.describe('my-feature-test page', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/my-feature-test'); });

  test('instances are isolated', async ({ page }) => {
    const a = page.locator('.bascik__my-feature__wrapper').nth(0);
    const b = page.locator('.bascik__my-feature__wrapper').nth(1);
    // assert A and B are independent
  });
});
```

There are 44 e2e test files covering CSS scoping, JS scoping, slots, props, attribute inheritance, animations, observers, SVG, and head components.

### Debugging with VS Code and Node.js

Bascik works smoothly with debuggers because it operates directly on vanilla HTML, CSS, and JavaScript without complex runtime abstractions or heavy bundle transformations.

#### Source Location Preservation

Debugging server-side scripts, build-time scripts, and browser component code in Bascik requires no special source map plugins or transpilation step:

* **Server and Build Scripts:** Bascik automatically appends `//# sourceURL=${relPath}` comments to temporary script modules created during compilation (`<script data-bascik-build>` and `<script data-bascik-server>`). Stack traces and debugger breakpoints point directly back to your original source file paths.
* **Client Component Scripts:** Bascik preserves newline padding when scoping component `<script>` tags. Line numbers reported in console errors or hit during step-debugging match the exact line numbers in your component `.html` source files.
* **Native TypeScript Debugging:** Because Node 22.18.0+ natively executes TypeScript files by stripping type annotations, setting breakpoints in `.ts` modules pauses execution immediately with full access to local scope variables and call stacks.

#### Pre-Configured VS Code Launch Configurations

Projects created using `npm create bascik@latest` include a pre-configured `.vscode/launch.json` file focused on testing and debugging your application. You can start debugging immediately by pressing `F5` or selecting a profile from VS Code's **Run and Debug** panel:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Dev Server",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["bascik"],
      "console": "integratedTerminal",
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Unit Tests",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["vitest", "run"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Launch Chrome",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:8080",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

#### Debugging Server Scripts and Build Steps

To debug server scripts (`<script data-bascik-server>`), build-time scripts (`<script data-bascik-build>`), or custom server logic modules:

1. Open your component `.html` file or imported `.ts` logic file in VS Code.
2. Click to the left of any line number inside your script block or function to set a breakpoint.
3. Select **Debug Dev Server** in the Run and Debug panel and press `F5`.
4. Open your browser and navigate to the page triggering the request.
5. Node.js pauses execution on your breakpoint inside VS Code. You can inspect variables, evaluate expressions in the Debug Console, step through functions, and view call stacks.

#### Debugging Unit Tests in VS Code

To step through unit test logic or component contract assertions in VS Code:

1. Open your test file (such as `my-counter.test.ts`) and set a breakpoint inside an `it()` or `describe()` block.
2. Select **Debug Unit Tests** from the Run and Debug panel and press `F5`.
3. Vitest runs the test suite under the Node.js debugger and pauses at your breakpoint before assertions complete.

#### Debugging Client Component Scripts in the Browser

To debug interactive client component scripts in Google Chrome or Microsoft Edge directly from VS Code:

1. Start the dev server using **Debug Dev Server** or `npm run dev`.
2. Select **Launch Chrome** from the Run and Debug panel and press `F5`.
3. VS Code launches a new Chrome window attached to the debugger.
4. Set breakpoints directly in your component `.html` files in VS Code, or open Chrome DevTools (`F12`), press `Cmd + P` (or `Ctrl + P`), and open virtual source files like `src/components/my-counter.html`.

### Testing Site Logic in a Bascik Project

Browser component scripts are IIFE-based and not directly importable. The recommended pattern for testing complex client-side logic:

1. **Extract pure functions** (no DOM, no `fetch`) into a sibling TypeScript `.ts` module that exports them, e.g. `search-logic.ts` alongside `docs-search.html`.
2. **Combine at build time**: use a `<script data-bascik-build>` to read both the TypeScript logic module and a DOM-wiring `.js` file, strip type annotations and `export` keywords from the module, and output a single `<script>` containing one IIFE with all functions inside it. This keeps esbuild minification working correctly with no cross-script boundary renames.
3. **Test the module with Vitest**: import the `.ts` file directly in a `*.test.ts` file. No browser or DOM required for pure function tests.

**What to test vs. skip:** DOM wiring (adding event listeners, toggling visibility) is low value to test because it depends on the compiled output. Pure data functions (parsing, scoring, formatting) are high value. Extract those into a `.ts` module and test them with Vitest. Configure Vitest in `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

**Server scripts** (`data-bascik-server`): test the business logic as pure functions in a `.ts` module. Node 24 runs `.ts` files natively with no separate build or compilation step required. Test the HTTP layer with integration tests that POST to the dev server, not by importing the script.

---

## 14. CI / CD

Two GitHub Actions workflows handle all automation.

**CI** (`.github/workflows/ci.yml`): runs on every push to `main` and every PR, two parallel jobs on Node 24:
- `test`: runs `yarn pkg:test:ci` (unit tests with coverage)
- `e2e`: builds the package (`yarn pkg:build`), installs Chromium via `playwright install chromium`, then runs `yarn pkg:e2e` (Playwright tests)
- Both jobs have `permissions: contents: read`

**Release** (`.github/workflows/release.yml`): triggers on version tags:

| Package | Tag | Job guard |
|---|---|---|
| `@bascik/bascik` | `v*.*.*` | `if: startsWith(github.ref_name, 'v')` |
| `create-bascik` | `create-v*.*.*` | `if: startsWith(github.ref_name, 'create-v')` |

Both release jobs: install → test → build → `npm publish --provenance --access public`.

- `--provenance` requires `id-token: write` permission; generates a signed attestation on npmjs.com linking the package to the Actions run.
- Both `package.json` files also declare `"publishConfig": { "access": "public" }`.
- Requires the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).

**Tagging a release:**
```sh
# @bascik/bascik
git tag v1.2.0 && git push origin main --tags

# create-bascik
git tag create-v1.0.3 && git push origin main --tags
```

`dist/` is never committed to git; the workflow always builds it fresh.

---

## 15. VS Code Extension

The `extensions/vscode-bascik/` package provides editor tooling:

* **Command-click navigation:** click a component tag like `<site-nav>` to jump to `src/components/site-nav/site-nav.html`.
* **Inline warnings:** flags CSS patterns Bascik cannot safely scope (standalone attribute selectors, element names inside `:is()`/`:where()`/`:has()`) and JS patterns that won't be rewritten (`.id =` setter, template-literal class names, `style.setProperty('--var', …)`).
* **Rules generated from the compatibility matrix:** `docs/scripts/generate-compatibility-rules.ts` reads `docs/content/compatibility.md` and writes the warning rules, so editor diagnostics stay in sync with the documented capability table automatically.

To install locally: open `extensions/vscode-bascik/` in VS Code and press F5.

---

## 16. Lighthouse 100s & Performance

Bascik gives you an enormous head start on Lighthouse scores. Because it outputs vanilla HTML with zero framework runtime, you begin every page with near-perfect scores. Reaching 100 across all four Lighthouse categories is a matter of applying a small, well-known set of HTML patterns.

### What Bascik Does
* **Zero runtime:** The most impactful thing Bascik does is what it does not add: no framework bundle, no hydration script, and no client-side router. The only JavaScript on any page is what you wrote.
* **CSS deduplication:** When a component appears multiple times on a page, Bascik emits a single `<style>` block regardless of instance count.
* **HTML minification:** HTML comments are stripped and excess whitespace is collapsed in every built page. Content inside `<pre>` blocks is left intact.
* **Script minification:** `minify.js` is `true` by default, stripping comments and whitespace.
* **Inline styles:** Set `inlineStyles` in `bascik.config.ts` to inject a stylesheet directly into `<head>`, eliminating the render-blocking HTTP request.

### Performance Patterns for Developers
* **Responsive Images (`srcset`):** Avoid sending oversized images. Use `srcset` density or width descriptors, and always include explicit `width` and `height` attributes to prevent Cumulative Layout Shift (CLS).
* **Lazy Loading (`loading="lazy"`):** Add `loading="lazy"` to below-the-fold images and iframes. Do not lazy-load above-the-fold hero images.
* **Preloading (`<link rel="preload">`):** Preload critical first-render assets, such as your hero image, critical web fonts, or early stylesheets.
* **Prefetching (`<link rel="prefetch">`):** Fetch resources or future pages during idle time if a navigation is highly likely.
* **Preconnect / DNS Prefetch:** For critical third-party domains, resolve DNS and negotiate connections early using `dns-prefetch` and `preconnect`.
* **Async and Deferred Scripts:** Use `defer` for scripts that need the DOM ready, and `async` for fully independent scripts like analytics.

---

## 17. Switch to Bascik

Detailed per-framework migration guides live at `/switch/*`. Key patterns that apply across all migrations:

- **Component files:** Rename to hyphenated `.html` files in `src/components/<name>/`. Remove framework-specific syntax (`<template>`, JSX, `.astro` frontmatter fences). The HTML file is just the component markup.
- **Scoped styles:** Delete framework scoped-style blocks (`<style scoped>`, `.module.css`). Create a paired `.css` file alongside the component HTML. Class names stay the same; Bascik scopes them at build time.
- **Slots:** `<slot />` / `children` → `data-bascik-slot` (no value) for default, `data-bascik-slot="name"` for named slots.
- **Props:** `defineProps` / component props → `data-bascik-prop-*` attributes (text only).
- **Reactive state:** `ref`, `useState`, etc. → plain `<script>` with vanilla JS. Bascik scopes `id` values so multiple instances stay independent.
- **Routing:** Client-side router → one `.html` file per URL in `src/pages/`. No dynamic segments; generate static files for parameterized routes.
- **Build-time data:** `onMounted` / `getStaticProps` / frontmatter → `<script data-bascik-build>` (Node.js ESM, stdout injected).

### From Svelte

Full guide: `/switch/from-svelte`. Key Svelte-specific mappings:

| Svelte | Bascik |
|--------|--------|
| `.svelte` file (`<script>` + markup + `<style>`) | `.html` + `.css` paired files |
| `children` snippet / `{@render children()}` (Svelte 5) | `data-bascik-slot` (no value) |
| `<slot />` (Svelte 4, deprecated) | `data-bascik-slot` (no value) |
| Named snippet prop / `{#snippet header()}` (Svelte 5) | `data-bascik-slot="x"` |
| `<slot name="x" />` (Svelte 4, deprecated) | `data-bascik-slot="x"` |
| `$props()` / `export let` | `data-bascik-prop-*` attributes |
| `$state()` / reactive variables | Vanilla JS `<script>` |
| `{#if}` / `{#each}` | Static HTML or `<script data-bascik-build>` |
| SvelteKit file routing (`+page.svelte`) | One `.html` per route in `src/pages/` |
| `onMount` data fetch | `<script data-bascik-build>` (build time) or `<script>` (runtime) |

### From Vue

Full guide: `/switch/from-vue`. Key Vue-specific mappings:

| Vue | Bascik |
|-----|--------|
| `<template>` + `<style scoped>` | `.html` + `.css` paired files |
| `<slot />` | `data-bascik-slot` (no value) |
| `<slot name="x" />` | `data-bascik-slot="x"` |
| `defineProps` | `data-bascik-prop-*` attributes |
| `ref` / `reactive` | Vanilla JS `<script>` |
| `v-if` / `v-show` | CSS `display:none` or JS toggle |
| `vue-router` | One `.html` per route in `src/pages/` |
| `onMounted` data fetch | `<script data-bascik-build>` |

### Migrating Existing Sitemap & Robots Files

When migrating an existing website to Bascik, follow this procedure for existing `sitemap.xml` and `robots.txt` files:

1. **Open and inspect the existing files:** Read the existing `sitemap.xml` and `robots.txt`.
2. **Determine if custom directives exist:** Decide whether they contain anything Bascik would not generate automatically: hand-curated URLs, `Disallow` rules for paths that still exist, a `Sitemap:` pointer to an external index, or crawl directives specific to a single bot.
3. **If they contain nothing special, delete them:** Delete the old files and let Bascik generate fresh ones automatically at build time. Do not copy them into `src/pages/`, and do not set `generate.sitemap: false` or `generate.robots: false` in `bascik.config.ts`.
4. **If they contain custom directives, keep the authored file:** Keep the authored file in `src/pages/`, turn off the matching generator in `bascik.config.ts` (`generate: { sitemap: false }` or `generate: { robots: false }`), and add a comment in the config explaining why.

**Failure Mode Warning:** Copying old sitemap and robots files into `src/pages/` while disabling Bascik's built-in generation looks superficially correct, but silently freezes the sitemap at the old site's URL list forever as new pages are created or routes change.

---

## 18. Key Constraints & Rules for AI Code Generation (MUST FOLLOW)

When generating code, pages, or components for a Bascik project, the following conventions are strictly enforced:

1. **Hyphenated Custom Tags:** Component tag names must be hyphenated (e.g. `my-nav`, `site-header`). Single-word tags are not valid custom element names.
2. **Scoping Rules:** CSS scoping only applies to paired `.css` files and inline `<style>` tags inside component HTML.
3. **Selector Rewrites:** CSS `#id {}` hash selectors are converted to component-scoped class selectors; the class is automatically injected onto the matching element. The `[id]` attribute-selector form is stripped.
4. **Script Selectors:** Use `id` and `class` selectors in JS that exactly match the attributes in the component HTML, Bascik rewrites them at build time.
5. **DOM Traversal:** For compound DOM queries, query by a single scoped `id` first, then traverse from the returned element.
6. **Dynamic Toggles:** Use `data-` attributes for runtime state that changes via JavaScript (e.g. `data-state="open"`). Scoped class names are assigned at build time and cannot be reliably looked up by JS string manipulation *unless* you utilize a scoping helper (Section 5).
7. **Text Props:** Props accept text only. For rich HTML content, use slots.
8. **Script Modules:** `<script type="module">` scripts are not wrapped in an IIFE, but their selectors are still rewritten.
9. **Non-JS Script Types:** Script tags with any `type` other than `text/javascript` (e.g. `type="application/json"`) are left completely untouched: no IIFE wrapping, no selector rewriting.
10. **Literal Tag Text Is Safe:** Component tag text inside `<script>`, `<style>`, or `<textarea>` content (e.g. `<my-card>` in a JSON-LD string or code example) is treated as text and never resolved into a component.
11. **HTML and CSS First:** Always try to use HTML and CSS before resorting to JavaScript. If a feature or layout can be implemented cleanly and without causing issues using only HTML and CSS, do it in HTML and CSS.

---

## 19. FAQ

**How do you pronounce Bascik? Where does the name come from?** Just like "basic." The idea is basic, the implementation is basic in theory, and the usage is basic. The spelling comes from the author's maternal grandmother's maiden name, so it's unique and means something personal.

**Isn't BASIC already a programming language?** Yes, the classic one from the 1960s. Used it on an old Texas Instruments calculator. Enough time has passed; it can take on new meaning.

**Who made Bascik?** Collin Thomas.

**Why was Bascik created?** To build the fastest possible websites and dashboards with components. It uses only foundational languages (HTML, CSS, and JavaScript) to let you leverage what you already know, without abstraction layers or runtime JavaScript bottlenecks.

**What happens if a component file is named after a native HTML element (e.g. `nav.html`)?**
Bascik logs a warning and still loads the component, but it will replace every occurrence of that element in pages with the component content, almost certainly breaking the site. Always use a hyphenated component name (e.g. `site-nav.html`).

**What happens with uppercase letters in a component filename (e.g. `My-Card.html`)?**
Component names are normalized to lowercase at load time. `My-Card.html` registers as `my-card` and is referenced as `<my-card>`. If two files differ only in case, the last one loaded wins. Convention: always use lowercase, hyphenated filenames.

**What happens if I reference a component that doesn't exist?**
During a build (`bascik --build`), Bascik emits a warning naming the unresolved tag, and the tag ships to the HTML output unchanged without failing the build. However, `bascik --check` currently treats an unknown hyphenated tag as an error and exits with code 1. This is why third-party custom elements (such as `<model-viewer>` or `<ion-icon>`) currently cause `--check` to fail (an upcoming update changes this validation to emit a warning instead).

