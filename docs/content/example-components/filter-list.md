# Filter List

A list with a live text filter. Without JavaScript the full list shows and the filter box stays hidden.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/filter-list)

## Usage

Pass `<li>` items in the default slot; the slot sits inside the component's `<ul>`. `label` labels the filter box and defaults to "Filter".

<!-- demo:usage -->
```html
<filter-list data-bascik-prop-label="Filter languages">
  <li>HTML</li>
  <li>CSS</li>
  <li>JavaScript</li>
  <li>TypeScript</li>
</filter-list>
```

<!-- example:demo -->

## How It Works

- The script reaches the items through the list it found by ID (`document.getElementById('items').children`). A page-wide `querySelectorAll('li')` would also match every other instance's items.
- Matching is case-insensitive on each item's text. A polite live region reports how many items are shown.
- The filter runs again on `pageshow`, because Back and reload can restore the input's value without an `input` event.

## Adapt It

- For long lists, debounce the input and filter a data array instead of the DOM. See [Interactivity](/how-to/interactivity#debounce).
- To filter on more than the visible text, put keywords in a `data-keywords` attribute on each item and match against both.
