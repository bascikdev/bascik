# Thinking in React product table, ported to Bascik

A hand port of the finished example in the React tutorial "Thinking in React"
(`reactjs/react.dev`, commit `8c68ae8`) to Bascik. It exists to check specific migration claims about
components, props, state, events, and repeated instances. It is not a starter template and says
nothing about React as a whole. The tutorial text is CC BY 4.0, see `NOTICE.md`.

The port has no dependency except Bascik. Nothing from the React ecosystem is installed.

## Run it

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

## Mapping from the original

| Original | Port |
| --- | --- |
| `FilterableProductTable` | `src/components/filterable-product-table/`, a script that owns `filterText` and `inStockOnly` |
| `SearchBar` | `src/components/search-bar/`, reports changes as a `filterchange` event |
| `ProductTable` | `src/components/product-table/`, a build script prints the rows |
| `ProductCategoryRow` | `src/components/product-category-row/` |
| `ProductRow` | `src/components/product-row/`, stock status is a `data-stocked` attribute |
| `PRODUCTS` | `src/data/products.ts` |
| `useState` | two `let` variables in the filterable table's script |
| `onChange` callbacks passed as props | a bubbling `CustomEvent`, because Bascik props are text |
| the filtered list, computed on every render | `hidden` set on rows by one `render()` function |
| sandbox stylesheet | `src/css/global.css` (body) and one stylesheet per component |
| (not in the original) | `src/pages/instances/` shows two tables on one page |

## Deliberate differences

- Rows are in the HTML before any script runs. The page is readable and the table lists every
  product with JavaScript turned off. Filtering needs JavaScript.
- The original re-renders a list. The port hides and shows rows that already exist with the
  `hidden` attribute, which also removes them from the accessibility tree.
- The out-of-stock name is red through a `data-stocked="false"` selector, where React wraps the
  name in a styled `span` only when the product is out of stock.
- The text box has an `aria-label`. The original has only a placeholder.
- Pressing Enter in the text box does not submit the form. In the original's final code it does,
  which navigates to `/?`.
- Browsers restore typed form values on Back. A controlled React input cannot disagree with its
  state, plain fields can, so the search bar reports its fields again on `pageshow`.
- Classes not defined in a component's own stylesheet stay global, so the page-level `body` rule
  keeps working.

## Bascik version

The port needs a Bascik build that includes the fixes listed in the Bascik repository's task 05
record (`1.0.0-rc.3` or later). Until that ships, install a packed local build over the registry
release: `npm install --ignore-scripts /path/to/bascik-1.0.0-rc.3.tgz`.
