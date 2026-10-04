# Product Table Tutorial

This tutorial ports the finished example from React's "Thinking in React" tutorial, a searchable product table, to Bascik. It covers a component hierarchy, props, state that lives in a parent, a child that reports input back up, repeated instances, and the places where Bascik and React do different work. It is a component exercise, not a site, so it says nothing about routing, data fetching, or React as a whole.

## The Original and the Port

| | |
| --- | --- |
| Original | "Thinking in React", `reactjs/react.dev`, commit `8c68ae8d2410abe59f351195780c6f8ea9f50904`, the final `App.js` of step 5 (CC BY 4.0, Meta Platforms, Inc. and affiliates) |
| Port | `migration-examples/ports/react-product-table/` in the Bascik repository |
| Requires | Node 24 or later, `@bascik/bascik` 1.0.0-rc.2 or later |
| Libraries | none besides Bascik |

The port is adapted from the tutorial under its license, and the attribution is kept in `NOTICE.md`. No code is shared with the original: React components became Bascik components, and the sample data is the tutorial's.

The original was built with React 19.3.0 and Vite 8.3.1 from a committed lockfile, and the port was checked beside it in a real browser, in production and development modes. Both were put through the same checks: the rows, the grouping, the red out-of-stock names, the computed styles, filtering by text and by stock, keyboard use, a phone-sized window, going away and coming Back, and the accessible names. Edits to the data (hostile text, an empty list, ungrouped categories) were checked in the port only.

## Run the Port

Copy `migration-examples/ports/react-product-table/` out of the repository into its own folder, then:

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

The `dev` and `build` scripts pass `--site-url https://example.com`, because the built-in sitemap and robots files need an absolute origin. Replace it with your own.

## Project Layout

```text
React (before)                    Bascik (after)
src/App.js                        src/components/
  FilterableProductTable            filterable-product-table/  (html)
  SearchBar                         search-bar/                (html, css)
  ProductTable                      product-table/             (html, css)
  ProductCategoryRow                product-category-row/      (html, css)
  ProductRow                        product-row/               (html, css)
  PRODUCTS                        src/data/products.ts
styles.css                        src/css/global.css
                                  src/lib/escape.ts
                                  src/pages/index.html  instances/index.html
                                  bascik.config.ts
```

Each React function becomes a directory with an `.html` file, and a `.css` file if it has styles. The tag name is the folder name, with a hyphen, so `FilterableProductTable` is `<filterable-product-table>`.

## Step 1: The Static Version

React's step 2 builds the table with no state. The two row components become templates whose values arrive as props:

```html
<!-- src/components/product-category-row/product-category-row.html -->
<tr data-category>
  <th colspan="2" data-bascik-prop-category></th>
</tr>
```

```html
<!-- src/components/product-row/product-row.html -->
<tr data-bascik-attr-data-name="name" data-bascik-attr-data-stocked="stocked">
  <td><span class="name" data-bascik-prop-name></span></td>
  <td data-bascik-prop-price></td>
</tr>
```

```css
/* src/components/product-row/product-row.css */
td {
  padding: 2px;
}

[data-stocked="false"] .name {
  color: red;
}
```

Three things changed on the way:

- **Props are text.** `product={product}` passed an object. Bascik passes one text value per `data-bascik-prop-*` attribute, so the row receives `name`, `price`, and `stocked` separately. `stocked` arrives as the string `"true"` or `"false"`.
- **A prop can go to an attribute.** `data-bascik-attr-data-stocked="stocked"` copies the prop onto the row as `data-stocked`. React used a conditional `<span style={{ color: 'red' }}>`. Here the span is always there and the stylesheet decides, with an attribute selector, which names are red. Both rules stay in the component's own CSS and are scoped to it.
- **The directive attributes disappear.** None of the `data-bascik-*` attributes is in the output.

`ProductTable` loops over the products and prints a category row whenever the category changes. That loop moves into a build script:

```html
<!-- src/components/product-table/product-table.html -->
<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Price</th>
    </tr>
  </thead>
  <tbody>
    <script data-bascik-build>
      import { PRODUCTS } from '@/data/products.ts';
      import { escapeHtml } from '@/lib/escape.ts';

      const rows = [];
      let lastCategory = null;
      for (const product of PRODUCTS) {
        if (product.category !== lastCategory) {
          rows.push(`<product-category-row data-bascik-prop-category="${escapeHtml(product.category)}"></product-category-row>`);
        }
        rows.push(
          `<product-row data-bascik-prop-name="${escapeHtml(product.name)}" ` +
          `data-bascik-prop-price="${escapeHtml(product.price)}" ` +
          `data-bascik-prop-stocked="${product.stocked}"></product-row>`,
        );
        lastCategory = product.category;
      }
      console.log(rows.join('\n'));
    </script>
  </tbody>
</table>
```

The script runs once, at build time, in Node. What it prints replaces the tag, and component tags in that output are resolved afterward. JSX escaped the values for you. A template string does not, so `escapeHtml` is called on every value. The port's edit tests put `<img src=x onerror=alert(1)>`, quotes, `$&` and `</td></tr><script>` into the product data. They show up as text, no element is added, and no script runs.

The product list is a TypeScript module that the script imports, in place of the constant at the bottom of `App.js`:

```ts
// src/data/products.ts
export interface Product {
  category: string;
  price: string;
  stocked: boolean;
  name: string;
}

export const PRODUCTS: Product[] = [
  { category: 'Fruits', price: '$1', stocked: true, name: 'Apple' },
  // ...
];
```

With `src/data/` in `pipeline.watchPaths`, the development server rebuilds the page when this file changes. A page that is open reloads, and the filter you typed is gone, because the page is new. A syntax error in the data does not stop the server. The next good save recovers it. A production build with the same error fails, names the problem, and leaves no stale `index.html`.

The rows are in the HTML before any script runs. With JavaScript turned off the page still lists every product. The original is an empty `<div id="root">` until its bundle has loaded and run.

## Step 2: The Search Bar

React's `SearchBar` was a controlled form: two `value` props in, two `onChange` callbacks out. The Bascik version owns no state. It reports what changed.

```html
<!-- src/components/search-bar/search-bar.html -->
<form id="form">
  <input type="text" id="text" placeholder="Search..." aria-label="Search products">
  <label>
    <input type="checkbox" id="stock">
    Only show products in stock
  </label>
</form>
<script>
  const form = document.getElementById('form');
  const text = document.getElementById('text');
  const stock = document.getElementById('stock');

  function report() {
    form.dispatchEvent(new CustomEvent('filterchange', {
      bubbles: true,
      detail: { filterText: text.value, inStockOnly: stock.checked },
    }));
  }
  text.addEventListener('input', report);
  stock.addEventListener('change', report);
  window.addEventListener('pageshow', report);
  form.addEventListener('submit', (event) => event.preventDefault());
</script>
```

This is React's step 5, inverse data flow, in a different mechanism. A callback cannot be a prop, so the child dispatches a bubbling `CustomEvent`. Whoever owns the state listens for it.

Two lines have no counterpart in the tutorial, and both came from running the original beside the port:

- **`submit` with `preventDefault()`.** The original's final code has no `onSubmit` handler. Pressing Enter in its text box submits the form and the page navigates to `/?`, and the harness records that as an upstream behavior. A script-driven form in Bascik should not reload.
- **`pageshow`.** A controlled React input always shows its state. A plain input can show something else after the browser restores typed values on Back. The port's first version filtered the table with a stale state while the text box held a restored `zzz`, so the page showed 16 rows when the filter matched none. Reporting the fields again on `pageshow` makes the script agree with the page. The history check runs against both sites.

The `aria-label` is an addition. The original has only a placeholder.

The component's ids are scoped per instance and the `getElementById` calls are rewritten to match, so this is safe to use twice on one page. The `<label>` wraps its checkbox and needs no `for`.

## Step 3: State Lives in the Parent

React's step 4 puts `filterText` and `inStockOnly` in `FilterableProductTable`, the closest common parent of the search bar and the table. The Bascik parent does the same, in a script:

```html
<!-- src/components/filterable-product-table/filterable-product-table.html -->
<div id="root">
  <search-bar></search-bar>
  <product-table></product-table>
</div>
<script>
  const root = document.getElementById('root');

  let filterText = '';
  let inStockOnly = false;

  function render() {
    const needle = filterText.toLowerCase();
    let categoryRow = null;
    let categoryHasRows = false;
    const finishCategory = () => { if (categoryRow) categoryRow.hidden = !categoryHasRows; };
    for (const row of root.querySelectorAll('tbody > tr')) {
      if (row.hasAttribute('data-category')) {
        finishCategory();
        categoryRow = row;
        categoryHasRows = false;
        continue;
      }
      const name = row.getAttribute('data-name') ?? '';
      const stocked = row.getAttribute('data-stocked') === 'true';
      const visible = name.toLowerCase().includes(needle) && !(inStockOnly && !stocked);
      row.hidden = !visible;
      if (visible) categoryHasRows = true;
    }
    finishCategory();
  }

  root.addEventListener('filterchange', (event) => {
    filterText = event.detail.filterText;
    inStockOnly = event.detail.inStockOnly;
    render();
  });
</script>
```

Compare it with React's step 3, which said the filtered list is not state because it can be computed. The same rule holds here: the script keeps two variables and recomputes everything else on every change. What is different is who does the work. React calls the component again and diffs the result. Here `render()` is your code, and it changes the DOM directly. It hides and shows rows that already exist with the `hidden` attribute, which also removes them from the accessibility tree.

The rules from the tutorial all carry over, and the harness runs each one against both sites:

- The match is on the name only, case-insensitive, anywhere in the name.
- A category heading appears only when at least one of its rows does.
- A search that matches nothing keeps the header and shows no rows.
- A space matches only names that contain one.
- Products that are not grouped repeat their category heading, the same as the original loop.

The stock checkbox and the text box compose, and clearing both restores all eight rows.

## Step 4: Two Instances on One Page

The tutorial has one table. The port adds `src/pages/instances/index.html` with two, to check the claim the old guide made without evidence: that each instance of a component keeps its own state.

```html
<section aria-label="First table" data-testid="first">
  <filterable-product-table></filterable-product-table>
</section>
<section aria-label="Second table" data-testid="second">
  <filterable-product-table></filterable-product-table>
</section>
```

Filtering the first leaves the second alone, and checking the stock box in the second leaves the first's text and checkbox as they were. Clicking the text of a label toggles its own checkbox. Each parent hears only the events of the search bar that sits inside it, since the event bubbles from the search bar up to the nearest parent. The test uses `data-testid` and role queries, because production output hashes ids and class names.

## What the Browser Receives

In the production build, with identifier minification on:

| | React original | Bascik port |
| --- | --- | --- |
| Script files or blocks | 1 bundle | 2 inline blocks |
| Script bytes | 221,381 | 1,470 |
| Rows without JavaScript | none | all 8 |
| Enter in the text box | navigates to `/?` | stays on the page |

The bundle holds the React runtime and the app. The two inline blocks are the search bar and the parent, wrapped in an IIFE each with a `//# sourceURL` comment that points DevTools back to the component file. These numbers are for this example and this lockfile. They are not a comparison of the frameworks.

## What Does Not Carry Over

- **No re-render.** Anything the page shows twice, for instance a count of matching rows, must be written to both places by your function. There is no diff.
- **No props for functions or objects.** Events replace callbacks. Per-item values are separate text props, or an attribute.
- **Passing `children` through a wrapper.** A default slot marker placed between a nested component's tags receives the outer component's content (1.0.0-rc.3 or later). This example does not need it. The [From React](/switch/from-react#composing-components) guide shows how.
- **`bascik --check` cannot see components that only a build script prints.** `product-row` and `product-category-row` are used by the build script in `product-table`, so the check reports them as unused. The build works.
- **No stable state across reloads.** Rebuilding the page, or reloading it, starts from the beginning. React state does too, but a React tool can keep it across hot updates.
- **Script placement differs between modes.** Production HTML minification moves component scripts to the end of the document, and the development server leaves them in place. The port's scripts look elements up by id and run listeners later, so both behave the same.
- **Development has no 404 difference to port.** For the record, Vite's development server answers every unknown path with `index.html`. Bascik's returns a 404.

## Not Exercised

This port does not exercise React context, effects, refs, Suspense, server components, hydration, routing libraries, or form libraries. It is a controlled form, a lifted state, and a filter. Accessibility was checked by role queries, focus order, and the keyboard only. It has not been tested with a screen reader. Browsers other than Chromium were not used.

## Summary

| React | Bascik |
| --- | --- |
| Function component | `.html` file in `src/components/<name>/` |
| `props.x` | `data-bascik-prop-x`, text only |
| Prop in an attribute | `data-bascik-attr-*` |
| `useState` in the common parent | variables in the parent component's script |
| `onChange` callback prop | a bubbling `CustomEvent` from the child |
| Render returns a filtered list | a function that sets `hidden` on existing rows |
| `.map()` over data | a build script that prints component tags |
| Conditional style | a data attribute and a CSS selector |
| `StrictMode` double render | nothing |
