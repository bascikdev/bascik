# Popover Menu

A dropdown menu with no JavaScript, built on the HTML `popover` attribute. Escape and clicks outside close it. Where CSS anchor positioning is supported the menu opens below its button; elsewhere it opens in the center of the screen.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/popover-menu)

## Usage

`label` is the button text. The default slot holds the menu content, usually links or buttons.

<!-- demo:usage -->

```html
<popover-menu data-bascik-prop-label="Account">
  <a href="/example-components">All example components</a>
  <a href="/example-components/tab-group">Tab group</a>
</popover-menu>
```

<!-- example:demo -->

## How It Works

- `popovertarget="menu"` on the button opens the element with `id="menu" popover`. Bascik rewrites the ID and the reference together, so each menu on a page opens its own panel.
- The button that opens a popover is its implicit anchor. `position-area: bottom span-right` inside `@supports (position-area: bottom)` places the menu under that button.
- The component does not use `anchor-name`. Bascik scopes it per component type, not per instance, so every menu would anchor to the same button. See [Compatibility](/compatibility#names-shared-by-every-instance).

## Adapt It

- For site navigation, pass a `<ul>` of links. For actions, pass `<button>` elements.
- `popover="manual"` turns off light dismiss, for panels that should stay open until a button closes them.
