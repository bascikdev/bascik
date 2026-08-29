# Bascik Scoping Compatibility

**Legend**

- ✓ Supported and tested
- △ Partially supported (see notes)
- ✕ Intentionally unsupported (see notes)
- – Not yet supported

<!-- bascik-compatibility-rules [
  {"id":"css-attribute-selector","kind":"css","pattern":"(^|,)\\s*\\[[A-Za-z0-9_-]+(?:\\s*(?:[~|^$*]?=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\]\"'\\s]+))?)?\\]","flags":"gm","message":"Standalone attribute selectors are not scoped by Bascik and may leak globally.","suggestion":"Anchor the selector with a scoped class (for example .card[data-state]) or switch to a class-only selector."},
  {"id":"css-is-element-names","kind":"css","pattern":":(?:is|where|has)\\s*\\((?:[^)]*\\b(?:p|div|span|section|article|main|header|footer|aside|nav|ul|ol|li|a|button|input|textarea|select|form|img|svg|path|h[1-6])\\b[^)]*)\\)","flags":"gi","message":"Element names inside :is(), :where(), or :has() are not converted by Bascik.","suggestion":"Use a class selector inside the pseudo-class instead of bare element names."},
  {"id":"css-import","kind":"css","pattern":"@import\\s+","flags":"i","message":"CSS @import is not processed by Bascik and should be avoided in component CSS.","suggestion":"Inline the CSS directly in the component or move it to a shared global stylesheet."},
  {"id":"js-id-setter","kind":"js","pattern":"\\.id\\s*=\\s*(?:[\"'`]|\\w)","flags":"g","message":"Runtime .id assignment is not rewritten by Bascik. That will not match the scoped attribute.","suggestion":"Capture the element once with getElementById() and operate on that reference."},
  {"id":"js-attribute-selector","kind":"js","pattern":"querySelector\\s*\\(\\s*[\"'][^\"']*\\[[^\\]]+\\][^\"']*[\"']\\s*\\)|querySelectorAll\\s*\\(\\s*[\"'][^\"']*\\[[^\\]]+\\][^\"']*[\"']\\s*\\)","flags":"g","message":"Attribute selectors are not rewritten by Bascik. Use an id or class selector instead.","suggestion":"Use getElementById() or a static class selector that Bascik can rewrite."},
  {"id":"js-template-classname","kind":"js","pattern":"className\\s*=\\s*`[^`]*\\$\\{[^}]+\\}[^`]*`|classList\\.replace\\s*\\(\\s*[^,]+,\\s*`[^`]*\\$\\{[^}]+\\}[^`]*`\\s*\\)","flags":"g","message":"Template-literal class names are not rewritten safely at build time.","suggestion":"Use classList.add(), classList.remove(), or a static string instead."},
  {"id":"js-style-setproperty","kind":"js","pattern":"style\\.setProperty\\s*\\(\\s*[\"']--","flags":"g","message":"Runtime CSS custom property names are not rewritten by Bascik.","suggestion":"Use the scoped property name explicitly or keep the runtime logic on the resulting element reference."}
] -->

---

## Component Template Structure

Bascik supports flexible HTML, CSS, and JavaScript structures inside `.html` component files.

| Capability | Status | Notes |
| --- | --- | --- |
| Multiple top-level HTML elements | ✓ | Supported naturally without requiring single wrapper elements or fragment tags. All root elements are inserted in order. Inherited usage attributes merge onto the first root HTML element. |
| Multiple `<style>` blocks | ✓ | Extracted and combined with any companion `.css` file before scoping and deduplication. *Note:* Using multiple `<style>` tags in a single component file is supported but not recommended for readability and maintainability. |
| Multiple `<script>` blocks | ✓ | Client `<script>` blocks are each wrapped in an independent IIFE. Recommended for clean, maintainable code when separating unrelated logic within a component. Build (`data-bascik-build`), server (`data-bascik-server`), and data scripts (e.g. `type="application/ld+json"`) are processed according to their script type. |

---

## CSS Scoping

CSS scoping applies to `.css` files paired with a component's HTML file. Place the `.css` file in the same directory as the component and give it the same base name.

### Selectors

| Pattern                                            | Example                                 | Status | Notes                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class selector                                     | `.foo {}`                               | ✓     | Scoped with unique instance prefix                                                                                                                                                                                                                                                        |
| Descendant with class                              | `.foo .bar {}`                          | ✓     | All class names in selector scoped                                                                                                                                                                                                                                                        |
| Multi-class                                        | `.foo.bar {}`                           | ✓     | Both class names scoped                                                                                                                                                                                                                                                                   |
| Standalone element selector                        | `p {}`                                  | ✓     | Converted to a generated class and injected on matching elements in component HTML, including indented selectors inside at-rules such as `@media` and inline `<style>` blocks. *Note on specificity:* converting element selectors $(0, 0, 1)$ to class selectors $(0, 1, 0)$ is an intentional zero-runtime build-time transformation that guarantees robust class isolation across components without requiring runtime shadow DOM.                                                                                                             |
| Element pseudo-class                               | `p:hover {}`                            | ✓     | Element converted to class; pseudo-class preserved: `.bascik__...__el__p:hover {}`                                                                                                                                                                                                        |
| Element pseudo-element                             | `p::before {}`                          | ✓     | Element converted to class; pseudo-element preserved: `.bascik__...__el__p::before {}`                                                                                                                                                                                                    |
| `@keyframes` name                                  | `@keyframes spin {}`                    | ✓     | Name scoped; `animation:` and `animation-name:` references updated to match                                                                                                                                                                                                               |
| `@media` query                                     | `@media (max-width: 600px) {}`          | ✓     | Media condition untouched; class names inside scoped normally                                                                                                                                                                                                                             |
| `@supports`                                        | `@supports (display: grid) { .foo {} }` | ✓     | Class names inside `@supports` blocks are scoped normally.                                                                                                                                                                                                                                |
| `@layer`                                           | `@layer base { .foo {} }`               | ✓     | Layer name scoped in all forms: declaration blocks, single-name and comma-list ordering statements.                                                                                                                                                                                       |
| `@container`                                       | `@container sidebar (min-width: …) {}`  | ✓     | Container names declared via `container-name:` or the `container:` shorthand are scoped; `@container name (…)` queries updated to match. Unnamed queries untouched.                                                                                                                       |
| CSS custom properties                              | `--brand: #d3ff8d` / `var(--brand)`     | ✓     | Declarations and all `var()` references in the same file scoped together. `var(--prop, fallback)` is fully supported, the fallback value is preserved and the property name is scoped.                                                                                                   |
| Multiple `animation:` values                       | `animation: a 1s, b 2s`                 | ✓     | Both keyframe name references are scoped when an `animation:` shorthand lists more than one animation.                                                                                                                                                                                    |
| Child / sibling combinators                        | `.a > .b`, `.a + .b`, `.a ~ .b`         | ✓     | All class names on both sides of `>`, `+`, and `~` are scoped.                                                                                                                                                                                                                            |
| `:is()` / `:where()` / `:has()` with class args   | `:is(.foo, .bar) {}`                    | ✓     | Class names inside `:is()`, `:where()`, and `:has()` are scoped normally. Element names inside these functions are **not** converted (see below).                                                                                                                                          |
| Inline `<style>` in component HTML                 | `<style>.foo {}</style>`                | ✓     | Full CSS scoping pipeline applied to inline `<style>` blocks. Extracted from component HTML into component CSS, deduplicated across component instances, and injected into page `<head>`. |
| CSS `#id` selector                                 | `#btn {}`                               | ✓     | Converted to a component-scoped class selector (`.bascik__comp__id__btn {}`) using a context-aware lookahead that correctly distinguishes selector position from hex color values. The generated class is injected onto the HTML element. Specificity drops from (0,1,0,0) to (0,0,1,0). |
| `[id]` / `[id="…"]` attribute selector             | `[id] {}`                               | ✕     | Stripped at compile time. Attribute-selector forms cannot be scoped without DOM wrapping.                                                                                                                                                                                                 |
| Attribute selector                                 | `[data-foo="bar"] {}`                   | △     | Passed through untouched, not scoped. Will apply globally. Avoid in component CSS or use a class-based selector alongside it.                                                                                                                                                            |
| Compound / descendant element selectors            | `div p {}`, `.card p {}`, `.list > li {}` | △     | `.class element {}` and `.class > element {}` (class followed by descendant/child element) **are now scoped:** the element name is converted to a class and injected onto matching HTML elements. Patterns with two bare element types (`div p {}`, `p + p {}`) still require a class anchor on the left side of the combinator.                                                                                  |
| Comma-separated element selector list              | `h1, h2 {}`                             | ✓     | All elements in a comma list are converted, both multi-line (each at column 0) and same-line (`h1, h2 {}`). A `)` stop in the lookahead prevents false positives inside `:is()`, `:where()`, `:has()`.                                                                                   |
| Cross-boundary root element selectors              | `html[data-theme="dark"] .foo {}`       | ✓     | `html`, `body`, and `head` are excluded from element-to-class conversion so cross-boundary selectors compile with the root element name intact. `html[data-theme="light"] .component-class {}` becomes `html[data-theme="light"] .bascik__comp__class {}` and correctly matches the component element when the document root carries a theme or state attribute. |
| `:is()` / `:where()` / `:has()` with element names | `:is(p, h2) {}`                         | ✕     | Element names inside these functions are not converted. Class equivalents work fine: `:is(.foo, .bar) {}`.                                                                                                                                                          |
| CSS nesting, class selectors                      | `& .child {}`                           | ✓     | Class selectors inside nesting are scoped normally.                                                                                                                                                                                                                                       |
| CSS nesting, element selectors                    | `& p {}`, `& > h2 {}`, `> h2 {}`, `p {}` | ✓     | Fully supported for explicit nesting (`& p {}`, `& > h2 {}`, `&>h2 {}`, `& + li {}`, `& ~ span {}`) and 2023 relaxed direct nesting (`> h2 {}`, `+ li {}`, `~ span {}`, direct nested element selectors without `&`).                                                                                                                      |
| `@scope` (native)                                  | `@scope (.foo) { .bar {} }`             | ✓     | Class names in both the `@scope (.selector)` argument and the optional `to (.selector)` clause are scoped normally (handled by the global class-scoping pass). Class names inside the `@scope` block are also scoped. Element names in `@scope` arguments and indented element selectors inside the block follow the same rules as other at-rules. |
| `:nth-child(An+B of .selector)`                    | `:nth-child(2n+1 of .item) {}`          | ✓     | Class names in the `of <selector>` argument are scoped by the global class-scoping pass (the same `(?<=\.)` regex that handles `:is()`, `:where()`, and `:has()` class arguments). Works for `:nth-child` and `:nth-last-child`.                                                          |

### Other CSS Features

| Feature                   | Status | Notes                                                                                                                    |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| CSS deduplication         | ✓     | When a component is used multiple times on a page, its CSS is injected only once.                                        |
| `minify.identifiers`      | ✓     | In production builds, verbose names like `bascik__site-nav__a1b2c3__logo` are hashed to short strings (e.g. `ba1b2c3d`) for name compression. |
| `minify.css`              | ✓     | Whitespace in the compiled `<style>` block is collapsed.                                                                 |
| Comments                  | ✓     | Stripped before processing.                                                                                              |
| SVG elements in component HTML | ✓ | `class` attributes on SVG elements (`<svg>`, `<circle>`, `<path>`, `<rect>`, etc.) are scoped with the same pipeline as HTML elements. JS `classList` and `querySelector` calls targeting SVG children are rewritten. |
| `@font-face`              | △     | Passed through untouched, the `font-family` name is not scoped. Both the declaration and all usage sites remain unmodified, so the font resolves correctly within the page. Declare `@font-face` in a shared global stylesheet rather than a component `.css` file to avoid duplicate declarations when a component is used multiple times. |
| `@import`                 | ✕     | Not followed by the scoping pipeline. The imported CSS file is not processed or scoped. Include CSS directly in the component file instead.                       |
| `@property`               | ✓     | `@property --name { }` declaration names are scoped. Any matching `--name:` element declarations and `var(--name)` references in the same component file are scoped to match. |
| `@starting-style`         | ✓     | Class names and element selectors inside `@starting-style` blocks are scoped by the same passes that handle other at-rules. Both standalone `@starting-style { .foo { } }` and nested `.foo { @starting-style { } }` forms are handled. |
| `@counter-style`          | ✓     | `@counter-style name { }` declaration names are scoped. References in `list-style`, `list-style-type`, `counter(counter, name)`, and `counters(counter, sep, name)` in the same component file are updated to match. |
| `view-transition-name`    | ✓     | `view-transition-name: name` values are scoped to the component. Matching `::view-transition-old(name)`, `::view-transition-new(name)`, `::view-transition-group(name)`, and `::view-transition-image-pair(name)` pseudo-element references in the same file are updated to match. The keywords `none` and `auto` are not scoped. |
| `anchor-name` / `@position-try` | ✓  | `anchor-name: --name` declarations are scoped per component. Matching `position-anchor: --name` references and `@position-try --name { }` at-rules in the same CSS file are updated to match. Only anchors declared in the component's own CSS are scoped, external anchor references are left untouched. |

---

## JavaScript Scoping

Bascik rewrites DOM selector references inside component `<script>` tags to match scoped attribute values. All rewrites happen at build time with no runtime is added.

### IIFE Isolation

| Pattern                                                  | Status | Notes                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script>` (no type)                                     | ✓     | Wrapped in an IIFE to prevent variable leakage between components.                                                                                                                                                                                          |
| `<script type="text/javascript">`                        | ✓     | Wrapped in an IIFE.                                                                                                                                                                                                                                         |
| `<script type="module">`                                 | ✓     | Not wrapped in an IIFE (modules are already isolated by spec). DOM selector references still rewritten.                                                                                                                                                     |
| `<script type="application/json">` (and any non-JS type) | ✓     | Left completely untouched.                                                                                                                                                                                                                                  |
| `<script data-bascik-build>`                             | ✓     | Executed at **transpile time** as a Node.js ESM module. The script's stdout is injected in place of the tag. Runs in both dev and build modes. Use `console.log()` / `process.stdout.write()` to output HTML. Top-level `import` and `await` are supported. |
| Literal component tags inside `<script>`, `<style>`, or `<textarea>` | ✓     | Treated as text, never resolved into components. Safe to mention tags like `<my-card>` in JSON-LD strings, inline scripts, or code examples.                                                                                                              |
| HTML comments containing component tags                  | ✓     | HTML comments (`<!-- <my-card> -->`) are stripped during HTML minification, so commented custom tags are never expanded into components.                                                                                                                |

### DOM Selector Rewriting

| Method                                        | Example                              | Attribute Scoped | Status | Notes                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------ | ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document.getElementById`                     | `getElementById("my-id")`            | `id`             | ✓     |                                                                                                                                                                                 |
| `document.querySelector` with `#id`           | `querySelector("#my-id")`            | `id`             | ✓     |                                                                                                                                                                                 |
| `document.querySelectorAll` with `#id`        | `querySelectorAll("#my-id")`         | `id`             | ✓     |                                                                                                                                                                                 |
| `document.getElementsByClassName`             | `getElementsByClassName("my-cls")`   | `class`          | ✓     |                                                                                                                                                                                 |
| `document.querySelector` with `.class`        | `querySelector(".my-cls")`           | `class`          | ✓     | Single-token class selector only.                                                                                                                                               |
| `document.querySelectorAll` with `.class`     | `querySelectorAll(".my-cls")`        | `class`          | ✓     | Single-token class selector only.                                                                                                                                               |
| `document.getElementsByName`                  | `getElementsByName("my-name")`       | `name`           | ✓     |                                                                                                                                                                                 |
| `element.closest` with `#id`                  | `el.closest("#my-id")`               | `id`             | ✓     |                                                                                                                                                                                 |
| `element.closest` with `.class`               | `el.closest(".my-cls")`              | `class`          | ✓     | Single-token class selector only.                                                                                                                                               |
| `element.matches` with `#id`                  | `el.matches("#my-id")`               | `id`             | ✓     |                                                                                                                                                                                 |
| `element.matches` with `.class`               | `el.matches(".my-cls")`              | `class`          | ✓     | Single-token class selector only. Works for event delegation: `e.target.matches(".my-cls")`.                                                                                    |
| `element.classList.add`                       | `el.classList.add("my-cls")`         | `class`          | ✓     | Single and multi-argument forms: `classList.add("a", "b")` rewrites all class names.       |
| `element.classList.remove`                    | `el.classList.remove("my-cls")`      | `class`          | ✓     | Single and multi-argument forms.                                                              |
| `element.classList.toggle`                    | `el.classList.toggle("my-cls")`      | `class`          | ✓     | The optional boolean second argument is passed through unchanged.                             |
| `element.classList.contains`                  | `el.classList.contains("my-cls")`    | `class`          | ✓     |                                                                                                                                                                                 |
| `element.classList.replace`                   | `el.classList.replace("old", "new")` | `class`          | ✓     | Both old and new class name arguments are rewritten.                                                                                                                            |
| Compound `querySelector` / `querySelectorAll` | `querySelector(".foo .bar")`         | `class` / `id`   | ✓     | Space and combinator tokens (`>`, `+`, `~`) rewritten. Adjacent `.foo.bar` rewrites leading token.                                                                              |
| `element.className` setter                    | `el.className = "my-cls"`            | `class`          | ✓     | Single and multi-class string assignments rewritten (`=` and `+=`). Reading `className` is unchanged.                                                                          |
| `element.setAttribute("class", …)`            | `el.setAttribute("class", "my-cls")` | `class`          | ✓     | String literal values are rewritten.                                                                                                                                            |
| `element.setAttribute("id", …)`               | `el.setAttribute("id", "my-id")`     | `id`             | ✓     | String literal values are rewritten.                                                                                                                                            |
| `element.setAttribute("name", …)`             | `el.setAttribute("name", "my-name")` | `name`           | ✓     | String literal values for known `name` attributes are rewritten.                                                                                                                |
| `innerHTML` / `insertAdjacentHTML` strings    | `el.innerHTML = '<div class="box">'` | `class`          | ✓     | Known class names in static HTML string literals are rewritten.                                                                                                                 |
| `element.removeAttribute`                     | `el.removeAttribute("class")`        |                  | ✕     | Attribute names (not values) passed with no rewriting needed.                                                                                                                   |
| `element.hasAttribute`                        | `el.hasAttribute("id")`              |                  | ✕     | Same as `removeAttribute`: attribute name, not value.                                                                                                                          |
| `element.toggleAttribute`                     | `el.toggleAttribute("hidden")`       |                  | ✕     | Boolean attribute name only with no value to rewrite.                                                                                                                              |
| `element.style.setProperty` for CSS vars      | `el.style.setProperty("--accent", v)` |                  | ✕     | Runtime CSS custom property names are not rewritten. Use scoped property name explicitly.                                                                                       |
| Template literal in `className` / selectors   | `` el.className = `box ${state}` ``  |                  | ✕     | Template literals with expressions are not rewritten. Use `classList.add`/`remove`.                                                                                           |
| `element.id` setter                           | `el.id = "my-id"`                    | `id`             | ✕     | Not rewritten. Use `getElementById` to retrieve and operate on the reference.                                                                                                   |
| `querySelector` attribute selector            | `querySelector("[id='my-id']")` | `id`             | ✕     | Use `getElementById` instead.                                                                                                                                                   |

### Notes on Gaps

The unsupported JS patterns above all involve **dynamic attribute manipulation** where static analysis cannot safely identify which component's attribute is being referenced from a string literal.

### JS-only class discovery

Class names that only appear in JavaScript (never in a `class="…"` HTML attribute) are automatically discovered and added to the scope map before the JS rewrite runs. This covers all class-referencing patterns: `classList.*` arguments, `.className` tokens in `querySelector` / `querySelectorAll` / `closest` / `matches` selector strings, `el.className = "…"` assignments, and `el.setAttribute("class", "…")` values. CSS-only classes (only in the `.css` file, never in HTML or JS) are scoped in CSS only, which is fine since nothing in JS needs to reference them.

The exception is `innerHTML` / `insertAdjacentHTML` string scanning, which only recognizes classes that appear in the HTML template.

The recommended pattern is to query scoped elements by a single `id` or single-class selector first, store the reference, then use the reference for all further DOM operations:

```html
<!-- source - works correctly -->
<div id="panel" class="card"></div>
<script>
  const panel = document.getElementById("panel"); // ← rewritten by Bascik
  panel.style.display = "none"; // ← operate on the reference
  panel.dataset.state = "closed"; // ← data attributes for state
</script>
```

### Class queries are document-wide (not per-instance)

Class names are scoped to the **component type**, not to individual instances. This means `querySelectorAll(".my-class")` inside a component script, which Bascik rewrites to `querySelectorAll(".bascik__comp__my-class")`: will find matching elements across **all instances** of that component on the page, not just the current instance.

To operate only on the current instance's elements, query by **id** (which includes a per-instance hash) and traverse from the returned element:

```javascript
// In component - gets only THIS instance's panel:
const panel = document.getElementById("panel"); // rewritten with instance hash
```

### FormData with scoped `name` attributes

When a component uses `<input name="username">`, Bascik scopes the `name` attribute to a per-instance value like `bascik__comp__a1b2c3__username`. As a result, `new FormData(form)` entries use the **scoped** name as the key. If your server-side code expects the unscoped field name, you will need to adapt it, or extract values using `formData.get` with the scoped name, or via `form.elements` iteration.
