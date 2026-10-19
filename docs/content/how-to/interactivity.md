# Interactivity

Bascik ships no runtime, so every interactive behavior is HTML, CSS, or a small component `<script>`. This page lists the patterns that work well with Bascik's scoping, from no code at all to fetch calls and events between components. The [Examples](/example-components) apply them in complete components.

## Decide in This Order

1. **An HTML element or attribute.** Many widgets need no script (see the table below).
2. **CSS.** `:has()`, `:checked`, `:target`, `:focus-within`, container queries, and `prefers-reduced-motion` cover most visual state.
3. **A small component script**, when the behavior needs code: keyboard handling, `fetch`, the clipboard, storage, or computed state.
4. **A library** such as petite-vue, Alpine.js, or HTMX, when the project already uses one. See [JavaScript Libraries](/libraries).

A framework runtime or a client-side router is never needed to make a Bascik page interactive.

## HTML First

| Need                        | Use                                                             | Notes                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accordion, FAQ, "show more" | `<details>` and `<summary>`                                     | `name="faq"` on several makes them exclusive. In a component, `name` is scoped per instance, so each instance is its own group; add `data-bascik-preserve="name"` to group across instances |
| Dropdown or popup panel     | `<button popovertarget="menu">` and `<div id="menu" popover>`   | Bascik rewrites the ID and `popovertarget` together. `popover="manual"` turns off light dismiss. See [Popover Menu](/example-components/popover-menu)                                       |
| Modal                       | `<dialog>` and `showModal()`                                    | A two-line script, or an invoker command: `<button commandfor="d" command="show-modal">`. See [Modal Dialog](/example-components/modal-dialog)                                              |
| Form rules                  | `required`, `type="email"`, `minlength`, `pattern`              | Style with `:user-invalid`, which applies only after the visitor interacts                                                                                                                  |
| Native pickers              | `<input type="date">`, `<select>`, `<datalist>`                 |                                                                                                                                                                                             |
| Page transitions            | `@view-transition { navigation: auto; }` in a global stylesheet | Cross-document view transitions; other browsers navigate normally                                                                                                                           |
| Carousel                    | `scroll-snap-type: x mandatory` on the track                    | Add buttons with a script only if needed                                                                                                                                                    |

Check newer features against [Compatibility](/compatibility) before relying on them.

## State Applied in One Place

Keep state in variables, write one function that applies all of it to the DOM, and call it after every change and once at the start. Put visual state in attributes (`aria-expanded`, `aria-pressed`, `hidden`) and style those, so the markup always says what the screen shows.

```html
<button
  class="toggle"
  id="toggle"
  type="button"
  aria-expanded="false"
  aria-controls="panel"
>
  Details
</button>
<div class="panel" id="panel" hidden>More detail.</div>
<script>
  const toggle = document.getElementById("toggle");
  const panel = document.getElementById("panel");
  let open = false;
  const render = () => {
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  };
  toggle.addEventListener("click", () => {
    open = !open;
    render();
  });
</script>
```

`aria-controls="panel"` is rewritten together with the panel's `id`, so the reference stays correct in every instance. There is no re-render: a script runs once per instance, and the elements it found stay the same.

## Rules for Component Scripts

- **Find elements with `getElementById`.** IDs are scoped per instance; classes are shared by every instance, so `querySelector('.item')` finds the first instance on the page. See [Scoped JavaScript](/scoped-javascript#pitfall-class-based-dom-lookups).
- **Reach repeated or slotted children through a container** you found by ID: `document.getElementById('items').children`.
- **Keep class names static.** `classList.add('open')` and `el.className = 'tab'` are rewritten to the scoped names; template literals are not.
- **Derive runtime IDs from a scoped ID** (`` `${root.id}-panel-${i}` ``) and set them with `setAttribute('id', ...)`, never `el.id =`.
- **Render something useful without JavaScript.** Mark script-only controls `hidden` and remove the attribute in the script.
- **Re-sync form-driven state on `pageshow`.** Back and reload can restore an input's value without firing `input`.
- **Preserve field names a server reads** with `data-bascik-preserve="name"` on the `<form>`. See [Contact Form](/example-components/contact-form).

## Fetch With Loading and Error States

```html
<button class="load" id="load" type="button">Load more</button>
<ul class="list" id="list"></ul>
<p class="status" id="status" role="status"></p>
<script>
  const load = document.getElementById("load");
  const list = document.getElementById("list");
  const status = document.getElementById("status");

  load.addEventListener("click", async () => {
    load.disabled = true;
    status.textContent = "Loading...";
    try {
      const response = await fetch("/api/items", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = await response.json();
      for (const item of items) {
        const li = document.createElement("li");
        li.textContent = item.name;
        list.append(li);
      }
      status.textContent = `${items.length} items loaded.`;
    } catch {
      status.textContent = "Could not load items. Try again.";
    } finally {
      load.disabled = false;
    }
  });
</script>
```

- Write data with `textContent`. If you must build HTML, create elements or escape every value.
- Cancel stale requests with an `AbortController` when input changes faster than responses arrive.
- When the data is the same for every visitor, fetch it at build time in a [build script](/build-scripts) instead.

## Debounce

```js
const debounce = (fn, ms = 200) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};
input.addEventListener(
  "input",
  debounce(() => search(input.value)),
);
```

## Storage

Wrap `localStorage` in `try`, because it throws in some private modes and when storage is blocked. Store small strings or JSON, version the key, and validate what you read:

```js
const KEY = "prefs:v1";
const readPrefs = () => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return typeof value === "object" && value ? value : {};
  } catch {
    return {};
  }
};
```

State that must be right on the first paint, such as the theme, belongs in a small synchronous script in `<head>`. See [Theme Toggle](/example-components/theme-toggle).

## Events Between Components

A component never reaches into another component's elements. The sender dispatches a bubbling event from its own element, and the receiver listens on `document`:

```js
// in cart-button
button.dispatchEvent(
  new CustomEvent("cart:add", {
    bubbles: true,
    detail: { sku: button.dataset.sku },
  }),
);

// in cart-count
let count = 0;
document.addEventListener("cart:add", () => {
  count++;
  badge.textContent = String(count);
});
```

Name events `<feature>:<action>` and put the data in `detail`.

## Event Delegation

For many similar children, such as slotted items or generated rows, attach one listener to the container:

```js
const list = document.getElementById("list");
list.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !list.contains(button)) return;
  button.setAttribute(
    "aria-pressed",
    String(button.getAttribute("aria-pressed") !== "true"),
  );
});
```

`closest('button')` uses an element name, which needs no rewriting. Attribute selectors in `closest` and `querySelector` are not rewritten, and the linter reports them.

## Reduced Motion

Animate in CSS and turn it off for visitors who ask:

```css
.panel {
  transition: opacity 200ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
}
```

In scripts, check `matchMedia('(prefers-reduced-motion: reduce)').matches` before smooth scrolling or a JavaScript animation.

## Accessibility Checklist

- Use real elements: `<button>` for actions, `<a href>` for navigation, and a `<label>` for every input.
- Give every control an accessible name, from its text, `aria-label`, or `aria-labelledby`.
- Expose state with `aria-expanded`, `aria-pressed`, `aria-selected`, `aria-current`, and `hidden`.
- Support the keys a pattern implies: arrow keys in tabs and menus, Escape in dialogs and popups.
- Keep focus visible, move it into a dialog when it opens, and return it to the trigger when it closes.
- Announce async results in a `role="status"` element that exists before its text changes.
- Never rely on color or hover alone.
