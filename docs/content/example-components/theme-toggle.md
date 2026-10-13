# Theme Toggle

A button that switches between light and dark themes and remembers the choice, plus `theme-init`, which applies the saved choice before the first paint. Without a saved choice, the operating system setting applies.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/theme-toggle)

## Usage

Put `<theme-init />` in the `<head>` of every page, usually through a shared head component, and `<theme-toggle />` wherever the button belongs. Both need the `color-scheme` rules from a token stylesheet; see [Theming](/how-to/theming).

<!-- demo:usage -->
```html
<theme-toggle />
```

<!-- example:demo -->

The button above switches this page's theme. It stores the choice in `localStorage`, which this docs site does not read on the next visit.

## theme-init

<!-- example:file components/theme-init/theme-init.html -->

## How It Works

- `theme-init` runs synchronously in `<head>`, before the body renders, and sets `data-theme` on `<html>` from `localStorage`. Bascik keeps a component's script in `<head>` when the component is used there, so there is no flash of the wrong theme.
- The token stylesheet writes every color as `light-dark(light, dark)` and sets `color-scheme` from `data-theme`, so switching the attribute recolors the whole page with no other rules.
- The button exposes its state with `aria-pressed` and is `hidden` until its script runs.
- After each change it dispatches a bubbling `theme-change` event, so other components can react without reaching into this one.

## Adapt It

- For a three-way system, light, and dark choice, use a `<select>` and remove the stored value for "system". See [Theming](/how-to/theming#three-way-switch).
