# CSS Scoping Reference

Component CSS can live in a companion `.css` file, in inline `<style>` blocks, or both. All of it is combined, scoped, and injected into the document `<head>`. Prefer one pattern per component.

## Example

```css
/* site-nav.css (source) */
.nav a { color: white; }
p { margin: 0; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
```

```css
/* compiled */
.bascik__site-nav__nav a { color: white; }
.bascik__site-nav__el__p { margin: 0; }
@keyframes bascik__site-nav__keyframe__fade { from { opacity: 0; } to { opacity: 1; } }
```

The element selector `p` became a class that Bascik also injects on every `<p>` in the component's own template. `animation: fade` references are updated to the scoped keyframe name.

## Global class passthrough

Only classes defined in the component's stylesheet are scoped. Classes used in the template but not defined there (utility classes, design-system classes, `skip-link`) pass through unchanged so global stylesheets match them. A component with no stylesheet scopes no classes, which also means a script querying `.item` in it matches every `.item` on the page. Define the class in the component CSS to scope it.

## What is scoped

- Class names, element selectors (including every element in a compound chain such as `nav a`, `ul li *`, `p + p`), and `#id` selectors (converted to a generated class injected on the matching element).
- Selectors in `:is()`, `:where()`, `:has()` (classes only), child and sibling combinators, and `:nth-child(An+B of .selector)`.
- `@keyframes` names and `animation` references; `@layer`; `@container`; `@starting-style` (standalone and nested).
- CSS custom properties declared in the component, plus their `var()` references. Fallbacks are preserved.
- `@property --name` declarations along with matching declarations and `var()` references.
- `@counter-style` names and their references in `list-style`, `list-style-type`, `counter()`, and `counters()`.
- `view-transition-name` values (`bascik__<comp>__vtn__<name>`) and matching `::view-transition-old/new/group/image-pair()` selectors; `none` and `auto` stay.
- `anchor-name: --x` declarations, matching `position-anchor`, and `@position-try --x` rules in the same file.
- Native `@scope (.a) to (.b)` arguments and the classes inside the block.
- SVG elements with `class` attributes in the template.

## What is not scoped

- `html`, `body`, `head`: never renamed, so `html[data-theme="light"] .foo {}` compiles to `html[data-theme="light"] .bascik__comp__foo {}`.
- Standalone attribute selectors (`[data-state] {}`): left global and can leak. Anchor them: `.card[data-state] {}`.
- `[id]` and `[id="..."]` selectors: stripped, because they cannot be scoped. Use `#id` or a class.
- Element names inside `:is()`, `:where()`, `:has()`: not converted. Use classes inside those pseudo-classes.
- `@font-face`: passed through untouched. Declare fonts in a shared stylesheet to avoid duplicate injection.
- Custom properties the component does not declare: `var(--brand)` stays as written, so global tokens resolve.

## Custom properties

```css
/* source */
:root { --brand: #d3ff8d; }
.title {
  color: var(--brand);
  border-color: var(--brand, rgb(150, 150, 150));
}

/* compiled */
:root { --bascik__site-nav__brand: #d3ff8d; }
.bascik__site-nav__title {
  color: var(--bascik__site-nav__brand);
  border-color: var(--bascik__site-nav__brand, rgb(150, 150, 150));
}
```

For shared design tokens, declare them once in a global stylesheet (`src/pages/css/styles.css`) and only consume them in components. Because the component never declares them, `var(--card-bg)` is left untouched and resolves globally.

## Nesting

Explicit `&` nesting (`& p`, `& > h2`, `&>h2`, `&.active`) and relaxed nesting without `&` (`> h2`, `+ li`, `~ span`, nested element selectors) are both supported.

## `@import`

Local imports (`@import "./file.css"`) are inlined recursively and scoped with the component. Remote imports (`@import "https://..."`) are kept and hoisted to the top of the compiled stylesheet. In dev, editing an imported file rebuilds every page whose components import it.

## Fragment references

`fill: url(#gradient)` and quoted forms are rewritten when the ID is declared in the same component. Real URLs, data URLs, remote URLs, and cross-document fragments such as `url(sprite.svg#icon)` are unchanged. Because IDs are per instance, a component with a resolvable CSS fragment emits per-instance CSS even under `deduplicateCss: true`.

## Child components and slotted content

Component CSS matches only the component's own template markup. A parent's `nav a {}` never reaches a child component's root `<a>`, and element selectors never reach slotted content (slotted elements do not receive the injected element class).

- Style a child root: put a class on the child usage tag and define it in the parent CSS.
- Style slotted or generated markup (such as Markdown): use a wrapper class plus `:is()` around element names.

```css
.markdown-content :is(h2) { margin-block: 2.5rem 0.75rem; }
.markdown-content :is(blockquote) { border-left: 4px solid currentColor; }
```

Do not write `.markdown-content h2 {}` for slotted content: the `h2` would be converted to a scoped class that slotted headings never carry.

## Build-script output is scoped too

Markup printed by a component's `data-bascik-build` script (including markup returned by imported helpers) is scoped like the template: element and class names defined in that component's CSS are rewritten. Classes the component's stylesheet does not define stay global. Markup that must look identical across several components should be styled by a global stylesheet or by inline styles.

## Per-instance CSS

`scoping.deduplicateCss: false` scopes class names per instance (`bascik__card__<instance>__wrapper`) and emits one `<style>` per instance. The default `true` emits one block per component type. Keep the default unless migrating code that relies on per-instance class queries.
