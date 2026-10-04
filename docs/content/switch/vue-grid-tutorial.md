# Vue Grid Tutorial

This tutorial walks through a port of the official Vue example "Grid with Sort and Filter" to Bascik. A reusable grid component takes its data from outside, sorts by a clicked column header, and filters by text typed in a search box. Each section shows the Vue code and the Bascik code that replaces it. The port uses no Vue packages and ships no framework runtime.

## The Original and the Port

| | |
| --- | --- |
| Original | `vuejs/docs`, commit `40aa88af0094f7bab4aaf786e55c748a6a251d88`, `src/examples/src/grid/` (the Options API files). Shown at [vuejs.org/examples](https://vuejs.org/examples/#grid). Licensed CC BY 4.0. |
| Port | `migration-examples/ports/vue-grid/` in the Bascik repository |
| Requires | Node 24 or later, `@bascik/bascik` 1.0.0-rc.2 or later |
| Libraries | None besides Bascik |

The port's code is adapted from the original under its CC BY 4.0 license, with the attribution and a list of changes kept in `NOTICE.md`. The second dataset and the helpers are new.

The port was checked side by side with the original in Chromium, in production and development modes: the rows after every click on each header, the arrows and header colors, per-column sort order, filtering, the no-match message, mobile layout, and keyboard use. The checks compare what a visitor sees, so the same assertions run against both. A second suite changes the data (unusual text, `Infinity`, no rows, bad values) and edits files while the development server runs.

## What the Original Does

- A search box filters the rows. A row matches when any of its values, written as text, contains the typed text. Case is ignored and nothing is trimmed.
- Clicking a header sorts by that column. The first click on a column sorts descending and the second sorts ascending, because the original flips the column's order before it sorts. Each column remembers its own order.
- The arrow in each header shows that column's current order, and the active column is brighter.
- When no row matches, the table is replaced by "No matches found."
- Pressing Enter in the search box submits the form. The page reloads with `?query=...` in the address and the filter is cleared. The port does not copy this.

## Run the Port

Copy `migration-examples/ports/vue-grid/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
npm test         # helper tests
```

## Project Layout

```text
Vue (before)                       Bascik (after)
App.vue                            src/pages/index.html
  data: gridColumns, gridData      src/data/grid.ts
  search form, v-model             src/components/grid-search/
Grid.vue                           src/components/demo-grid/
  props, data, computed, sortBy      demo-grid.html  (markup and script)
  <style>                            demo-grid.css
                                   src/lib/grid.ts
                                   src/pages/two-grids.html
```

## Arrays and Objects: JSON in a Slot

`App.vue` passes two props to the grid: `columns` and `data`, an array of objects. Bascik props are text, so the page passes the data as JSON inside a `<script type="application/json">` that fills the grid's default slot. A build script reads the data and prints that element:

```html
<!-- src/pages/index.html -->
<grid-search data-bascik-prop-target="grid"></grid-search>
<demo-grid id="grid" data-testid="grid">
  <script data-bascik-build>
    import { gridColumns, gridData } from '@/data/grid.ts';
    import { renderGridData } from '@/lib/grid.ts';
    console.log(renderGridData({ columns: gridColumns, rows: gridData }));
  </script>
</demo-grid>
```

```ts
// src/lib/grid.ts
export function renderGridData(data: GridData): string {
  // `<` is escaped so no value can end the script early.
  const json = toJson(data).replaceAll('<', () => '\\u003c');
  return `<script type="application/json">${json}</script>`;
}
```

The helper is a TypeScript file, not code inside the page, because the text `</script>` cannot appear inside a script in HTML.

The example's first row has `power: Infinity`. JSON has no `Infinity`, and `JSON.stringify` writes `null`. The number literal `1e999` parses back to `Infinity`, so `toJson` writes that for `Infinity` and `-1e999` for `-Infinity`, and it throws a `RangeError` for `NaN`. A `NaN` in the data fails the build with that message instead of showing a blank cell.

## The Component

The grid's markup is a table with empty `<thead>` and `<tbody>` elements, a message, and two `<template>` elements that the script clones:

```html
<!-- src/components/demo-grid/demo-grid.html -->
<div class="grid">
  <div id="input" hidden>
    <div data-bascik-slot></div>
  </div>
  <table id="table" hidden>
    <thead><tr id="head"></tr></thead>
    <tbody id="body"></tbody>
  </table>
  <p id="empty" hidden>No matches found.</p>
  <template id="heading-template">
    <th><button type="button" class="sort"><span class="label"></span> <span class="arrow asc"></span></button></th>
  </template>
  <template id="cell-template">
    <td></td>
  </template>
</div>
```

The slot marker `<div data-bascik-slot>` is replaced by the JSON element. The script reads it back:

```js
const { columns, rows: data } = JSON.parse(document.getElementById('input').firstElementChild.textContent);
```

## Scoped Styles

`Grid.vue` has a `<style>` block with element selectors (`table`, `th`, `td`) and a few classes. The port's `demo-grid.css` keeps those rules as they are. The only additions are for the sort button, described below. Bascik scopes the rules to this component at build time.

Element selectors apply to markup written in the component's template. The `<th>` and `<td>` elements are created by the script, so they come from the two `<template>` elements, where the selectors reach them. A cell made with `document.createElement('td')` would not get the `td` rule: the padding and colors are silently missing.

## State and Computed

`data()` held `sortKey` and `sortOrders`, and a computed property filtered and sorted. In the port they are two variables and a function:

```js
const sortOrders = Object.fromEntries(columns.map((key) => [key, 1]));
let sortKey = '';
let filterKey = '';

function filteredData() {
  let rows = data;
  if (filterKey) {
    const needle = filterKey.toLowerCase();
    rows = rows.filter((row) =>
      Object.keys(row).some((key) => String(row[key]).toLowerCase().indexOf(needle) > -1));
  }
  if (sortKey) {
    const order = sortOrders[sortKey];
    rows = rows.slice().sort((a, b) => {
      a = a[sortKey];
      b = b[sortKey];
      return (a === b ? 0 : a > b ? 1 : -1) * order;
    });
  }
  return rows;
}
```

The logic is unchanged. What Vue did for you is the update: nothing re-runs `filteredData` when `sortKey` changes. The script calls `render()` after every change, and `render()` rewrites the header state and the rows.

## v-for and v-if

`v-for` becomes cloning a `<template>` and `append`. The headers are built once, and the rows are rebuilt on each `render()`:

```js
body.replaceChildren(...rows.map((row) => {
  const tr = document.createElement('tr');
  for (const key of columns) {
    const cell = cellTemplate.content.firstElementChild.cloneNode(true);
    cell.textContent = display(row[key]);
    tr.append(cell);
  }
  return tr;
}));
```

Setting `textContent` writes text, never markup, so a value such as `<img src=x onerror=...>` is shown literally. The `display` helper turns `null` and `undefined` into an empty string, as Vue's `{{ }}` does.

`v-if="filteredData.length"` with `v-else` becomes two elements and the `hidden` attribute:

```js
table.hidden = rows.length === 0;
empty.hidden = rows.length > 0;
```

The table is hidden rather than removed, so the header cells stay in the page but are not visible.

## Classes Set at Runtime

`:class="{ active: sortKey == key }"` becomes `classList.toggle`:

```js
heading.classList.toggle('active', sortKey === key);
arrow.classList.toggle('asc', ascending);
arrow.classList.toggle('dsc', !ascending);
```

Bascik rewrites the class names in these calls to the same scoped names it uses in the CSS, in production output with shortened names and in development.

## v-model and Events

In `App.vue`, `v-model="searchQuery"` on the input and `:filter-key="searchQuery"` on the grid connect the two. In the port, `grid-search` is a component of its own. It dispatches a `grid-filter` event on the grid, and the grid listens on its own element:

```html
<!-- src/components/grid-search/grid-search.html -->
<form id="search">
  <label for="query" data-bascik-prop-label>Search</label>
  <input id="query" name="query" data-bascik-attr-data-target="target">
</form>
<script>
  const form = document.getElementById('search');
  const input = document.getElementById('query');

  function sync() {
    const grid = document.getElementById(input.dataset.target);
    if (!grid) throw new Error(`grid-search: no element with id "${input.dataset.target}"`);
    grid.dispatchEvent(new CustomEvent('grid-filter', { detail: { query: input.value } }));
  }

  input.addEventListener('input', sync);
  form.addEventListener('submit', (event) => event.preventDefault());
  window.addEventListener('pageshow', sync);
</script>
```

```js
// in demo-grid.html
root.addEventListener('grid-filter', (event) => {
  filterKey = event.detail.query;
  render();
});
```

- `data-bascik-prop-target="grid"` on the page's `<grid-search>` becomes the `data-target` attribute of the input, through `data-bascik-attr-data-target`.
- The `id="grid"` on the page's `<demo-grid>` tag is passed to the grid's root element, so `getElementById('grid')` finds it. Page ids are not rewritten. See [Attribute Inheritance](/attribute-inheritance).
- `preventDefault` on `submit` stops the page reload that the original has.

## Lifecycle: Where the Script Runs

`grid-search` looks the grid up inside `sync`, when an event happens, not when its script starts. The reason is where the script runs. In production, HTML minification moves component scripts to the end of the page, so the grid exists when `grid-search`'s script runs. The development server leaves each script next to its component, and the search box comes before the grid, so the grid does not exist yet. A lookup at the top of the script would work in production and fail in development. Looking up at event time works in both.

`pageshow` runs once after the page loads and again when a visitor returns with the Back button. If the browser restored the text in the search box, `sync` filters the grid to match it. There is no `onUnmounted`: nothing is torn down, because a link loads a new page.

## Two Instances

`src/pages/two-grids.html` puts two grids and two search boxes on one page. The second search box comes after its grid. Each instance gets its own element ids, so the sort state and the filter of one grid never touch the other. The second grid has numeric `moons` data, and 95 sorts before 146 because the numbers stay numbers in the JSON.

## Accessibility

The original sorts on a click handler on the `<th>`, which a keyboard cannot reach, and its search box has no label. The port changes both, and the visible result is the same:

- Each header holds a `<button>` that fills the cell, so Tab reaches it and Enter or Space sorts. The active header has `aria-sort`.
- The search box has a `<label>`.

Automated checks cover focus order, keyboard sorting, and `aria-sort`. They do not show how a screen reader reads the grid.

## Differences from the Original

- Pressing Enter in the search box does not reload the page.
- The sort control is a button inside the header, and the search box has a label.
- The table is hidden, not removed, when nothing matches.
- Without JavaScript the table is empty, as in the original, which renders nothing without JavaScript.
- `Infinity` travels as `1e999` in JSON.
- The port adds the `two-grids` page.

## Not Covered

The example has no routing, server rendering, global state store, transition, or asynchronous data. Vue's `Transition`, `Teleport`, `provide` and `inject`, Pinia, and hydration were not ported and not claimed. This tutorial shows that one reusable, stateful widget translates directly. It does not show that a Vue application with shared state across many components does.

## Next Steps

- [From Vue](/switch/from-vue) lists each Vue concept and its Bascik counterpart.
- [Scoped JavaScript](/scoped-javascript) explains how selectors in a component script are rewritten.
- [Slots](/slots) and [Props](/props) describe the two ways to pass content into a component.
