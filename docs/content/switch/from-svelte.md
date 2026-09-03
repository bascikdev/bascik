# From Svelte

Svelte and Bascik share a surface-level resemblance: both use single-file components that combine markup, logic, and scoped styles in one place. The difference is in the output. Svelte compiles components to JavaScript that runs in the browser to manage reactive state and DOM updates. Bascik compiles components to vanilla HTML at build time and outputs nothing else. Switching is mostly mechanical: remove Svelte's script and template syntax, extract styles to a paired CSS file, and replace reactive primitives with vanilla JS.

## File and Folder Setup

Move your component source files into `src/components/`. The file name becomes the HTML tag name, so names must be hyphenated. Pair each component HTML file with a `.css` file in the same directory to replace Svelte's `<style>` block.

```text
Before (Svelte)              After (Bascik)
src/                         src/components/
  lib/                         site-nav/
    SiteNav.svelte               site-nav.html
    Card.svelte                  site-nav.css
    AlertBox.svelte            card/
  routes/                        card.html
    +page.svelte                 card.css
    about/                     alert-box/
      +page.svelte               alert-box.html
                                 alert-box.css
                             src/pages/
                               index.html
                               about.html
```

## Component Syntax

A Bascik component is a vanilla HTML file. There are no `<script>`, `<template>`, or `<style>` blocks in the component file itself; the HTML is the component markup. Scoped styles go in a paired `.css` file.

```html
<!-- SiteNav.svelte (Svelte - before) -->
<nav class="nav">
  <a href="/" class="logo">Acme</a>
</nav>

<style>
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

Svelte 5 replaced the `<slot />` element with snippets. The `children` snippet prop receives whatever content is placed inside the component tags. In Bascik, the equivalent is the `data-bascik-slot` attribute (no value) on the element that should receive child content. Fallback content goes inside that element and renders when the component is invoked with no children.

```html
<!-- Card.svelte (Svelte 5 - before) -->
<script>
  let { children } = $props();
</script>
<div class="card">
  {#if children}
    {@render children()}
  {:else}
    No content provided.
  {/if}
</div>

<!-- Usage -->
<Card><p>Card content here.</p></Card>
```

> **Svelte 4:** If you are migrating from Svelte 4, the equivalent is `<slot>No content provided.</slot>` in the component.

```html
<!-- src/components/card/card.html (Bascik - after) -->
<div class="card">
  <div data-bascik-slot>No content provided.</div>
</div>

<!-- Usage -->
<card><p>Card content here.</p></card>
```

## Named Slots

Svelte 5 uses named snippet props for what Svelte 4 called named slots. The component receives them via `$props()` and renders them with `{@render}`. At the usage site, named snippets are declared with `{#snippet name()}` inside the component tags. In Bascik, named slots use `data-bascik-slot="x"` on both the receiver element and the content being passed.

```html
<!-- PageLayout.svelte (Svelte 5 - before) -->
<script>
  let { header, children } = $props();
</script>
<div class="layout">
  <header>{@render header?.()}</header>
  <main>{@render children?.()}</main>
</div>

<!-- Usage -->
<PageLayout>
  {#snippet header()}<h1>My Page</h1>{/snippet}
  <p>Body content here.</p>
</PageLayout>
```

> **Svelte 4:** Named slots used `<slot name="header" />` in the component and `<svelte:fragment slot="header">` at the usage site.

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

## Props

Svelte 5's `$props()` and Svelte 4's `export let` both become Bascik's `data-bascik-prop-*` attribute system. Add the attribute (with no value) on the receiver element inside the component, then supply the text value on the component tag at the usage site.

```html
<!-- Card.svelte (Svelte 5 - before) -->
<script>
  let { title, description } = $props();
</script>
<div class="card">
  <h3>{title}</h3>
  <p>{description}</p>
</div>

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

## $state / Reactive Variables → Vanilla JS

Svelte's `$state()` (Svelte 5) and reactive variables (Svelte 4) become vanilla JavaScript in a `<script>` tag inside the component. Bascik automatically scopes `id` values and class names referenced in the script, so multiple instances on the same page work independently.

```html
<!-- Counter.svelte (Svelte 5 - before) -->
<script>
  let count = $state(0);
</script>

<div>
  <span>{count}</span>
  <button onclick={() => count++}>+</button>
</div>
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

## Template Directives → Build Scripts or Static HTML

Svelte's `{#if}`, `{#each}`, and `{@html}` template directives have no direct runtime equivalent in Bascik. Choose the right HTML at build time instead.

For static lists and conditional content, write the HTML directly. For dynamic data (files, APIs, databases), use a `<script data-bascik-build>` block in the page file.

```html
<!-- +page.svelte (Svelte - before) -->
<script>
  const items = ['Home', 'About', 'Contact'];
</script>

<ul>
  {#each items as item}
    <li>{item}</li>
  {/each}
</ul>
```

```html
<!-- src/pages/index.html (Bascik - after) -->
<ul>
  <script data-bascik-build>
    const items = ['Home', 'About', 'Contact'];
    console.log(items.map(item => `<li>${item}</li>`).join('\n'));
  </script>
</ul>
```

> **Build-time only:** `<script data-bascik-build>` runs in Node.js at build time. It has no access to the browser, the DOM, or user state. Use it for data that is known at build time and does not change per request.

## Scoped Styles → Paired .css Files

Delete Svelte's `<style>` block and create a plain `.css` file alongside the component HTML. Change nothing about the class names. Bascik scopes every class name at build time with no configuration required.

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

The class name `card` in the CSS and `class="card"` in the HTML are automatically rewritten to a unique scoped value by Bascik. No `<style>` block, no `scoped` attribute, no configuration needed.

## SvelteKit Routing → Static Pages

SvelteKit's file-based routing (`src/routes/+page.svelte`) becomes one `.html` file per route in `src/pages/`. There are no dynamic segments; each URL gets its own static file.

```text
Before (SvelteKit)           After (Bascik)
src/routes/                  src/pages/
  +page.svelte                 index.html
  about/                       about.html
    +page.svelte               blog/
  blog/                          index.html
    +page.svelte                 my-post.html
    [slug]/
      +page.svelte
```

For parameterized routes like `[slug]`, generate one HTML file per value at build time using a `<script data-bascik-build>` block in a page template, or create the files directly.
