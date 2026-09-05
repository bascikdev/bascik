# From Vue

Vue and Bascik are both component-driven architectures. Vue compiles Single-File Components (`.vue`) to JavaScript that executes in the browser using a reactive state system and virtual DOM. Bascik compiles components at build time to vanilla HTML and CSS, outputting zero client runtime overhead.

## When to Switch vs Keep Vue

- **Switch to Bascik:** For marketing portals, blogs, documentation sites, and content-rich pages where performance, fast loading, and minimal complexity are paramount.
- **Keep Vue:** For complex single-page applications with heavy client-side state, form wizards, or dynamic reactive workflows that depend on Vue's reactivity system (`ref`, `reactive`, Pinia).

## Mental Model Comparison

| Concept | Vue (SFC) | Bascik |
| --- | --- | --- |
| Component file | `Component.vue` (`<template>`, `<script>`, `<style>`) | `component-name.html` in `src/components/` |
| Component usage | `<ComponentName />` (imported or registered) | `<component-name></component-name>` (auto-resolved) |
| Scoped styles | `<style scoped>` | Paired `.css` file or inline `<style>` (auto-scoped) |
| Slots | `<slot />` / `<slot name="…" />` | `data-bascik-slot` / `data-bascik-slot="name"` |
| Component props | `defineProps(['title'])` | `data-bascik-prop-title` / `data-bascik-attr-*` |
| Client interactivity | `ref()`, `computed()`, directives (`v-if`, `v-for`) | Vanilla JavaScript DOM APIs in `<script>` tags |

## A Low-Risk First Step

Convert a simple Vue component into Bascik:

1. Extract your `<template>` markup into `src/components/user-card/user-card.html`.
2. Extract your `<style scoped>` into `src/components/user-card/user-card.css`.
3. Use `<user-card></user-card>` in `src/pages/index.html`.
4. Run `yarn dev` to inspect your zero-JS output.

## File and Folder Setup

Move your component source files into `src/components/`. The file name becomes the HTML tag name, so names must be hyphenated. Pair each component HTML file with a `.css` file in the same directory to replace Vue scoped styles.

```text
Before (Vue)                 After (Bascik)
src/components/              src/components/
  SiteNav.vue                  site-nav/
  Card.vue                       site-nav.html
  AlertBox.vue                   site-nav.css
                               card/
                                 card.html
                                 card.css
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

Vue's default `<slot />` maps to Bascik's `data-bascik-slot` attribute (no value). Add it to the element inside the component where child content should appear. Fallback content goes inside that element and renders when the component is invoked with no children.

```html
<!-- Card.vue (Vue - before) -->
<template>
  <div class="card">
    <slot>No content provided.</slot>
  </div>
</template>

<!-- Usage -->
<Card><p>Card content here.</p></Card>
```

```html
<!-- src/components/card/card.html (Bascik - after) -->
<div class="card">
  <div data-bascik-slot>No content provided.</div>
</div>

<!-- Usage -->
<card><p>Card content here.</p></card>
```

## Named Slots

Vue's `<slot name="…" />` maps to Bascik's `data-bascik-slot="name"` attribute. Place a receiver element with `data-bascik-slot="name"` inside the component, then pass content from the usage site using the same attribute.

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
  <h1 data-bascik-slot="header">My Page</h1>
  <p>Body content here.</p>
</page-layout>
```

## defineProps → data-bascik-prop-*

Vue's `defineProps` becomes Bascik's `data-bascik-prop-*` attribute system. Add the attribute (with no value) on the receiver element inside the component, then supply the text value on the component tag at the usage site.

```html
<!-- Card.vue (Vue - before) -->
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
<Card title="Getting Started" description="Up and running in minutes." />
```

```html
<!-- src/components/card/card.html (Bascik - after) -->
<div class="card">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-description></p>
</div>

<!-- Usage -->
<card
  data-bascik-prop-title="Getting Started"
  data-bascik-prop-description="Up and running in minutes."
></card>
```

> **Text only:** Props accept plain text strings. For rich HTML content use a named slot instead. For computed content use a `<script data-bascik-build>` block in the page.

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

Bascik rewrites both `id="count"` in the HTML and the `getElementById("count")` call in the script to the same unique scoped value. Two `<my-counter>` instances on the same page each maintain their own independent state.

## Scoped Styles → Paired .css Files

Delete Vue's `<style scoped>` block and create a plain `.css` file alongside the component HTML. Change nothing about the class names. Bascik scopes every class name at build time with no configuration or tooling required.

```css
/* src/components/card/card.css */
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

## Vue Router → One .html File Per Route

Replace `vue-router` route definitions with one `.html` file per URL in `src/pages/`. There is no client-side navigation; every link triggers a full page load.

```text
Before (Vue Router)          After (Bascik)
src/router/index.js          src/pages/
  { path: '/' }                index.html
  { path: '/about' }           about.html
  { path: '/blog/:slug' }      blog/
                                 my-first-post.html
                                 another-post.html
```

There is no dynamic routing equivalent. Each URL needs its own file. For programmatically generated pages, write a Node.js script that creates the files before running `bascik --build`.

## Computed / Watch for Data → `<script data-bascik-build>`

Data loaded with `onMounted`, `useFetch`, or similar patterns becomes a `<script data-bascik-build>` block that runs as a Node.js ESM module at build time. The script's stdout is injected into the page in place of the tag.

```html
<!-- src/pages/blog.html -->
<main>
  <h1>Blog</h1>
  <ul>
    <script data-bascik-build>
      import { readdir } from 'node:fs/promises';
      const files = await readdir('./content/posts');
      const items = files
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const slug = f.replace('.md', '');
          return `<li><a href="/blog/${slug}">${slug}</a></li>`;
        });
      console.log(items.join('\n'));
    </script>
  </ul>
</main>
```

> **Build scripts run first:** The output of a `<script data-bascik-build>` block can itself contain Bascik component tags. They are resolved in the next pass.

## v-if / v-show → Build-time or Runtime Branching

Bascik has no build-time equivalent of `v-if`. Choose one of two approaches:

- **Build-time decision:** Include the correct markup in each page's `.html` file directly. If two pages differ, they have different HTML.
- **Runtime toggle:** Render both branches, then show or hide them with CSS (`display: none`) or vanilla JS toggling a class or `data-` attribute.

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
