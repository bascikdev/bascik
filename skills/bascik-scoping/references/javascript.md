# JavaScript Scoping Reference

## Example

```html
<!-- source -->
<button id="my-btn">Click</button>
<script>
  document.getElementById('my-btn').addEventListener('click', () => alert('hi'));
</script>
```

```html
<!-- compiled -->
<button id="bascik__my-btn__a1b2__my-btn">Click</button>
<script>
  (function () {
    document.getElementById('bascik__my-btn__a1b2__my-btn').addEventListener('click', () => alert('hi'));
  })();
</script>
```

## Scoping model

- `id` and `name` are scoped per instance. Each use of a component gets its own instance ID, derived deterministically from the page path, component name, and position.
- `class` is scoped per component (no instance ID), so instances share class names and CSS is emitted once. `scoping.deduplicateCss: false` changes this to per instance.
- Each client `<script>` is wrapped in its own IIFE when `scoping.scriptBlocks` is on (default), so separate concerns can live in separate `<script>` blocks without variable collisions.
- `<script type="module">` is not wrapped, but its selector strings are rewritten.
- Any other `type` (for example `application/ld+json`, `application/json`) is left completely untouched.

## Rewritten DOM calls

- `document.getElementById("id")`
- `querySelector` / `querySelectorAll` with `#id`, `.cls`, and compound selectors such as `.foo .bar` or `#id .child`
- `getElementsByClassName("cls")`, `getElementsByName("name")`
- `element.closest(...)`, `element.matches(...)` (event delegation works)
- `classList.add/remove/toggle/contains(...)` with one or more arguments, and `classList.replace(old, new)` (both arguments)
- `setAttribute("class" | "id" | "name", "literal")`
- `el.className = "a b"` and `el.className += " c"`
- Class names inside `innerHTML` / `insertAdjacentHTML` string literals, when the class also appears in a static `class="..."` in the template

`removeAttribute`, `hasAttribute`, and `toggleAttribute` take attribute names, so nothing needs rewriting.

## JS-only class discovery

Class names that appear only in scripts (`classList.*`, `.className` assignments, selector strings, `setAttribute('class', ...)`) are discovered and added to the component's scope map before rewriting. A modifier class such as `is-open` that never appears in the template is still scoped consistently in both the CSS and the script:

```html
<section class="card" id="card">
  <p id="status">Panel closed</p>
  <button id="toggle" type="button">Toggle</button>
</section>
<script>
  const card = document.getElementById('card');
  const status = document.getElementById('status');
  document.getElementById('toggle').addEventListener('click', () => {
    const isOpen = card.classList.toggle('is-open');
    status.textContent = isOpen ? 'Panel open' : 'Panel closed';
  });
</script>
```

The exception is `innerHTML` / `insertAdjacentHTML`: classes there are recognized only when they also appear in a static `class` attribute in the template.

## Not rewritten

- `el.id = 'value'`: look the element up by ID and keep the reference.
- `el.style.setProperty('--my-var', value)`: runtime custom property names are not rewritten; a property the component declares has a scoped name.
- Template literals: `` el.className = `box ${state}` ``. Use `classList.add/remove`.
- Template-literal arguments in `classList.replace(old, `${x}`)`.
- `querySelector("[name='username']")`: use `getElementsByName('username')`.
- Elements created with `document.createElement('td')` do not receive element-selector styles (`td {}`), because those apply to template markup through injected classes. Put the markup in a `<template>` inside the component and clone it.

## Script placement and timing

Component scripts run once per instance. Minified production HTML moves component scripts to the end of the document; the dev server and `minify.html: false` leave them in place. Never rely on a later element existing when the script starts: look it up inside an event handler or after `DOMContentLoaded`. Pre-paint scripts (theme, flash-of-unstyled-content fixes) belong in `<head>`, which keeps its order.

After Back/Forward or reload, the browser may restore form values without running your state code again. Re-sync on `pageshow`. A form with a single text input submits on Enter; call `preventDefault()` in a `submit` listener when a script drives the form.

## Communicating between components

There is no props callback. A child dispatches a bubbling event from its own element and the parent listens on its root:

```js
// child component script
document.getElementById('picker').dispatchEvent(
  new CustomEvent('color-change', { bubbles: true, detail: { color: 'red' } }),
);

// parent component script
document.getElementById('panel').addEventListener('color-change', (event) => {
  document.getElementById('swatch').style.background = event.detail.color;
});
```

## TypeScript in component scripts

Browser TypeScript is stripped automatically on two paths; no config and no `minify.js` hook are needed:

- **Companion file (default):** `<script src="counter.ts"></script>` inlines `counter.ts` with erasable types stripped and line structure preserved.
- **Inline opt-in:** `<script type="text/typescript">...</script>` is stripped and emitted as an ordinary `<script>`.
- **An unmarked `<script>` is JavaScript.** Never put annotations there. If Bascik detects erasable TypeScript in one, it warns with the two fixes above.

Order: TypeScript strip, then scoping (IIFE, selector rewriting, `//# sourceURL`), then optional `minify.js`.

The default compiler handles erasable syntax only (annotations, interfaces, type aliases, `as`, `!`, `import type`). `enum`, parameter properties, and namespaces with runtime code fail the build with the file path; prefer `as const` objects. To use another compiler, set `scripts.typescript` to a function:

```ts
// bascik.config.ts (illustrative)
import { transform } from 'esbuild';
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  scripts: {
    typescript: async (code, { sourcePath }) =>
      (await transform(code, { loader: 'ts', target: 'es2020', sourcefile: sourcePath })).code,
  },
});
```

The function receives `(code, { sourcePath, kind })` with `kind` `'companion'` or `'inline'` and must return plain JavaScript. `false` disables stripping (only when another tool already compiled the files). This option affects browser scripts only; Node-side scripts are run by Node directly.

## Debugging in the browser

- Every component script gets `//# sourceURL=src/components/<name>.html` and is padded so DevTools line N is line N of the component file. Find it with Cmd+P / Ctrl+P in DevTools Sources.
- Second and later instances appear as `card.html?instance=2`, `?instance=3`. A breakpoint pauses only the instance whose file it was set in; use a `debugger;` statement to pause every instance.
- `bascik --build` minifies JavaScript and joins lines. Line numbers hold in the dev server or with `minify.js: false`.
