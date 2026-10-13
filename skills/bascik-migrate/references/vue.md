# From Vue

Full guide: `read-doc.mjs /switch/from-vue`.

| Vue | Bascik |
|---|---|
| `<template>` + `<style scoped>` | `.html` + `.css` companion files |
| `<slot />` | `data-bascik-slot` (no value) |
| `<slot name="x" />` / `<template #x>` | `<div data-bascik-slot="x">` around the content, in the component and at the usage site |
| `defineProps` | `data-bascik-prop-*` attributes (text only) |
| Array or object prop (`:data="rows"`) | JSON in a `<script type="application/json">` that fills the default slot; a build script prints it from a `src/lib` helper, with `<` escaped as `\u003c` |
| `$emit`, `v-model` | DOM events: `dispatchEvent(new CustomEvent(...))` and `addEventListener` |
| `ref` / `reactive` | Vanilla JS in the component `<script>`; the script updates the DOM itself |
| `v-if` / `v-show` | Build time: a build script prints one branch. Runtime: toggle the `hidden` attribute |
| `v-for` | Build-time loop in a build script, or clone a `<template>` from a script |
| `vue-router` | One `.html` per route in `src/pages/`; parameterized routes use `src/pages/blog/[slug].html` with `<script data-bascik-routes>` |
| `onMounted` data fetch | `<script data-bascik-build>` for data that is the same for everyone, `fetch()` in a component script otherwise |

Gotchas:

- Named-slot wrappers are removed. `<h1 data-bascik-slot="header">Title</h1>` produces `Title` with no `<h1>` (an `<a>` loses its `href` too). Write `<div data-bascik-slot="header"><h1>Title</h1></div>`.
- Component tag names need a hyphen. `Card.vue` becomes `info-card`; a tag named `card` warns.
- Script-created elements get no element-selector styles. CSS such as `td {}` applies to template markup. Put the markup in a `<template>` inside the component and clone it instead of `document.createElement('td')`.
- Production HTML minification moves component scripts to the end of the document; dev and `minify.html: false` leave them in place. Look elements up inside an event handler or after `DOMContentLoaded`. Use `pageshow` to resync a form value the browser restored on Back.
- `bascik --check` cannot see a component that only a build script prints and reports it as unused.
