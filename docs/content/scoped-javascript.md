# Scoped JavaScript

Write `<script>` tags directly in your component HTML. Bascik automatically rewrites selector strings to match each instance's unique identifiers. Multiple instances of the same component on the same page stay completely independent. TypeScript is supported too. See [TypeScript in Component Scripts](#typescript-in-component-scripts).

## See it in action

These two counters are independent. Change either count and the other stays put.

## Writing Component Scripts

> **Key rule.** Use `id` attributes to identify elements you need to control in JS, and `getElementById` to find them. Bascik scopes each instance's `id` values uniquely, so every call returns exactly the right element.

A component script looks like ordinary JavaScript. Declare `id` on any element you need to reference, then use `getElementById`. Bascik rewrites the strings at build time:

Open Source → JS in the counter demo to see ordinary event listeners and `getElementById` calls. Output → JS shows the rewritten selectors and instance wrapper that Bascik generates.

## Multiple Script Blocks

Component templates can contain multiple `<script>` tags. Bascik processes each script tag according to its attributes:

- **Client scripts:** Standard JavaScript blocks are each wrapped in an isolated IIFE `(function() { ... })();` when `scopeScriptBlocks` is enabled. If you include multiple client `<script>` tags in a single component, each runs in its own IIFE so local variables do not collide.
- **Local script files (`<script src="counter.ts">`):** References to local `.ts`, `.js`, or `.mjs` files inside the component's directory are resolved and inlined at build time, then scoped and wrapped as client scripts.
- **Build scripts (`<script data-bascik-build>`):** Executed during build/dev time in Node.js to generate dynamic markup. Can also use `src="..."` to run a local script file.
- **Server scripts (`<script data-bascik-server>`):** Executed on the server at request time in Node.js. Can also use `src="..."` to run a local script file.
- **Data scripts (e.g. `type="application/ld+json"`):** Left untouched without IIFE wrapping or minification.

> **Directory Isolation Rule:** Local `src="..."` script references are strictly confined to the component's own folder. A component in `src/components/demo-counter/` can only reference script files inside `src/components/demo-counter/`. It cannot access files across other component directories.

> **Recommended Pattern:** Keeping separate, unrelated logic in dedicated `<script>` tags (such as one script block for form validation and another for UI animation) is recommended for clean, readable code. You don't need to break code into tiny scripts arbitrarily, but isolating independent concerns into separate script blocks keeps your component's JavaScript organized and prevents variable name collisions.

## Multiple Instances

Place the same component on a page more than once and each instance runs independently with no extra work needed:

The two counters at the top of this page are the same component. Change either count, then inspect Output → HTML and Output → JS to compare their unique instance IDs.

## Pitfall: Class-Based DOM Lookups

Because class names are shared across all instances of the same component (for CSS deduplication), `document.querySelector('.my-class')` always returns the **first** matching element in the document. When the same component appears more than once, every instance's script ends up targeting the first instance's elements.

**Use `id` + `getElementById` instead:**

```html
<!-- ❌ Broken for multiple instances - querySelector returns first instance's button -->
<button class="my-btn">Click</button>
<script>
  document.querySelector('.my-btn').addEventListener('click', () => { … });
</script>
```

```html
<!-- ✅ Correct - id is scoped per instance -->
<button id="my-btn" class="my-btn">Click</button>
<script>
  document.getElementById('my-btn').addEventListener('click', () => { … });
</script>
```

The `class` attribute can still coexist on the same element for styling, just add an `id` for the JS lookup.

> **Rule of thumb.** Use `getElementById` (or `getElementsByName`) for elements you need to control per-instance. Reserve `querySelector`/`querySelectorAll` for cases where you intentionally want to sweep across all instances.

## Source Maps and DevTools Debugging

When you open browser DevTools (`F12` or `Cmd + Option + I` / `Ctrl + Shift + I`), Bascik provides zero-overhead source mapping without generating external `.map` files:

### Virtual Source Files in DevTools (`//# sourceURL`)

Bascik automatically appends a `//# sourceURL=src/components/name.html` directive and preserves line-offset padding in every component `<script>` block. In browser DevTools under the **Sources** (or **Debugger**) panel, your component scripts appear as virtual files matching your project folder structure (for example, `src/components/card.html`).

### 1:1 Line Number Preservation

Bascik inserts leading newline padding when scoping component `<script>` tags so that line numbers in the compiled output match the original component file line numbers exactly. When you set breakpoints or inspect errors, line 14 in DevTools corresponds to line 14 of your source template.

### Setting Breakpoints and Inspecting State

Because component scripts appear as virtual source files in DevTools:

1. Open the **Sources** panel in DevTools and press `Cmd + P` (or `Ctrl + P`).
2. Search for your component file (for example, `card.html`).
3. Click any line number to set a breakpoint, or place a `debugger;` statement directly inside your component `<script>`.
4. Interact with the component in your browser to pause execution, inspect variables, and step through code.

### Accurate Console Stack Traces

When `console.log()` runs or an uncaught exception occurs inside a component script, the DevTools Console panel attributes the message directly to `src/components/card.html:18` instead of pointing to a line in the generated page HTML. The reported line number matches the line in your original source HTML file.

## Dynamic Runtime Classes

If a class is only toggled at runtime (`classList.toggle("is-open")`) but doesn't appear on any element in the template HTML, Bascik's compiler won't register it. The CSS side minifies the name but the JS side doesn't, causing a silent mismatch at runtime.

The toggle below registers `is-open` on a hidden element, then safely applies that scoped class at runtime.

<!-- demo:runtime-class-usage -->
```html
<state-toggle />
```

<!-- demo:runtime-class-html -->
```html
<section class="state-toggle">
  <div class="is-open" hidden></div>
  <p id="status">Panel closed</p>
  <button id="toggle" type="button">Toggle panel</button>
  <div class="state-toggle-panel" id="panel">Only this component instance changes.</div>
</section>
```

<!-- demo:runtime-class-css -->
```css
.state-toggle-panel { opacity: 0.55; }
.state-toggle-panel.is-open {
  border-color: #d3ff8d;
  opacity: 1;
}
```

<!-- demo:runtime-class-js -->
```js
const status = document.getElementById('status');
const toggle = document.getElementById('toggle');
const panel = document.getElementById('panel');

toggle.addEventListener('click', () => {
  const isOpen = panel.classList.toggle('is-open');
  status.textContent = isOpen ? 'Panel open' : 'Panel closed';
});
```

<!-- demo:runtime-class-output-html -->
```html
<section class="bascik__state-toggle__state-toggle">
  <div class="bascik__state-toggle__is-open" hidden></div>
  <p id="bascik__state-toggle__a1b2__status">Panel closed</p>
  <button id="bascik__state-toggle__a1b2__toggle" type="button">Toggle panel</button>
  <div class="bascik__state-toggle__state-toggle-panel"
       id="bascik__state-toggle__a1b2__panel">Only this component instance changes.</div>
</section>
```

<!-- demo:runtime-class-output-js -->
```js
const status = document.getElementById('bascik__state-toggle__a1b2__status');
const toggle = document.getElementById('bascik__state-toggle__a1b2__toggle');
const panel = document.getElementById('bascik__state-toggle__a1b2__panel');

toggle.addEventListener('click', () => {
  const isOpen = panel.classList.toggle('bascik__state-toggle__is-open');
  status.textContent = isOpen ? 'Panel open' : 'Panel closed';
});
```

## Supported Selectors

All of the following DOM methods are rewritten when they reference a scoped attribute:

```js
// id attribute
document.getElementById("my-id")
document.querySelector("#my-id")
document.querySelectorAll("#my-id")

// class attribute
document.getElementsByClassName("my-class")
document.querySelector(".my-class")
document.querySelectorAll(".my-class")

// name attribute
document.getElementsByName("my-name")
```

Additional rewritten forms include `element.closest()`, `element.matches()`, `element.classList.add/remove/toggle/contains()`, `element.setAttribute("class", …)` and `element.setAttribute("id", …)` with string literal values, and `element.className` setter forms.

## Build-time Scripts

`<script data-bascik-build>` blocks run at transpile time as Node.js ESM modules. Their stdout replaces the tag in the page, useful for pulling in Markdown, JSON, or other external content at build time:

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';
  const md = await readFile('./content/posts/intro.md', 'utf8');
  console.log(marked(md));
</script>
```

> **Component tags work too.** Build script output is processed in the component resolution step, so its output can contain Bascik component tags.

## Non-JavaScript Script Types

Script tags with a `type` other than `text/javascript` are left completely untouched, no IIFE, no scoping:

```html
<script type="application/json" id="config-data">
  { "theme": "dark" }
</script>
```

> **Tip:** Disable JS scoping entirely with `scopeScriptBlocks: false` in [bascik.config.ts](/configuration).

## TypeScript in Component Scripts & BYOMinifier

Bascik ships vanilla JavaScript to the browser, so TypeScript in component `<script>` blocks must be stripped before the output is served. Thanks to Bascik's **BYOMinifier (Bring Your Own Minifier)** feature, you can wire Node 22.18+'s native `stripTypeScriptTypes` directly into the `minify.js` hook, and every inline script body gets its types erased automatically:

```ts
// bascik.config.ts
import { stripTypeScriptTypes } from 'node:module';
import { defineConfig } from '@bascik/bascik/config';

export const build = defineConfig({
  minify: {
    js: (js) => stripTypeScriptTypes(js),
  },
});
```

Component scripts can then use TypeScript annotations freely:

```html
<script>
  const count = document.getElementById('count') as HTMLElement;
  let n: number = 0;
  count.addEventListener('click', () => { n++; count.textContent = String(n); });
</script>
```

Bascik's scoping pipeline runs first (IIFE wrapping, selector rewriting), then `minify.js` strips the types. Scoped identifiers survive the process untouched because type annotations don't overlap with class names or selector strings.

> **Erasable syntax only.** `stripTypeScriptTypes` removes annotations, interfaces, type aliases, `as` casts, and `!` non-null assertions. Non-erasable syntax (`enum`, parameter properties, namespaces with runtime code) requires a separate compile step with `tsc` or `esbuild` before the HTML is processed by Bascik.

## How Scoping Works

Every component `<script>` is wrapped in an IIFE to prevent variable leaks, and every selector string that references a scoped attribute is rewritten to match:

Bascik also preserves line-offset padding and appends `//# sourceURL=src/components/name.html` directives to client script blocks. In browser DevTools, runtime errors and console statements point directly to the original component file and line number.

The counter demo's Output tabs show the complete compiled HTML, CSS, and JavaScript together. The runtime-class demo adds a focused view of `classList.toggle()` rewriting.

The scoping format:

- `class` → `bascik__<componentName>__<originalName>` (shared across all instances)
- `id` / `name` → `bascik__<componentName>__<instanceId>__<originalName>` (unique per instance)

> **Under the hood.** Read the [Scoping System internals](/internals/scoping-system) for the compiler passes, attribute maps, selector rewriting, and CSS deduplication that produce this output.

<!-- demo:source-usage -->
```html
<demo-counter data-bascik-prop-label="Counter A"></demo-counter>
<demo-counter data-bascik-prop-label="Counter B"></demo-counter>
```

<!-- demo:source-html -->
```html
<div class="ctr">
  <span class="ctr-label" data-bascik-prop-label>Counter</span>
  <span class="ctr-count" id="count">0</span>
  <div class="ctr-btns">
    <button class="ctr-dec" id="dec">−</button>
    <button class="ctr-inc" id="inc">+</button>
  </div>
</div>
```

<!-- demo:source-css -->
```css
.ctr {
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px 20px;
  transition: border-color .2s;
}
.ctr:hover { border-color: rgba(211,255,141,0.35); }
.ctr-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: #8d929e;
}
.ctr-count {
  font-family: monospace;
  font-size: 2.4rem;
  font-weight: 700;
  color: #d3ff8d;
  line-height: 1;
}
.ctr-dec, .ctr-inc {
  width: 40px; height: 40px;
  border-radius: 6px;
  font-size: 1.1rem;
  cursor: pointer;
  border: 1px solid #3a3d40;
  background: #1e2022;
  color: #f0f1f2;
}
.ctr-inc {
  background: rgba(211,255,141,0.12);
  border-color: rgba(211,255,141,0.3);
  color: #d3ff8d;
  font-weight: 700;
}
```

<!-- demo:source-js -->
```ts
const count = document.getElementById('count') as HTMLElement;
const dec   = document.getElementById('dec') as HTMLButtonElement;
const inc   = document.getElementById('inc') as HTMLButtonElement;
let n: number = 0;
dec.addEventListener('click', () => { n--; count.textContent = String(n); });
inc.addEventListener('click', () => { n++; count.textContent = String(n); });
```

<!-- demo:output-html -->
```html
<div class="bascik__demo-counter__ctr">
  <span class="bascik__demo-counter__ctr-label">Counter A</span>
  <span class="bascik__demo-counter__ctr-count"
        id="bascik__demo-counter__a1b2__count">0</span>
  <div class="bascik__demo-counter__ctr-btns">
    <button class="bascik__demo-counter__ctr-dec"
            id="bascik__demo-counter__a1b2__dec">−</button>
    <button class="bascik__demo-counter__ctr-inc"
            id="bascik__demo-counter__a1b2__inc">+</button>
  </div>
</div>
```

<!-- demo:output-css -->
```css
.bascik__demo-counter__ctr {
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px 20px;
  transition: border-color .2s;
}
.bascik__demo-counter__ctr-count {
  font-family: monospace;
  font-size: 2.4rem;
  font-weight: 700;
  color: #d3ff8d;
}
/* class names are shared across all instances of demo-counter */
```

<!-- demo:output-js -->
```js
(function() {
  const count = document.getElementById("bascik__demo-counter__a1b2__count");
  const dec   = document.getElementById("bascik__demo-counter__a1b2__dec");
  const inc   = document.getElementById("bascik__demo-counter__a1b2__inc");
  let n = 0;
  dec.addEventListener("click", () => { n--; count.textContent = n; });
  inc.addEventListener("click", () => { n++; count.textContent = n; });
})();
```
