# From Vue

Vue and Bascik are both component-driven. Vue compiles Single-File Components (`.vue`) to JavaScript that runs in the browser with a reactive state system and a virtual DOM. Bascik compiles components at build time to vanilla HTML and CSS and ships no framework runtime.

## When to Switch vs Keep Vue

- **Switch to Bascik:** For marketing portals, blogs, documentation sites, and content-rich pages where performance, fast loading, and minimal complexity are paramount.
- **Keep Vue:** For complex single-page applications with heavy client-side state, form wizards, or dynamic reactive workflows that depend on Vue's reactivity system (`ref`, `reactive`, Pinia).

A client widget in Bascik ships only the inline script it needs, with no framework runtime. That figure says nothing about a large application, where Vue's state tools do work you would otherwise write yourself.

## Mental Model Comparison

| Concept | Vue (SFC) | Bascik |
| --- | --- | --- |
| Component file | `InfoCard.vue` (`<template>`, `<script>`, `<style>`) | `info-card.html` in `src/components/info-card/` |
| Component usage | `<InfoCard />` (imported or registered) | `<info-card></info-card>` (auto-resolved by file name) |
| Scoped styles | `<style scoped>` | Paired `.css` file or inline `<style>` (auto-scoped) |
| Slots | `<slot />` / `<slot name="…" />` | `data-bascik-slot` / `data-bascik-slot="name"` |
| Component props | `defineProps(['title'])` | `data-bascik-prop-title` / `data-bascik-attr-*` (text only) |
| Arrays and objects as props | `:data="rows"` | JSON in a `<script type="application/json">` slot |
| Events up (`$emit`, `v-model`) | `emit('change')`, `@change` | DOM events, `CustomEvent`, `addEventListener` |
| Client interactivity | `ref()`, `computed()`, directives (`v-if`, `v-for`) | Vanilla JavaScript DOM APIs in `<script>` tags |
| Routes | `vue-router` | One `.html` file per URL, or a [dynamic route](/dynamic-routes) |

## A Low-Risk First Step

Convert a simple Vue component into Bascik:

1. Create a project with `npm create bascik@latest`.
2. Extract your `<template>` markup into `src/components/user-card/user-card.html`.
3. Extract your `<style scoped>` into `src/components/user-card/user-card.css`.
4. Use `<user-card></user-card>` in `src/pages/index.html`.
5. Run `npm run dev` to inspect the output.

## File and Folder Setup

Move your component source files into `src/components/`. The file name becomes the HTML tag name, so names must be hyphenated: `Card.vue` becomes `info-card`, because a tag named `card` has no hyphen and Bascik warns that it may collide with a future HTML element. Pair each component HTML file with a `.css` file in the same directory to replace Vue scoped styles.

```text
Before (Vue)                 After (Bascik)
src/components/              src/components/
  SiteNav.vue                  site-nav/
  InfoCard.vue                   site-nav.html
  AlertBox.vue                   site-nav.css
                               info-card/
                                 info-card.html
                                 info-card.css
                               alert-box/
                                 alert-box.html
                                 alert-box.css
```

## Component Syntax

A Bascik component is a vanilla HTML file. There are no `<template>`, `<script setup>`, or `<style>` blocks. The file name (minus the extension) is the tag name.

```html
<!-- SiteNav.vue (Vue - before) -->
<template>
  <nav class="nav">
    <a href="/" class="logo">Acme</a>
  </nav>
</template>

<style scoped>
.nav { display: flex; gap: 16px; }
.logo { font-weight: bold; }
</style>
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <a href="/" class="logo">Acme</a>
</nav>
```

```css
/* src/components/site-nav/site-nav.css */
.nav { display: flex; gap: 16px; }
.logo { font-weight: bold; }
```

No import or registration is needed to use this component. Bascik resolves `<site-nav></site-nav>` to `src/components/site-nav/site-nav.html` automatically by tag name.

## Default Slot

Vue's default `<slot />` maps to Bascik's `data-bascik-slot` attribute (no value). Add it to the element inside the component where child content should appear. The element is replaced by the slot content. Fallback content goes inside that element and renders when the component is used with no children.

```html
<!-- InfoCard.vue (Vue - before) -->
<template>
  <div class="card">
    <slot>No content provided.</slot>
  </div>
</template>

<!-- Usage -->
<InfoCard><p>Card content here.</p></InfoCard>
```

```html
<!-- src/components/info-card/info-card.html (Bascik - after) -->
<div class="card">
  <div data-bascik-slot>No content provided.</div>
</div>

<!-- Usage -->
<info-card><p>Card content here.</p></info-card>
```

The output is `<div class="card"><p>Card content here.</p></div>`. The marker `<div>` does not appear in it.

## Named Slots

Vue's `<slot name="…" />` maps to `data-bascik-slot="name"`. Place a marker element with `data-bascik-slot="name"` inside the component, then wrap the content for that zone in an element with the same attribute at the usage site. Both elements are markers: Bascik removes them and keeps what is inside.

```html
<!-- PageLayout.vue (Vue - before) -->
<template>
  <div class="layout">
    <header><slot name="header" /></header>
    <main><slot /></main>
  </div>
</template>

<!-- Usage -->
<PageLayout>
  <template #header><h1>My Page</h1></template>
  <p>Body content here.</p>
</PageLayout>
```

```html
<!-- src/components/page-layout/page-layout.html (Bascik - after) -->
<div class="layout">
  <header><div data-bascik-slot="header"></div></header>
  <main><div data-bascik-slot></div></main>
</div>

<!-- Usage -->
<page-layout>
  <div data-bascik-slot="header"><h1>My Page</h1></div>
  <p>Body content here.</p>
</page-layout>
```

> **The wrapper is removed.** The usage-site element that carries `data-bascik-slot="header"` is the Vue `<template #header>` equivalent, not the content. Writing `<h1 data-bascik-slot="header">My Page</h1>` produces `<header>My Page</header>`, and the `<h1>` is lost. The same applies to an `<a>`: its `href` disappears with the tag. Put the real element inside the wrapper.

## defineProps → data-bascik-prop-*

Vue's `defineProps` becomes Bascik's `data-bascik-prop-*` attribute system. Add the attribute (with no value) on the receiver element inside the component, then supply the text value on the component tag at the usage site.

```html
<!-- InfoCard.vue (Vue - before) -->
<script setup>
defineProps({ title: String, description: String });
</script>
<template>
  <div class="card">
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
  </div>
</template>

<!-- Usage -->
<InfoCard title="Getting Started" description="Up and running in minutes." />
```

```html
<!-- src/components/info-card/info-card.html (Bascik - after) -->
<div class="card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-description></p>
</div>

<!-- Usage -->
<info-card
  data-bascik-prop-title="Getting Started"
  data-bascik-prop-description="Up and running in minutes."
></info-card>
```

Prop values are escaped when they are written, so `<b>` and `&` in a value show as text. Use `data-bascik-attr-{name}="prop"` to send a prop to an attribute instead of the element's content.

> **Text only.** Props are plain strings with no types, so there is no `Number`, `Boolean`, `Array`, or `Object`. For rich HTML use a named slot. For computed content use a `<script data-bascik-build>` block in the page.

### Arrays and objects

Vue passes an array to a component with `:data="rows"`. In Bascik, a build script prints the data as JSON inside a `<script type="application/json">` that fills the component's default slot, and the component's script parses it:

```html
<!-- usage in a page -->
<data-grid>
  <script data-bascik-build>
    import { rows } from '@/data/rows.ts';
    import { jsonScript } from '@/lib/json-script.ts';
    console.log(jsonScript({ rows }));
  </script>
</data-grid>
```

```ts
// src/lib/json-script.ts
// Escape `<` so no value can end the script early.
export const jsonScript = (value: unknown) =>
  `<script type="application/json">${JSON.stringify(value).replaceAll('<', () => '\\u003c')}</script>`;
```

```html
<!-- src/components/data-grid/data-grid.html -->
<div hidden id="input"><div data-bascik-slot></div></div>
<script>
  const { rows } = JSON.parse(document.getElementById('input').firstElementChild.textContent);
</script>
```

JSON has no `Infinity`, `NaN`, `undefined`, dates, or `Map`. `JSON.stringify` turns `Infinity` into `null`.

## Events and v-model → DOM Events

`$emit` and `v-model` have no compiler support in Bascik, and they do not need it. Components talk through DOM events: one component dispatches a `CustomEvent`, and another listens for it.

```html
<!-- Vue: the parent binds the child's input to a prop -->
<input v-model="searchQuery">
<DemoGrid :filter-key="searchQuery" />
```

```html
<!-- Bascik: the input announces its value, and the grid listens on its own element -->
<script>
  input.addEventListener('input', () => {
    grid.dispatchEvent(new CustomEvent('grid-filter', { detail: { query: input.value } }));
  });
</script>
```

Attributes you put on a component tag, such as `id` and `data-testid`, land on its first root element, so the page can find the grid by `id`. See [Attribute Inheritance](/attribute-inheritance).

## ref / reactive → Vanilla JS

Vue's `ref`, `reactive`, and event handlers become vanilla JavaScript in a `<script>` tag inside the component. Bascik automatically scopes `id` values and class names referenced in the script, so multiple instances on the same page work independently.

```html
<!-- Counter.vue (Vue - before) -->
<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>
<template>
  <div>
    <span>{{ count }}</span>
    <button @click="count++">+</button>
  </div>
</template>
```

```html
<!-- src/components/my-counter/my-counter.html (Bascik - after) -->
<div>
  <span id="count">0</span>
  <button id="btn">+</button>
</div>
<script>
  const countEl = document.getElementById("count");
  document.getElementById("btn").addEventListener("click", () => {
    countEl.textContent = String(Number(countEl.textContent) + 1);
  });
</script>
```

Bascik rewrites both `id="count"` in the HTML and the `getElementById("count")` call in the script to the same unique scoped value. Two `<my-counter>` instances on the same page each keep their own count. State is an ordinary JavaScript variable or a DOM attribute. Nothing re-renders for you: the script updates the DOM itself.

### Lifecycle: where a script runs

There is no `onMounted` or `onUnmounted`. A component script runs once per instance, when the browser reaches it, and a page is never unmounted: a link loads a new document. Two rules follow:

- **Do not rely on elements that come later in the document.** In production, HTML minification moves component scripts to the end of the page, so every element exists. The development server and `minify.html: false` leave each script where its component is, so a later element does not exist yet. Look up other elements when you need them (inside an event handler), or wait for `DOMContentLoaded`. A script that works in both places never depends on the difference.
- **Use `pageshow` for back navigation.** When a visitor returns with the Back button, the browser can restore a page, including form values, from its cache without running scripts again. Listen for `pageshow` to bring the page in line with a restored form value.

## Scoped Styles → Paired .css Files

Delete Vue's `<style scoped>` block and create a plain `.css` file alongside the component HTML. Keep the class names. Bascik scopes every class name at build time with no configuration or tooling required.

```css
/* src/components/info-card/info-card.css */
.card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 24px;
}

.card h3 {
  margin: 0 0 8px;
  font-size: 1.1rem;
}
```

Element selectors such as `h3` and `td` apply to the elements written in the component's template. They do not reach an element a script creates with `document.createElement('td')`, because Bascik adds the scoping to template markup at build time. Put the markup a script needs in a `<template>` element inside the component and clone it. Selectors apply to the content of a `<template>`:

```html
<template id="cell-template"><td></td></template>
<script>
  const cell = document.getElementById('cell-template').content.firstElementChild.cloneNode(true);
</script>
```

## Vue Router → Files and Dynamic Routes

Replace `vue-router` route definitions with files in `src/pages/`. There is no client-side navigation: every link loads a new page. A fixed route is one `.html` file, and a route with a parameter is a dynamic route, a file whose name has brackets:

```text
Before (Vue Router)          After (Bascik)
src/router/index.js          src/pages/
  { path: '/' }                index.html
  { path: '/about' }           about.html
  { path: '/blog/:slug' }      blog/
                                 [slug].html
```

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-routes>
  console.log(JSON.stringify([
    { params: { slug: 'my-first-post' }, data: { title: 'My First Post' } },
    { params: { slug: 'another-post' }, data: { title: 'Another Post' } },
  ]));
</script>
<h1>Post</h1>
<script data-bascik-build>
  const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');
  console.log(`<p>${route.params.slug}</p>`);
</script>
```

This writes `dist/blog/my-first-post.html` and `dist/blog/another-post.html`. Name the file `[slug]/index.html` to get `/blog/my-first-post/` instead. Do not generate page files into `src/pages/`. See [Dynamic Routes](/dynamic-routes).

Route guards, nested layouts with `<RouterView>`, and `<RouterLink>` active classes have no direct equivalent. A layout is a set of components that each page uses, and an active link is computed at build time from the page path ([Page-Aware Scripts](/how-to/page-aware-scripts)).

## Computed / Watch for Data → `<script data-bascik-build>`

Data you load once for a page becomes a `<script data-bascik-build>` block that runs as a Node.js ESM module at build time. The script's stdout is injected into the page in place of the tag. Escape every value you print, because the output is markup:

```ts
// src/lib/escape.ts
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
```

```html
<!-- src/pages/blog/index.html -->
<main>
  <h1>Blog</h1>
  <ul>
    <script data-bascik-build>
      import { readdir } from 'node:fs/promises';
      import { escapeHtml } from '@/lib/escape.ts';
      const files = await readdir('./content/posts');
      const slugs = files
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .filter((slug) => /^[a-z0-9-]+$/.test(slug));
      console.log(slugs.map((slug) => `<li><a href="/blog/${escapeHtml(slug)}">${escapeHtml(slug)}</a></li>`).join('\n'));
    </script>
  </ul>
</main>
```

A fetch in `onMounted` stays a `fetch()` in a component script if the data must be fresh for each visitor. Data that is the same for everyone belongs in a build script.

> **Build scripts run first:** The output of a `<script data-bascik-build>` block can itself contain Bascik component tags. They are resolved in the next pass. `bascik --check` cannot see a tag that only a build script prints, so it can report that component as unused.

## v-if / v-show / v-for → Build Scripts, `hidden`, and Templates

Pick the mechanism by when the decision is made:

- **Known at build time:** a build script prints only the branch that applies. A condition on `process.env.BASCIK_BUILD` (`"1"` for `bascik --build`, `"0"` for the development server), on route data, or on a content file costs nothing in the browser.
- **Decided in the browser:** render both and toggle the `hidden` attribute from a script. `v-if` / `v-else` becomes two elements and `element.hidden = !condition`. An author rule such as `display: flex` on the same element overrides `hidden`, so toggle a wrapper or add `[hidden] { display: none }`.
- **Lists:** `v-for` over build-time data is a loop in a build script. `v-for` over data that changes in the browser is a `<template>` that the script clones for each item.

## Before and After: Navigation Component

A realistic nav with a logo slot, link list, and mobile menu toggle.

```html
<!-- SiteNav.vue (Vue - before) -->
<script setup>
import { ref } from 'vue';
const open = ref(false);
defineProps({ logo: String });
</script>
<template>
  <nav class="nav">
    <div class="logo">{{ logo }}</div>
    <button class="toggle" :aria-expanded="open" @click="open = !open">Menu</button>
    <ul :class="['links', { open }]">
      <slot />
    </ul>
  </nav>
</template>
<style scoped>
.nav { display: flex; align-items: center; gap: 16px; }
.links { display: none; }
.links.open { display: flex; }
</style>
```

```html
<!-- src/components/site-nav/site-nav.html (Bascik - after) -->
<nav class="nav">
  <div class="logo" data-bascik-prop-logo></div>
  <button id="toggle" class="toggle" aria-expanded="false">Menu</button>
  <ul id="links" class="links">
    <div data-bascik-slot></div>
  </ul>
</nav>
<script>
  const toggle = document.getElementById("toggle");
  const links = document.getElementById("links");
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(next));
    links.classList.toggle("open", next);
  });
</script>
```

```css
/* src/components/site-nav/site-nav.css */
.nav { display: flex; align-items: center; gap: 16px; }
.links { display: none; }
.links.open { display: flex; }
```

Usage:

```html
<site-nav data-bascik-prop-logo="Acme">
  <li><a href="/">Home</a></li>
  <li><a href="/about">About</a></li>
</site-nav>
```

The slot marker sits inside the `<ul>` in the source and is replaced by the `<li>` items, so the output is a valid list.
