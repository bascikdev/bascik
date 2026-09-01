# Scoping System

Scoping prevents one component's styles and identifiers from leaking into another. Bascik rewrites HTML attributes, CSS rules, and JavaScript DOM selector strings at transpile time using a deterministic naming scheme.

## The Naming Scheme

Every scoped name is constructed from three or four parts separated by double underscores:

```text
bascik__<componentName>__<instanceId>__<originalName>

# Examples:
bascik__site-nav__a1b2c3d4__toggle-btn    ← class (no instanceId, see below)
bascik__site-nav__a1b2c3d4__search-input  ← id / name
```

The **instanceId** is an 8-hex-character random value generated fresh for each occurrence of a component tag in a page. It guarantees that DOM identifiers (`id`, `name`) are unique even when the same component is used multiple times on a page.

### Class attributes intentionally omit the instanceId

IDs and names must be unique per DOM element, so they include the `instanceId`. Class names, however, are deliberately scoped to the *component name* only:

```text
bascik__site-nav__toggle-btn   ← same on every instance
```

This means every instance of `<site-nav>` on a page shares identical scoped class names. The CSS deduplication step can therefore emit a single `<style>` block per component type, rather than duplicating rules for every instance.

## HTML Attribute Pass

`prefixElementAttribute` in `javascript.ts` rewrites every matching HTML attribute value in the component template:

```html
<!-- Source -->
<button class="toggle-btn" id="menu-trigger">Menu</button>

<!-- After scoping (dev mode) -->
<button class="bascik__site-nav__toggle-btn" id="bascik__site-nav__a1b2c3d4__menu-trigger">Menu</button>
```

## CSS Pass

The CSS pass runs as part of the class scoping step and rewrites the component's paired `.css` file and any inline `<style>` tags:

### Class selectors

```css
/* Source */
.toggle-btn { color: red; }

/* Scoped */
.bascik__site-nav__toggle-btn { color: red; }
```

### Element selectors → class selectors

Bare element selectors in a component's CSS are converted to class selectors and the matching class is injected onto every matching element in the template HTML:

```css
/* Source CSS */
p { margin: 0; }

/* Scoped CSS */
.bascik__site-nav__el__p { margin: 0; }
```

```html
<!-- Scoped HTML - class injected onto every <p> in the component -->
<p class="bascik__site-nav__el__p">Content</p>
```

### Root document boundary and selector preservation

Document root elements (`html`, `body`, and `head`) are explicitly excluded from element-to-class scoping. This exception ensures that global document layout and page-level state remain accessible to component stylesheets without leaking unintended scoped class names onto `<html>` or `<body>`.

Furthermore, cross-boundary selectors such as `html[data-theme="light"] .foo {}` preserve the root element identifier intact while scoping child selectors. The resulting output is `html[data-theme="light"] .bascik__site-nav__foo {}`. This design allows component styles to react seamlessly to global document attributes (such as dark mode toggles or language attributes) while maintaining strict scoping for all child elements within the component template.

### @keyframes

```css
/* Source */
@keyframes slide-in { from { opacity: 0; } to { opacity: 1; } }
.item { animation: slide-in 0.3s; }

/* Scoped */
@keyframes bascik__site-nav__keyframe__slide-in { from { opacity: 0; } to { opacity: 1; } }
.bascik__site-nav__item { animation: bascik__site-nav__keyframe__slide-in 0.3s; }
```

### @layer

```css
/* Source */
@layer utilities { .btn { padding: 4px 8px; } }

/* Scoped */
@layer bascik__site-nav__layer__utilities { .bascik__site-nav__btn { padding: 4px 8px; } }
```

### container-name

```css
/* Source */
.wrapper { container-name: sidebar; container-type: inline-size; }
@container sidebar (min-width: 300px) { .item { font-size: 1rem; } }

/* Scoped */
.bascik__site-nav__wrapper { container-name: bascik__site-nav__container__sidebar; container-type: inline-size; }
@container bascik__site-nav__container__sidebar (min-width: 300px) { .bascik__site-nav__item { font-size: 1rem; } }
```

### CSS custom properties

```css
/* Source */
:root { --brand-color: #0070f3; }
.btn { color: var(--brand-color); }

/* Scoped */
:root { --bascik__site-nav__brand-color: #0070f3; }
.bascik__site-nav__btn { color: var(--bascik__site-nav__brand-color); }
```

<div class="callout">
<p><strong>Note:</strong> CSS custom properties defined in <code>:root</code> or at global scope are scoped by prefixing the variable name. Properties that should be intentionally global (design tokens consumed across components) should not be defined inside a component's CSS file.</p>
</div>

### What is NOT scoped

`[id]` attribute selectors in CSS are stripped because they cannot be reliably scoped without wrapping the component HTML in a DOM container element. Use a class selector instead.

## JavaScript Pass

After rewriting HTML attributes, `prefixElementAttribute` also rewrites every `<script>` block in the component template:

### ID selectors

```js
// Source
document.getElementById("menu-trigger");
document.querySelector("#menu-trigger");
document.querySelectorAll("#menu-trigger");
el.closest("#menu-trigger");
el.matches("#menu-trigger");
el.setAttribute("id", "menu-trigger");

// Scoped
document.getElementById("bascik__site-nav__a1b2c3d4__menu-trigger");
document.querySelector("#bascik__site-nav__a1b2c3d4__menu-trigger");
document.querySelectorAll("#bascik__site-nav__a1b2c3d4__menu-trigger");
el.closest("#bascik__site-nav__a1b2c3d4__menu-trigger");
el.matches("#bascik__site-nav__a1b2c3d4__menu-trigger");
el.setAttribute("id", "bascik__site-nav__a1b2c3d4__menu-trigger");
```

### Class selectors in JavaScript

```js
// Source
document.querySelector(".toggle-btn");
document.querySelectorAll(".toggle-btn");
el.closest(".toggle-btn");
el.matches(".toggle-btn");
el.getElementsByClassName("toggle-btn");
el.classList.add("is-open");
el.classList.remove("is-open");
el.classList.toggle("is-open");
el.classList.contains("is-open");
el.classList.replace("is-open", "is-closed");
el.className = "toggle-btn is-open";
el.className += " is-open";
el.setAttribute("class", "toggle-btn");

// Scoped
document.querySelector(".bascik__site-nav__toggle-btn");
document.querySelectorAll(".bascik__site-nav__toggle-btn");
el.closest(".bascik__site-nav__toggle-btn");
el.matches(".bascik__site-nav__toggle-btn");
el.getElementsByClassName("bascik__site-nav__toggle-btn");
el.classList.add("bascik__site-nav__is-open");
el.classList.remove("bascik__site-nav__is-open");
el.classList.toggle("bascik__site-nav__is-open");
el.classList.contains("bascik__site-nav__is-open");
el.classList.replace("bascik__site-nav__is-open", "bascik__site-nav__is-closed");
el.className = "bascik__site-nav__toggle-btn bascik__site-nav__is-open";
el.className += " bascik__site-nav__is-open";
el.setAttribute("class", "bascik__site-nav__toggle-btn");
```

### JS-only class discovery

The CSS pass scopes every class name it finds in the `.css` file regardless of whether that class appears in the HTML template. Without a corresponding discovery pass, class names used only in JavaScript (never in a `class="…"` attribute) would be scoped in CSS but left unscoped in JS, making them permanently out of sync.

To fix this, after the HTML attribute pass builds the initial class scope map, a second scan over every `<script>` block extracts class name string literals from all class-referencing JS patterns and adds any new names to the scope map before the JS rewrite runs:

- `classList.add / remove / toggle / contains / replace`: every quoted argument
- `querySelector / querySelectorAll / closest / matches`: every `.className` token in the selector string
- `el.className = "…"` and `el.className += "…"`: every space-separated token
- `el.setAttribute("class", "…")`: every space-separated token

This means modifier classes like `btn--active` that are only ever toggled dynamically still get scoped correctly in both CSS and JS without any special annotation:

```js
// Works — btn--active is discovered from the classList.add call
// and scoped in both CSS and JS even though it never appears in class="…"
el.classList.add("btn--active");
```

### Name selectors

```js
// Source
document.getElementsByName("email-field");
el.setAttribute("name", "email-field");

// Scoped
document.getElementsByName("bascik__site-nav__a1b2c3d4__email-field");
el.setAttribute("name", "bascik__site-nav__a1b2c3d4__email-field");
```

## Script Namespacing

`namespaceScriptTags` wraps every inline script in an IIFE so that `var` declarations cannot leak between components. It also appends a `//# sourceURL` comment pointing to the relative component path and preserves line positioning relative to the component file, ensuring browser DevTools attribute errors and logs directly to the original component file and line number:

```js
// Before (in src/components/card.html at line 12)
<script>
  var count = 0;
  document.querySelector(".btn").addEventListener("click", function() { count++; });
</script>

// After (simplified)
<script>
(function() {
  var count = 0;
  document.querySelector(".bascik__card__btn").addEventListener("click", function() { count++; });
})();
//# sourceURL=src/components/card.html
</script>
```

## Identifier Minification

When `minify.identifiers: true` is set (the default for builds), every scoped name is hashed using SHA-256 (converting the 64-bit prefix to an 11-character Base62 string) and prefixed with `b` to ensure it starts with a letter:

```ts
// names.ts
export const getAttributeNameHash = (attributeName: string): string => {
  const digest = createHash("sha256").update(attributeName).digest();
  const num = typeof digest === "string" ? Buffer.from(digest).readBigUInt64BE(0) : digest.readBigUInt64BE(0);
  return `b${toBase62(num, 11)}`;
};
```

The hash is deterministic, the same full scoped name always produces the same short hash, so CSS and HTML always stay in sync. The minified output looks like:

```html
<button class="ba1c2d3e4f5b">Menu</button>
<style>.ba1c2d3e4f5b { color: red; }</style>
```

## CSS Deduplication

After all components on a page have been resolved, `deduplicateCss` receives the list of used components. Because class-scoped names are identical across all instances of the same component, a Set-based deduplication is sufficient, each component's CSS block appears exactly once in the final `<style>` tag, regardless of how many times that component was used on the page.

---

## Design Decisions

This section documents the implementation trade-offs and constraint decisions behind specific scoping patterns, including cases that required non-obvious solutions and patterns that were evaluated but not implemented.

### CSS `#id {}` selector detection

The challenge is distinguishing a CSS ID selector from a hex color value in property position, since both use the `#` character.

**Initial approach (abandoned):** A simple lookahead `/#([a-zA-Z][a-zA-Z0-9-_]*)(?=[\s{:,])/g` incorrectly matched hex color values:

```css
background: linear-gradient(#abc, #def)   /* ← comma triggered the match */
background: #abc url('./img.png')         /* ← space triggered the match */
color: #abc\n                             /* ← newline triggered the match */
```

**Current implementation:** A context-aware lookahead `/#([a-zA-Z][a-zA-Z0-9-_]*)(?=[^{};]*\{)/g` that uses the position of the next `{` relative to `;` and `}` to determine selector vs. value context:

- In **selector position**, the next `{` always appears before any `;` or `}`.
- In **value position** (property declarations, gradient arguments, etc.), a `;` or `}` always appears before the next `{`.

```css
#btn { }                        → matches  (selector: { before ;/})
.parent #btn { }                → matches  (compound selector)
color: #abc;                    → skipped  (value: ; before {)
linear-gradient(#abc, #def)     → skipped  (value: } closes rule before next {)
```

Implemented in `convertCssIdSelectorsToClasses` in `styles.ts`. The `#id {}` selector is converted to a scoped class selector (`.bascik__comp__id__id {}`) and the generated class is injected onto the matching HTML element. Specificity drops from `(0,1,0,0)` to `(0,0,1,0)`, consistent with how element selectors are handled.

### CSS comma-separated element selectors

The same context-aware lookahead used for `#id` detection applies here. Adding `)` to the stop set (`[^{};)]*\{`) prevents false positives inside `:is()`, `:where()`, and `:has()` pseudo-functions, because the closing `)` terminates the lookahead before `{` is reached:

```
div:is(p, h2) { }                    →  ) stops lookahead → skipped ✓
h1, h2 { }                           →  { before ;/}/)} → MATCHES ✓
transition: color 0.2s, opacity 0.3s; →  ; before { → skipped ✓
```

Pass 2 regex: `/(?<=,[ \t]*)[a-z1-6]+(?=[^{};)]*\{)/g`

### Compound and descendant element selectors

`.card p {}` was not previously scoped because there was no reliable way to anchor the element selector to a specific component. The class-scoping pass, which runs first, introduces `bascik__` prefixes that serve as safe anchors for a subsequent pass:

```css
/* Source */
.card p { color: blue; }
.list > li { padding: 0; }

/* After scoping */
.bascik__card .bascik__card__el__p { color: blue; }
.bascik__list > .bascik__list__el__li { padding: 0; }
```

This works because `bascik__` never appears in CSS property value position. Bare element-to-element combinators (`div p {}`, `p + p {}`) with no class anchor on the left side are still not converted.

### CSS nesting element selectors

The `&` character is exclusively a CSS nesting selector and never appears in property value position, making `& ` (ampersand + whitespace) a reliable anchor for detecting nested element selectors:

```
/(?<=&\s+(?:[>+~]\s+)?)[a-z1-6]+(?=[^{};)]*\{)/g
```

This handles `& p {}`, `& > h2 {}`, `& + li {}`, and `& ~ span {}`. Patterns with an element appearing after a class in nesting (`& .parent p {}`) and elements directly appended to `&` without whitespace (`&p {}`) are not converted.

### CSS `element.id` property setter

Rewriting `el.id = "my-id"` to use the scoped ID name was evaluated and rejected. The pattern `\.id\s*=\s*["']` matches any property chain ending in `.id`, including `el.dataset.id = "foo"` (which sets a `data-id` attribute, not the DOM `id`). There is no reliable way to distinguish these two cases with static analysis.

The correct pattern is to use `getElementById("my-id")` to retrieve an element reference, then operate on the reference. Bascik rewrites `getElementById` and other explicit DOM lookup methods correctly.
