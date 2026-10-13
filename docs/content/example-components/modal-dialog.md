# Modal Dialog

A button that opens a native modal `<dialog>`. The browser handles focus trapping, Escape, the top layer, and returning focus to the button; the component adds a close button, closing on a backdrop click, and a scroll lock.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/modal-dialog)

## Usage

`trigger` is the button text and `title` is the dialog heading, which is also its accessible name. The default slot is the dialog body.

<!-- demo:usage -->
```html
<modal-dialog data-bascik-prop-trigger="Delete project" data-bascik-prop-title="Delete this project?">
  <p>This removes every page and component. It cannot be undone.</p>
</modal-dialog>
```

<!-- example:demo -->

## How It Works

- `showModal()` puts the dialog in the top layer, makes the rest of the page inert, and moves focus inside. Closing returns focus to the button that opened it.
- A click whose target is the `<dialog>` element itself landed on the backdrop, because the dialog has no padding of its own, so the script closes it.
- `html:has(.dialog[open]) { overflow: hidden; }` stops the page scrolling behind the dialog. Bascik never renames `html`, and `.dialog` is scoped, so the rule only matches this component's dialogs.
- `aria-labelledby` on the dialog points at its heading. Bascik rewrites both IDs per instance.

## Adapt It

- For a confirmation, put a `<form method="dialog">` with two buttons inside the dialog and read `dialog.returnValue` in a `close` listener.
- To open the dialog without a script, use an invoker command: `<button commandfor="dialog" command="show-modal">`. Check its [browser support](/compatibility) first; it reached Baseline later than `<dialog>`.
