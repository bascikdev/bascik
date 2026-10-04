# Vue grid, ported to Bascik

A hand port of the official Vue example "Grid with Sort and Filter" (`vuejs/docs`, commit
`40aa88af`, shown at <https://vuejs.org/examples/#grid>) to Bascik. It exists to check specific
migration claims, not to be a starter template. The upstream example is licensed CC BY 4.0 (see
`NOTICE.md`).

The port has no Vue runtime and no dependency other than Bascik. The grid is a normal Bascik
component with a script, so the page ships a small amount of inline JavaScript for sorting and
filtering. Nothing is downloaded as a separate framework bundle.

## Run it

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
npm test         # helper tests (node:test)
```

## Mapping from the original

| Original | Port |
| --- | --- |
| `App.vue` data (`gridColumns`, `gridData`) | `src/data/grid.ts`, read by a build script in the page |
| `App.vue` `<DemoGrid :data :columns>` | `<demo-grid>` with its data in a `<script type="application/json">` slot (`src/lib/grid.ts`) |
| `App.vue` search form and `v-model="searchQuery"` | `src/components/grid-search/`, which sends a `grid-filter` event |
| `:filter-key="searchQuery"` | the `grid-filter` event, handled in `demo-grid` |
| `Grid.vue` `props` (`data`, `columns`, `filterKey`) | JSON in the slot, plus the event |
| `Grid.vue` `data()`, `computed`, `sortBy` | the script in `demo-grid.html` (`sortOrders`, `filteredData`, `sortBy`) |
| `v-for`, `v-if` / `v-else` | `<template>` elements cloned by the script, and the `hidden` attribute |
| `Grid.vue` `<style>` | `demo-grid.css` (same rules; the `th` and `td` elements come from `<template>` so they are scoped) |

`src/pages/two-grids.html` is not in the original. It puts the same components on one page twice to
check that instances keep separate state.

## Deliberate differences

- The sort control is a `<button>` inside the header cell, with `aria-sort` on the active header, so
  the grid can be used from the keyboard. The upstream header cell has only a click handler.
- The search box has a `<label>`. The upstream box has no associated label.
- Pressing Enter in the search box does not navigate. In the upstream page the form submits and
  reloads with `?query=...`, which clears the filter.
- With no match, the table is hidden instead of removed from the page, so the header cells stay in
  the DOM but are not visible.
- Without JavaScript the table is empty, as in the upstream page, which also renders nothing
  without JavaScript.
- `power: Infinity` cannot be written in JSON. `toJson` in `src/lib/grid.ts` writes it as `1e999`,
  which parses back to `Infinity`.
