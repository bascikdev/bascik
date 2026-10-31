# Scoping System

Scoping prevents one component's styles and identifiers from leaking into another. Bascik rewrites HTML attributes, CSS rules, and JavaScript DOM selector strings at transpile time using a deterministic naming scheme.

## Shared Content Shielding

All compiler passes use one shielding utility, one token namespace, and one global counter. Restorable shields own their tokens and recursively restore nested content, so overlapping operations cannot consume or swap one another's values. Generated tokens are checked against source text before use.

The internal raw-text mask has a different semantic: it replaces content with the same number of spaces for index-safe scanning, then discards the mask. In contrast, author-configured `scoping.preserve` restores the original content after scoping. The shared utility implements both behaviors without treating the internal mask as an author-facing setting.

## The Naming Scheme

Components have no shadow DOM: their markup and styles land in the page like any other HTML and CSS. Bascik keeps a component's names private by renaming them at build time, so a component's `.title` cannot style another component's `.title`, and two instances of one component never share an `id`.

What is renamed, and the exact shapes:

```text
# Class (scoped to the component name, shared by every instance):
bascik__<componentName>__<originalName>
bascik__site-nav__toggle-btn

# id, and name with scoping.attributes.name: true (unique per instance):
bascik__<componentName>__<instanceId>__<originalName>
bascik__site-nav__a1b2c3d4__search-input

# Class generated for an element selector (p { }):
b_el_<componentName>_<tagName>
b_el_site-nav_p

# Class generated for an #id selector (#btn { }):
b_id_<componentName>_<idName>
b_id_site-nav_btn
```

Keyframes, layers, containers, counter styles, anchors, view transitions, and custom properties declared in the component follow the class shape with a kind word (`bascik__site-nav__keyframe__fade`); their sections below cover them.

The **instanceId** is an 8-hex-character value derived deterministically from the page path, component name, and ordinal occurrence index on that page (`deriveInstanceId` in `pkg/src/lib/names.ts`). It guarantees that DOM identifiers (`id`, and `name` when `scoping.attributes.name` is on) are unique even when the same component is used multiple times on a page, while ensuring identical builds produce byte-identical output across repeated runs. Under the default configuration, class names are scoped to the component name without an instance ID, and `name` ships as written; this deterministic derivation guarantees full reproducibility for pages scoping `id` (and `name`) attributes as well.

### Why element and id rules become classes

A bare `p { }` in a component stylesheet would style every paragraph on the page, because nothing in plain CSS limits a selector to one component's markup. Bascik rewrites the rule to a class and adds that class to every `<p>` in the component's template, so the rule matches only the component's own paragraphs. An `#btn { }` rule has a second problem: the `id` it names is renamed per instance (`bascik__site-nav__a1b2c3d4__btn`), so a selector naming one scoped `id` would style one instance only. Bascik rewrites it to a class shared by every instance and adds the class to each element whose `id` is `btn`. Both conversions give the rule the specificity of one class, `(0,0,1,0)`: higher than a bare element, lower than an `id`.

`styles.ts` builds the two generated names in one place each, `elementSelectorClassName` and `idSelectorClassName`, and every consumer (the CSS passes, the template injection, build-script output scoping) calls them.

### Why the generated head differs from the authored head

An authored class always starts with `bascik__`. The generated classes start with `b_el_` and `b_id_`, which no authored class can produce, so an element rule and an authored class never compile to the same name. Earlier releases named them `bascik__<componentName>__el__<tagName>` and `bascik__<componentName>__id__<idName>`: an authored class `.el__p` then compiled to the same `bascik__card__el__p` as the rule `p { }`, and the two rules styled each other's elements. The double underscore in the authored shape follows the common BEM-style delimiter; the generated shape uses single underscores to keep development output short, and its fixed `b_el_` or `b_id_` head is what keeps it apart.

When a component needs per-instance CSS (its stylesheet references a per-instance `url(#id)`, or `deduplicateCss` is off), `<componentName>` is the per-instance key `<componentName>__<instanceId>`, as in `b_el_site-nav__a1b2c3d4_p`.

### Under `minify.identifiers`

With `minify.identifiers: true` (the default in builds), every readable name above, authored or generated, is hashed to `b` plus 11 Base62 characters (`minifyAttributeName` in `names.ts`, the first 64 bits of a SHA-256 digest of the readable name). The HTML, CSS, and JavaScript use the same hash, so they stay in sync. A hash contains no `_`, so it can never equal a readable generated name, and two different readable names give the same hash only by a 64-bit collision. The readable shape decides which names stay apart; hashing keeps them apart.

### The remaining collision cases

Two cases can still produce one name for two meanings:

- **A global class with the generated shape.** A class that is not in the component's stylesheet stays global, so a page that writes `class="b_el_site-nav_p"`, or a site stylesheet that styles `.b_el_site-nav_p`, shares the class Bascik generates for `p { }` in `site-nav`. This is the same risk any global class name carries. The `css-reserved-class-prefix` lint rule warns about any `.b_el_` or `.b_id_` class in component CSS, in `bascik --check` and the editor. It does not read site stylesheets or `class=` attributes in markup, so those uses are not linted.
- **A component name with an underscore.** Element names have no underscore, so `b_el_<componentName>_<tagName>` always splits at its last underscore. An `id` can contain one: component `my` with `#card_btn` and component `my_card` with `#btn` both produce `b_id_my_card_btn`. Hyphenated component names, the form custom element names use, avoid this.

### Class attributes intentionally omit the instanceId

IDs (and names, when scoped) must be unique per DOM element, so they include the `instanceId`. Class names, however, are deliberately scoped to the _component name_ only:

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
<button
  class="bascik__site-nav__toggle-btn"
  id="bascik__site-nav__a1b2c3d4__menu-trigger"
>
  Menu
</button>
```

## CSS Pass

The CSS pass runs as part of the class scoping step and rewrites the component's paired `.css` file and any inline `<style>` tags:

### Class selectors

```css
/* Source */
.toggle-btn {
  color: red;
}

/* Scoped */
.bascik__site-nav__toggle-btn {
  color: red;
}
```

### Element selectors → class selectors

Bare element selectors in a component's CSS are converted to class selectors and the matching class is injected onto every matching element in the template HTML:

```css
/* Source CSS */
p {
  margin: 0;
}

/* Scoped CSS */
.b_el_site-nav_p {
  margin: 0;
}
```

```html
<!-- Scoped HTML - class injected onto every <p> in the component -->
<p class="b_el_site-nav_p">Content</p>
```

### Root document boundary and selector preservation

Document root elements (`html`, `body`, and `head`) are explicitly excluded from element-to-class scoping. This exception ensures that global document layout and page-level state remain accessible to component stylesheets without leaking unintended scoped class names onto `<html>` or `<body>`.

Furthermore, cross-boundary selectors such as `html[data-theme="light"] .foo {}` preserve the root element identifier intact while scoping child selectors. The resulting output is `html[data-theme="light"] .bascik__site-nav__foo {}`. This design allows component styles to react seamlessly to global document attributes (such as dark mode toggles or language attributes) while maintaining strict scoping for all child elements within the component template.

### @keyframes

```css
/* Source */
@keyframes slide-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.item {
  animation: slide-in 0.3s;
}

/* Scoped */
@keyframes bascik__site-nav__keyframe__slide-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.bascik__site-nav__item {
  animation: bascik__site-nav__keyframe__slide-in 0.3s;
}
```

### @layer

```css
/* Source */
@layer utilities {
  .btn {
    padding: 4px 8px;
  }
}

/* Scoped */
@layer bascik__site-nav__layer__utilities {
  .bascik__site-nav__btn {
    padding: 4px 8px;
  }
}
```

### container-name

```css
/* Source */
.wrapper {
  container-name: sidebar;
  container-type: inline-size;
}
@container sidebar (min-width: 300px) {
  .item {
    font-size: 1rem;
  }
}

/* Scoped */
.bascik__site-nav__wrapper {
  container-name: bascik__site-nav__container__sidebar;
  container-type: inline-size;
}
@container bascik__site-nav__container__sidebar (min-width: 300px) {
  .bascik__site-nav__item {
    font-size: 1rem;
  }
}
```

### CSS custom properties

```css
/* Source */
:root {
  --brand-color: #0070f3;
}
.btn {
  color: var(--brand-color);
}

/* Scoped */
:root {
  --bascik__site-nav__brand-color: #0070f3;
}
.bascik__site-nav__btn {
  color: var(--bascik__site-nav__brand-color);
}
```

<div class="callout">
<p><strong>Note:</strong> CSS custom properties defined in <code>:root</code> or at global scope are scoped by prefixing the variable name. Properties that should be intentionally global (design tokens consumed across components) should not be defined inside a component's CSS file.</p>
</div>

### Component build script output

A component build script runs when the component is expanded into a page, after this pass has scoped the template. To keep its output consistent, the class pass records the component's mapping (defined classes and styled elements to their scoped names) on each build script tag as `data-bascik-output-scope`. When the script runs, `executeBuildScripts` applies that mapping to its returned HTML with `applyOutputScope` (`pkg/src/lib/output-scope.ts`), skipping comments, raw-text elements, and attribute values. The annotation is consumed with the script tag and never reaches the emitted HTML. The script cache stores the unscoped returned HTML, so scoping is reapplied on every use.

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
el.classList.replace(
  "bascik__site-nav__is-open",
  "bascik__site-nav__is-closed",
);
el.className = "bascik__site-nav__toggle-btn bascik__site-nav__is-open";
el.className += " bascik__site-nav__is-open";
el.setAttribute("class", "bascik__site-nav__toggle-btn");
```

### JS-only class discovery

The set of classes to scope is the set the component's own stylesheet defines (companion `.css` plus inline `<style>`). A component with no stylesheet defines none, so no class in it is scoped. The CSS pass scopes every class name it finds in that stylesheet regardless of whether that class appears in the HTML template. Without a corresponding discovery pass, class names used only in JavaScript (never in a `class="…"` attribute) would be scoped in CSS but left unscoped in JS, making them permanently out of sync.

To fix this, after the HTML attribute pass builds the initial class scope map, a second scan over every `<script>` block extracts class name string literals from all class-referencing JS patterns and adds any new names to the scope map before the JS rewrite runs:

- `classList.add / remove / toggle / contains / replace`: every quoted argument
- `querySelector / querySelectorAll / closest / matches`: every `.className` token in the selector string
- `el.className = "…"` and `el.className += "…"`: every space-separated token
- `el.setAttribute("class", "…")`: every space-separated token

This means modifier classes like `btn--active` that are only ever toggled dynamically still get scoped correctly in both CSS and JS without any special annotation:

```js
// Works: btn--active is discovered from the classList.add call
// and scoped in both CSS and JS even though it never appears in class="…"
el.classList.add("btn--active");
```

### Name selectors

Only with `scoping.attributes.name: true` (off by default, when `name` ships as written):

```js
// Source
document.getElementsByName("email-field");
el.setAttribute("name", "email-field");

// Scoped
document.getElementsByName("bascik__site-nav__a1b2c3d4__email-field");
el.setAttribute("name", "bascik__site-nav__a1b2c3d4__email-field");
```

## Script Namespacing

`namespaceScriptTags` wraps every inline script in an IIFE so that `var` declarations cannot leak between components. It also appends a `//# sourceURL` comment pointing to the relative component path and pads the script with blank lines so DevTools line numbers match the component file, ensuring browser DevTools attribute errors and logs directly to the original component file and line number.

The padding cannot be computed from the HTML that reaches scoping: by then `<style>` blocks are extracted, build scripts have run, and the HTML may be minified. `listComponents` therefore stamps each browser script with its source line (`data-bascik-script-line`) as soon as it reads the file, and `namespaceScriptTags` turns the stamp into padding and removes it (`script-source-lines.ts`). A companion script is stamped as line 1 of its own file.

After scoping, `recursivelyTranspile` appends `?instance=N` to the sourceURL of the second and later instances of a component on a page. DevTools keeps one file per URL, so a shared URL would leave earlier instances with no source when paused. This runs outside the scoping pipeline because scoping results are reused across instances by renaming instance IDs, and the ordinal is not one:

```js
// Before (in src/components/card.html at line 12)
<script>
  var count = 0;
  document.getElementById("btn").addEventListener("click", function() { count++; });
</script>

// After (simplified; 11 blank lines of padding before the IIFE are not shown)
<script>
(function() {
  var count = 0;
  document.getElementById("bascik__card__a1b2c3d4__btn").addEventListener("click", function() { count++; });
})();
//# sourceURL=src/components/card.html
</script>
```

## Identifier Minification

When `minify.identifiers: true` is set (the default for builds), every scoped name is hashed using SHA-256 (converting the 64-bit prefix to an 11-character Base62 string) and prefixed with `b` to ensure it starts with a letter:

```ts
// names.ts (memoized per name)
export const getAttributeNameHash = (attributeName: string): string => {
  const digest = createHash("sha256").update(attributeName).digest();
  return nameHashFromDigest(digest);
};

// name-hash.ts (portable, so a Worker computes the same names)
export const nameHashFromDigest = (digest: Uint8Array): string => {
  let num = 0n;
  for (let i = 0; i < 8; i++) num = (num << 8n) | BigInt(digest[i]);
  return `b${toBase62(num, 11)}`;
};
```

The hash is deterministic, the same full scoped name always produces the same short hash, so CSS and HTML always stay in sync. The minified output looks like:

```html
<button class="ba1c2d3e4f5b">Menu</button>
<style>
  .ba1c2d3e4f5b {
    color: red;
  }
</style>
```

## Repeated Instances

Instances with identical input after props are applied (same template, CSS, file, and scoping config) differ only in their instance ID. `scopeComponentInstance` in `scoping-template.ts` runs the full scoping pipeline for the first instance of each distinct input and records every generated name. It reuses that work for later instances by computing their names and renaming:

- Every generated name goes through `minifyAttributeName`, which reports each call while a run is recorded. A name whose input contains the instance ID, or an earlier instance-dependent name, is recomputed for each new instance.
- Reuse starts only after the predicted result matched the full pipeline for two more instances with different IDs. Any mismatch disables reuse for that input.
- A run that writes to the console or resolves a CSS `@import` is never reused, so warnings and file reads still happen for every instance.
- A name that occurs in the authored input, overlapping names, colliding names, and unrestored shield markers all fall back to the full pipeline.

The result is byte-identical to scoping every instance in full. Tests check that the pipeline treats generated names as opaque tokens on random and real components. Unit, integration, and end-to-end runs set `BASCIK_VERIFY_SCOPING_TEMPLATES=1`, which recomputes every reused result with the full pipeline and fails on any difference.

CSS name scoping (`container-name`, `@counter-style`, and the other name kinds) replaces whole declared names in one pass, so a declared name never matches inside another generated name or a longer declared name.

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

**Current implementation:** `convertCssIdSelectorsToClasses` first masks every literal region of the CSS (quoted string literals, comments, and the interior of bracketed attribute selectors) via the shared `maskCssSyntax` helper (`css-tokenizer.ts`), then applies a context-aware lookahead `/#([a-zA-Z][a-zA-Z0-9-_]*)(?=[^{};]*\{)/g` on the masked copy and splices the originals back:

- In **selector position**, the next `{` always appears before any `;` or `}`.
- In **value position** (property declarations, gradient arguments, etc.), a `;` or `}` always appears before the next `{`.

```css
#btn { }                        → matches  (selector: { before ;/})
.parent #btn { }                → matches  (compound selector)
color: #abc;                    → skipped  (value: ; before {)
linear-gradient(#abc, #def)     → skipped  (value: } closes rule before next {)
a[href="#tab"] { }              → skipped  (attribute value is masked first)
.icon::before { content: "url(#local)"; }  → skipped (string literal is masked)
```

The masking is what keeps literal data intact: a hash in an attribute-selector value or a url-like string inside `content:` can never be confused with a selector. Quoted `url("...")` arguments are also masked for this pass so a real URL reference is not mistaken for an ID selector.

Implemented in `convertCssIdSelectorsToClasses` in `styles.ts`. The `#id {}` selector is converted to a scoped class selector (`.b_id_<componentName>_<id> {}`) and the generated class is injected onto the matching HTML element. Specificity drops from `(0,1,0,0)` to `(0,0,1,0)`, consistent with how element selectors are handled.

### CSS `url(#id)` fragment rewriting boundaries

`rewriteIdReferencesInCss` (`id-references.ts`) uses the same `maskCssSyntax` helper but keeps genuine `url("...")` arguments live so real fragment references still scope. This gives precise ownership:

```css
.icon::before {
  content: "url(#local)";
} /* literal: never rewritten */
.icon {
  fill: url(#local);
} /* real fragment: rewritten */
.icon {
  fill: url("#local");
} /* quoted fragment: rewritten */
.icon {
  background: url("sprite.svg#icon");
} /* cross-document: untouched */
```

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
.card p {
  color: blue;
}
.list > li {
  padding: 0;
}

/* After scoping, in a card component */
.bascik__card__card .b_el_card_p {
  color: blue;
}
.bascik__card__list > .b_el_card_li {
  padding: 0;
}
```

This works because `bascik__`, `b_el_`, and `b_id_` never appear in CSS property value position. Bare element-to-element combinators with no class anchor (`div p {}`, `p + p {}`, `ul li * {}`) are converted too: each element name becomes its own scoped class, so `div p {}` compiles to `.b_el_card_div .b_el_card_p {}` and matches only elements in the component's template.

### CSS nesting element selectors

The `&` character is exclusively a CSS nesting selector and never appears in property value position, making `& ` (ampersand + whitespace) a reliable anchor for detecting nested element selectors:

```
/(?<=&\s+(?:[>+~]\s+)?)[a-z1-6]+(?=[^{};)]*\{)/g
```

This handles `& p {}`, `& > h2 {}`, `& + li {}`, and `& ~ span {}`. Patterns with an element appearing after a class in nesting (`& .parent p {}`) and elements directly appended to `&` without whitespace (`&p {}`) are not converted.

### CSS `element.id` property setter

Rewriting `el.id = "my-id"` to use the scoped ID name was evaluated and rejected. The pattern `\.id\s*=\s*["']` matches any property chain ending in `.id`, including `el.dataset.id = "foo"` (which sets a `data-id` attribute, not the DOM `id`). There is no reliable way to distinguish these two cases with static analysis.

The correct pattern is to use `getElementById("my-id")` to retrieve an element reference, then operate on the reference. Bascik rewrites `getElementById` and other explicit DOM lookup methods correctly.
