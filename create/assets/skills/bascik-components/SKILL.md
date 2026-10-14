---
name: bascik-components
description: Write Bascik component CSS and scripts that keep working with several instances on a page. Use when writing or debugging a component's <style>, companion .css, or <script>; when a component works once but breaks with two instances; when compiled class or ID names look wrong; when adding tabs, dialogs, menus, toggles, forms, fetch calls, storage, or events between components without a framework; when setting up design tokens, dark mode, a theme toggle, or fonts; or when configuring deduplicateCss, preserve, data-bascik-preserve, or Tailwind. Includes a CSS token checker.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Component CSS, Scripts, and Theming

Bascik isolates every component at build time: it renames what a component declares and rewrites the strings that refer to it. Write a component as if it were the only one on the page, and follow the rules below so the rewrite can see everything. Requires the `bascik` skill.

## Naming scheme

```text
class  ->  bascik__<component>__<name>                  shared by every instance
id     ->  bascik__<component>__<instance>__<name>      unique per instance
name   ->  bascik__<component>__<instance>__<name>      unique per instance
p {}   ->  .bascik__<component>__el__p                  class added to template elements
--x declared in the component -> --bascik__<component>__x
```

Production builds shorten these to hashes. Never hard-code a scoped name.

## Script rules (must follow)

1. **Find per-instance elements with `getElementById`.** IDs are rewritten per instance. `querySelector('.cls')` returns the first instance on the page, so the others look dead.
2. **Reach repeated or slotted children through a container** found by ID: `document.getElementById('list').children` or `.querySelectorAll('li')` on it.
3. **Keep class names static.** `classList.add('open')` and `el.className = 'tab'` are rewritten; template literals are not.
4. **Derive runtime IDs from a scoped ID:** `` `${root.id}-panel-${i}` ``, set with `setAttribute('id', ...)`. Never `el.id =`.
5. **No attribute selectors in `querySelector` or `closest`** (`[data-x]`). They are not rewritten. Use `data-` attributes for state and style `.panel[data-state="open"]`.
6. **One function applies state to the DOM**, called after every change. Put visual state in `aria-*`, `hidden`, or `data-` attributes.
7. **Scripts run once per instance and may run late** (production moves body scripts to the end). Re-sync form-driven state on `pageshow`.
8. **Talk between components with bubbling `CustomEvent`s** listened for on `document`. Never query another component's elements.
9. **Progressive enhancement:** render something useful without JavaScript; mark script-only controls `hidden` and unhide them in the script.
10. **Forms a server reads keep their names:** `data-bascik-preserve="name"` on the `<form>`, or `FormData` keys are scoped.
11. **HTML before script:** `<details name>`, `popover`/`popovertarget`, `<dialog>`, `:user-invalid`, and `:has()` replace most widget code.

## CSS rules (must follow)

1. **Classes, element selectors, `#id`, `@keyframes`, locally declared custom properties, `@property`, `@counter-style`, container, layer, anchor, and view-transition names are scoped.** Names are shared by every instance of the component and invisible to other components.
2. **Classes the component's CSS does not define stay global**, so global helpers such as `.container` or `.skip-link` still match.
3. **Element selectors only match the component's own template**, never slotted content, child component roots, or elements a script creates. Style those with classes, or from a global stylesheet.
4. **No element names inside `:is()`, `:where()`, or `:has()`** (lint error); use classes there. **Anchor attribute selectors** on a class (`.card[data-state]`); a standalone `[data-state]` leaks, and `[id]` is stripped.
5. **`html`, `body`, and `head` are never renamed:** `html[data-theme="dark"] .card {}` works.
6. **Declare design tokens once in a global stylesheet; only read them in components** with `var(--token, fallback)`. A `:root {}` block in a component makes a private copy.
7. **`@font-face` belongs in the global stylesheet**, never in a component.

## Theming

Global tokens use `light-dark()` with `color-scheme: light dark`, and `:root[data-theme="light|dark"]` pins the scheme. A head script applies the saved choice before first paint; a toggle button saves it. Copy both: `add-example.mjs theme-toggle theme-init`, and the token stylesheet with `add-example.mjs starter-site/src/pages/css/styles.css`.

Check that every token a component reads exists:

```sh
node <skills-dir>/bascik-components/scripts/check-tokens.mjs           # errors for undeclared tokens without a fallback
node <skills-dir>/bascik-components/scripts/check-tokens.mjs --unused  # also list global tokens nothing reads
```

It reports an **error** for `var(--x)` with no declaration and no fallback, a **warn** for custom properties declared on `:root` or `html` inside a component, and **info** for undeclared tokens that have a fallback. Exit code 1 on errors.

## Examples to copy

| Example | Shows |
|---|---|
| `tab-group` | Runtime ARIA IDs from a scoped ID, arrow keys, roving `tabindex`, static class names |
| `modal-dialog` | `<dialog>` and `showModal()`, backdrop click, `html:has()` scroll lock |
| `popover-menu` | No JavaScript: `popover`, implicit anchor, `position-area` in `@supports` |
| `copy-button` | Prop bound to an attribute with `data-bascik-attr-*`, clipboard, `role="status"` |
| `filter-list` | Slotted `<li>` items reached through a container, `pageshow` re-sync |
| `contact-form` | Preserved field names, validation, JSON `fetch`, the API route behind it |
| `theme-toggle`, `theme-init` | Theme with no flash, `aria-pressed`, a `theme-change` event |

`node <skills-dir>/bascik/scripts/add-example.mjs <name>`. Each page at `https://bascik.dev/example-components/<name>` explains how it works and how to adapt it.

## Look it up

| How do I... | Read |
|---|---|
| Know exactly what CSS is scoped | `/scoped-styles`, `/compatibility#css-scoping` |
| Know which DOM calls are rewritten | `/scoped-javascript`, `/compatibility#dom-selector-rewriting` |
| Keep names literal (`preserve`, `data-bascik-preserve`) | `/preserve` |
| Pick an interactivity pattern (fetch, storage, events, delegation, a11y) | `/how-to/interactivity` |
| Set up tokens, dark mode, fonts, Tailwind | `/how-to/theming` |
| Style a child component's root from its parent | `/attribute-inheritance` |
| Use TypeScript in a component script | `/scoped-javascript#typescript-in-component-scripts` |

`node <skills-dir>/bascik/scripts/read-doc.mjs <path>` prints any of these.

## Verify

1. `node <skills-dir>/bascik/scripts/preview.mjs '<my-widget />' --count 2` and confirm each instance has its own IDs and its script references them.
2. `node <skills-dir>/bascik/scripts/verify.mjs` (runs `bascik --check`, which includes the linter, and flags `.id =`, template-literal classes, attribute selectors, and element names in `:is()`).
3. In the browser: two instances on one page, keyboard only, and JavaScript disabled.
