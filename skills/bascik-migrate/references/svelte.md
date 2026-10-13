# From Svelte

Full guide: `read-doc.mjs /switch/from-svelte`.

| Svelte | Bascik |
|---|---|
| `.svelte` file (`<script>` + markup + `<style>`) | `.html` + `.css` companion files |
| `children` snippet / `{@render children()}` (Svelte 5) | `data-bascik-slot` (no value) |
| `<slot />` (Svelte 4) | `data-bascik-slot` (no value) |
| Named snippet prop / `{#snippet header()}` (Svelte 5) | `data-bascik-slot="x"` |
| `<slot name="x" />` (Svelte 4) | `data-bascik-slot="x"` |
| `$props()` / `export let` | `data-bascik-prop-*` attributes |
| `$state()` / reactive variables | Vanilla JS in the component `<script>` |
| `{#if}` / `{#each}` | Static HTML, or a `<script data-bascik-build>` loop |
| SvelteKit routing (`+page.svelte`) | One `.html` per route in `src/pages/` |
| SvelteKit `[slug]` with `entries` / `load` | `src/pages/blog/[slug].html` with `<script data-bascik-routes>` |
| `onMount` data fetch | `<script data-bascik-build>` (build time) or `fetch()` in a `<script>` (runtime) |

The cross-framework gotchas in the skill's main file apply: escape interpolated values, wrap named-slot content in a `<div>`, use hyphenated tag names, and target elements by `id`.
