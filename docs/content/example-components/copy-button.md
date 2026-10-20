# Copy Button

Copies a text value to the clipboard and announces the result to screen readers. Each instance copies its own value.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/copy-button)

## Usage

`text` is the exact text to copy. `label` is the button text and defaults to "Copy".

<!-- demo:usage -->

```html
<copy-button
  data-bascik-prop-text="npm create bascik@rc"
  data-bascik-prop-label="Copy command"
/>
```

<!-- example:demo -->

## How It Works

- `data-bascik-attr-data-text="text"` binds the `text` prop to the button's `data-text` attribute, and the script reads `button.dataset.text`. The value travels with each instance, so there is no shared state.
- `navigator.clipboard.writeText()` needs a secure context (HTTPS or `localhost`) and can be denied. Both outcomes are written to a `role="status"` element, which screen readers announce, and cleared after two seconds.

## Adapt It

- To copy the text of a code block, read `textContent` from an element the component finds by ID instead of a prop.
- Show the result as an icon change instead of text, but keep the `role="status"` message for screen readers.
