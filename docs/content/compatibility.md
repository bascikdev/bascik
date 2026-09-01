# Bascik Web Standards & Scoping Compatibility

This page documents Bascik's support matrix against authoritative **W3C Recommendations**, **WHATWG Living Standards**, **IETF RFCs**, and **ECMA-262 specifications**, cross-referenced with **MDN Web Docs** documentation and **Baseline** browser compatibility tiers.

**Legend**

- ✓ Supported and tested
- △ Partially supported (see notes)
- ✕ Intentionally unsupported (see notes)
- – Not yet supported

<!-- bascik-compatibility-rules [
  {"id":"css-attribute-selector","kind":"css","pattern":"(^|,)\\s*\\[[A-Za-z0-9_-]+(?:\\s*(?:[~|^$*]?=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\]\"'\\s]+))?)?\\]","flags":"gm","message":"Standalone attribute selectors are not scoped by Bascik and may leak globally.","suggestion":"Anchor the selector with a scoped class (for example .card[data-state]) or switch to a class-only selector."},
  {"id":"css-is-element-names","kind":"css","pattern":":(?:is|where|has)\\s*\\((?:[^)]*\\b(?:p|div|span|section|article|main|header|footer|aside|nav|ul|ol|li|a|button|input|textarea|select|form|img|svg|path|h[1-6])\\b[^)]*)\\)","flags":"gi","message":"Element names inside :is(), :where(), or :has() are not converted by Bascik.","suggestion":"Use a class selector inside the pseudo-class instead of bare element names."},
  {"id":"js-id-setter","kind":"js","pattern":"\\.id\\s*=\\s*(?:[\"'`]|\\w)","flags":"g","message":"Runtime .id assignment is not rewritten by Bascik. That will not match the scoped attribute.","suggestion":"Capture the element once with getElementById() and operate on that reference."},
  {"id":"js-attribute-selector","kind":"js","pattern":"querySelector\\s*\\(\\s*[\"'][^\"']*\\[[^\\]]+\\][^\"']*[\"']\\s*\\)|querySelectorAll\\s*\\(\\s*[\"'][^\"']*\\[[^\\]]+\\][^\"']*[\"']\\s*\\)","flags":"g","message":"Attribute selectors are not rewritten by Bascik. Use an id or class selector instead.","suggestion":"Use getElementById() or a static class selector that Bascik can rewrite."},
  {"id":"js-template-classname","kind":"js","pattern":"className\\s*=\\s*`[^`]*\\$\\{[^}]+\\}[^`]*`|classList\\.replace\\s*\\(\\s*[^,]+,\\s*`[^`]*\\$\\{[^}]+\\}[^`]*`\\s*\\)","flags":"g","message":"Template-literal class names are not rewritten safely at build time.","suggestion":"Use classList.add(), classList.remove(), or a static string instead."},
  {"id":"js-style-setproperty","kind":"js","pattern":"style\\.setProperty\\s*\\(\\s*[\"']--","flags":"g","message":"Runtime CSS custom property names are not rewritten by Bascik.","suggestion":"Use the scoped property name explicitly or keep the runtime logic on the resulting element reference."}
] -->

---

## Web Standards Authority Matrix

Bascik operates as a zero-runtime build-time compiler and HTTP delivery server. All transformations, protocols, and APIs are designed to comply with official web specifications:

| Domain / Subsystem | Authoritative Standard | MDN / Baseline Status | Summary |
| --- | --- | --- | --- |
| HTML Elements & Composition | WHATWG HTML §3 / §4 | Baseline: Widely Available | Custom element naming, valid data-* attributes, slot fallback, raw-text masking |
| HTML Minification | CSS Text 3 / WHATWG HTML | Baseline: Widely Available | Safe phrasing content space preservation (`INLINE_TAGS`) and block collapsing |
| CSS Selectors & Nesting | W3C Selectors 4 / CSS Nesting | Baseline: Widely Available | Class scoping, 2023 relaxed nesting, pseudo-classes, combinators |
| Modern CSS At-Rules | W3C CSS Module Level 3 / 5 | Baseline: Newly / Widely Available | `@layer`, `@container`, `@keyframes`, `@property`, `@counter-style`, `@starting-style`, `@position-try` |
| JavaScript DOM Scoping | WHATWG DOM §4 / WebIDL | Baseline: Widely Available | Compile-time query rewriting for standard DOM element methods |
| Script Execution Isolation | ECMA-262 / WHATWG HTML §7.1 | Baseline: Widely Available | IIFE encapsulation for classic scripts, native module isolation for `type="module"` |
| HTTP/1.1 & HTTP/2 Protocols | IETF RFC 9112 / RFC 9113 | Baseline: Widely Available | ALPN negotiation, HTTP/2 multiplexing, pseudo-headers, stream lifecycle |
| HTTP Semantics & Caching | IETF RFC 9110 / RFC 6797 | Baseline: Widely Available | Strong/weak ETags, conditional 304 responses, Vary, Brotli, HSTS header |
| MIME Types | IETF RFC 9239 / IANA | Baseline: Widely Available | Current standard `text/javascript; charset=utf-8` media types |
| Live Reload & Events | WHATWG EventSource | Baseline: Widely Available | Server-Sent Events (SSE) `/bascik-live-reload` endpoint |
| Sitemaps & Robots | Sitemaps 0.9 / IETF RFC 9309 | Standard Protocols | Canonical XML sitemap and robots exclusion directives |

---

## Component Template Structure & HTML Standards

Bascik supports flexible HTML, CSS, and JavaScript structures inside `.html` component files without requiring runtime frameworks.

| Capability | Standard / Spec | Status | Notes |
| --- | --- | --- | --- |
| Hyphenated custom element names | WHATWG HTML §4.13.1.2 | ✓ | Component tags with hyphens (e.g. `<my-button>`, `<site-nav>`) follow the WHATWG custom element standard and prevent collisions with native tags. |
| Single-word component filenames | WHATWG HTML §4.13.1.2 | △ | Single-word component names (e.g. `card.html` -> `<card></card>`) compile for backward compatibility, but Bascik's CLI compiler and VS Code extension issue warnings recommending a hyphenated name (e.g. `my-card.html`). |
| Native element shadowing guard | WHATWG HTML §4 | ✓ | Bascik maintains a set of 115 native HTML elements and issues a build-time warning if a component filename shadows a native tag (e.g. `header.html` or `dialog.html`). |
| Exact component tag matching | WHATWG HTML §13.2.5 | ✓ | A component name matches only the complete tag name. A `card` component never claims a longer hyphenated tag such as `<card-header>`. |
| Custom `data-*` attributes | WHATWG HTML §3.2.6.6 | ✓ | Internal directives (`data-bascik-prop-*`, `data-bascik-attr-*`, `data-bascik-preserve`, `data-bascik-slot`, `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`) strictly conform to XML NCName lower-case naming syntax. |
| Self-closing custom tags | WHATWG HTML §13.1.2 | ✓ | In HTML source code, custom tags can use self-closing syntax with or without a space (`<my-comp />` or `<my-comp/>`). Both forms balance correctly when nested inside a paired instance and expand at build time into standard HTML. |
| Multiple top-level HTML elements | WHATWG HTML | ✓ | Supported naturally without requiring single wrapper elements or fragment tags. All root elements are inserted in document order. Inherited usage attributes merge onto the first content element after leading text, `<link>`, or `<meta>` nodes. Root opening tags are parsed quote-aware, so `>` inside an attribute value remains intact. |
| Multiple `<style>` blocks | WHATWG HTML §4.2.6 | ✓ | Extracted and combined with any companion `.css` file before scoping and deduplication. *Note:* Using multiple `<style>` tags in a single component file is supported, but using a single stylesheet pattern per component is recommended for maintainability. |
| Multiple `<script>` blocks | WHATWG HTML §4.12 | ✓ | Client `<script>` blocks are each wrapped in an independent IIFE. Recommended for clean, maintainable code when separating unrelated logic within a component. Build (`data-bascik-build`), server (`data-bascik-server`), and data scripts (e.g. `type="application/ld+json"`) are processed according to their script type. |
| Raw-text comments and nested scripts | WHATWG HTML §4.12 | ✓ | Comments and comment-like text inside `<pre>`, `<textarea>`, and scripts are shielded before HTML comments are stripped. Scripts nested inside containers remain in place. |
| Raw-text document closing tags | WHATWG HTML §13.2.5 | ✓ | Literal `</body>` text inside `<textarea>` and `</head>` text inside `<script>` do not terminate document extraction or duplicate the remaining page during reassembly. |
| Global class passthrough | WHATWG HTML | ✓ | Class names in component HTML that are not declared in the component's stylesheet (such as global utility classes like `skip-link`, `flex`, `hidden`) pass through as unscoped global classes so global stylesheets continue to match them. |
| Class attribute whitespace | WHATWG HTML §2.3.7 | ✓ | Class tokens are normalized across spaces, tabs, and newlines. Leading, trailing, and repeated whitespace never creates an empty scoped token. |
| Slot fallback semantics | WHATWG DOM §4 | ✓ | Default and named slots preserve their inner placeholder markup when no replacement content is passed from the parent template. |
| Prop value escaping | WHATWG HTML §13.2.5 | ✓ | Prop values are HTML-escaped on injection. Entity-encoded quotes round-trip as text; slots are the raw-markup path. |
| Prop-to-attribute binding | WHATWG HTML §3.2.6.6 | ✓ | `data-bascik-attr-{attribute}="{propName}"` binds a supplied prop to plain and hyphenated attributes, then removes the directive. Missing props add nothing; existing targets warn and are replaced. Bound `id`, `name`, and `class` values use normal scoping rules. |
| Nested prop boundary | WHATWG HTML §3.2.6.6 | ✓ | Props are extracted only from a component's opening usage tag, so declarations on nested components inside slot content never leak into the parent. |
| Tag-level preserve | WHATWG HTML §13.1.2 | ✓ | `scoping.preserve` keeps each configured tag's `id`, `name`, and `class` attributes, contents, and descendants unscoped through shared restorable shielding. |
| Element-level preserve | WHATWG HTML §3.2.6.6 | ✓ | `data-bascik-preserve` applies to one subtree. A bare directive preserves `id`, `name`, and `class`; a space-separated value preserves only listed attributes. The directive is removed from output. |
| Internal raw-text mask | WHATWG HTML §13.1.2 | ✓ | Internal scans use a hardcoded same-length discard mask for scripts, styles, textareas, and comments. It is not configurable and is distinct from author-facing preservation. |
| Inline phrasing whitespace preservation | CSS Text Level 3 | ✓ | HTML minification preserves single spaces between inline phrasing elements (`INLINE_TAGS`: `span`, `a`, `strong`, `em`, `code`, etc.) while safely collapsing block-level whitespace. |
| `<meta>` tag preservation | WHATWG HTML §4.2.5 | ✓ | Standard metadata attributes on `<meta>` tags (e.g. `name="viewport"`, `name="description"`) are shielded from attribute scoping. |

---

## ID References

When an `id` declaration is scoped, Bascik rewrites references that resolve to that declaration in the same component. Unresolved references remain byte-identical so components can still target literal page-level IDs.

| Reference | Status | Notes |
| --- | --- | --- |
| `for` on `<label>` | ✓ | Rewritten as one ID so label activation continues to focus the scoped control. |
| `form`, `list`, `popovertarget`, `commandfor` | ✓ | Each single-ID reference is rewritten when its target is declared locally. |
| `aria-activedescendant`, `aria-errormessage` | ✓ | Single-ID ARIA references resolve locally. |
| `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-flowto`, `aria-details` | ✓ | Space-separated tokens resolve independently; nonlocal tokens remain unchanged. |
| `itemref` | ✓ | Space-separated microdata item IDs resolve independently. |
| `headers` on `<td>` and `<th>` | ✓ | Space-separated header IDs resolve independently. |
| `for` on `<output>` | ✓ | Treated as a space-separated ID list, unlike the single-ID `<label for>`. |
| Fragment links on `<a>` and `<area>` | ✓ | Fragment-only values such as `href="#section"` resolve locally. Bare hashes and other-document URLs remain unchanged. |
| SVG `<use href>` and `xlink:href` | ✓ | Fragment-only references to local SVG IDs are rewritten. |
| SVG presentation attributes | ✓ | `fill`, `stroke`, `mask`, `clip-path`, `filter`, `marker-start`, `marker-mid`, and `marker-end` rewrite local `url(#id)` fragments. |
| Inline `style` attributes | ✓ | Local `url(#id)` fragments are rewritten. Component `<style>` blocks and stylesheets are covered separately by CSS scoping. |
| CSS `url(#id)` fragments | ✓ | Local fragments in component stylesheets and `<style>` blocks are rewritten for properties including `fill`, `stroke`, `clip-path`, `mask`, `filter`, and marker properties. Components with resolvable fragments automatically emit per-instance CSS. |
| CSS cross-document fragments | ✓ | Values such as `url(other.svg#icon)` are deliberately untouched because the fragment belongs to another document. Real, remote, and data URLs also remain unchanged. |
| `usemap` on `<img>` | ✓ | Resolves against a local `<map name>`, not an ID, and follows `scoping.attributes.name`. |
| Cross-component ID references | ✗ | IDs are scoped per instance, so references cannot resolve safely across component boundaries at build time. They remain unchanged. |
| Preserved subtrees | ✓ | References and declarations inside `scoping.preserve` tags or `data-bascik-preserve` subtrees remain literal. |

---

## Base Path Rewriting

When `base` is not `/`, Bascik prefixes root-relative authored URLs at build time. The transform runs after local ID references are scoped, so fragment references are final before path rewriting begins.

| Location or value | Status | Notes |
| --- | --- | --- |
| HTML URL attributes | ✓ | Rewrites root-relative `href`, `src`, `poster`, `data`, `action`, and `formaction` values. Known social metadata fields `og:image`, `og:url`, and `twitter:image` are also rewritten. |
| `srcset` and `imagesrcset` | ✓ | Rewrites each root-relative candidate while preserving descriptors, whitespace, trailing commas, and data URLs containing commas. |
| Inline, hoisted, and copied CSS | ✓ | Rewrites root-relative `url()`, string-form `@import`, and `image-set()` candidates in style attributes, style blocks, component CSS, inlined CSS, and copied stylesheets. |
| Web app manifests | ✓ | Rewrites `start_url`, `scope`, and each `icons[].src` in `.webmanifest` and `manifest.json` files. |
| Absolute, protocol-relative, scheme, fragment, and relative URLs | ✓ | Values such as `https://example.com/x`, `//cdn.example.com/x`, `data:`, `mailto:`, `#section`, `./x`, and `../x` remain byte-identical. Values already prefixed by `base` are unchanged. |
| Root base `/` | ✓ | The transform is skipped completely, preserving byte-identical output and existing build cost. |
| URLs constructed in JavaScript | ✕ | Static analysis cannot safely identify runtime path construction such as `fetch('/api/' + id)`, so Bascik deliberately leaves JavaScript URL values unchanged. |

---

## CSS Scoping

CSS scoping applies to `.css` files paired with a component's HTML file. Place the `.css` file in the same directory as the component and give it the same base name.

### Selectors

| Pattern                                            | Example                                 | Status | Notes                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class selector                                     | `.foo {}`                               | ✓     | Scoped with unique instance prefix                                                                                                                                                                                                                                                        |
| Descendant with class                              | `.foo .bar {}`                          | ✓     | All class names in selector scoped                                                                                                                                                                                                                                                        |
| Multi-class                                        | `.foo.bar {}`                           | ✓     | Both class names scoped                                                                                                                                                                                                                                                                   |
| Standalone element selector                        | `p {}`                                  | ✓     | Converted to a generated class and injected on matching elements in component HTML, including indented selectors inside at-rules such as `@media` and inline `<style>` blocks. *Note on specificity:* converting element selectors `(0, 0, 1)` to class selectors `(0, 1, 0)` is an intentional zero-runtime build-time transformation that guarantees robust class isolation across components without requiring runtime shadow DOM.                                                                                                             |
| Element pseudo-class                               | `p:hover {}`                            | ✓     | Element converted to class; pseudo-class preserved: `.bascik__...__el__p:hover {}`                                                                                                                                                                                                        |
| Element pseudo-element                             | `p::before {}`                          | ✓     | Element converted to class; pseudo-element preserved: `.bascik__...__el__p::before {}`                                                                                                                                                                                                    |
| `@keyframes` name                                  | `@keyframes spin {}`                    | ✓     | Name scoped; `animation:` and `animation-name:` references updated to match                                                                                                                                                                                                               |
| `@media` query                                     | `@media (max-width: 600px) {}`          | ✓     | Media condition untouched; class names inside scoped normally                                                                                                                                                                                                                             |
| `@supports`                                        | `@supports (display: grid) { .foo {} }` | ✓     | Class names inside `@supports` blocks are scoped normally.                                                                                                                                                                                                                                |
| `@layer`                                           | `@layer base { .foo {} }`               | ✓     | Layer names are scoped in declaration blocks and single-name or comma-list ordering statements, including leading-hyphen names such as `--utils`.                                                                                                                                          |
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
| CSS deduplication         | ✓     | Component CSS is normally injected once per type. Components containing resolvable `url(#id)` references emit per-instance CSS so each stylesheet targets that instance's scoped ID. |
| `minify.identifiers`      | ✓     | In production builds, verbose names like `bascik__site-nav__a1b2c3__logo` are hashed to short strings (e.g. `ba1b2c3d`) for name compression. |
| `minify.css`              | ✓     | Whitespace in the compiled `<style>` block is collapsed.                                                                 |
| Comments                  | ✓     | Stripped before processing.                                                                                              |
| SVG elements in component HTML | ✓ | `class` attributes on SVG elements (`<svg>`, `<circle>`, `<path>`, `<rect>`, etc.) are scoped with the same pipeline as HTML elements. JS `classList` and `querySelector` calls targeting SVG children are rewritten. |
| `@font-face`              | △     | Passed through untouched, the `font-family` name is not scoped. Both the declaration and all usage sites remain unmodified, so the font resolves correctly within the page. Declare `@font-face` in a shared global stylesheet rather than a component `.css` file to avoid duplicate declarations when a component is used multiple times. |
| `@import`                 | ✓     | Local file imports (`@import "./file.css"`) are inlined recursively at build time and scoped to the component. Remote URLs (`@import "https://..."`) are preserved and hoisted to the top of the compiled stylesheet per W3C CSS spec requirements. |
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
| JavaScript MIME type minification                         | ✓     | Inline scripts with no type or `text/javascript`, `module`, `application/javascript`, `text/ecmascript`, and `application/ecmascript` are minified when `minify.js` is enabled. External scripts are left empty and unchanged. |
| `<script type="application/json">` (and any non-JS type) | ✓     | Left completely untouched.                                                                                                                                                                                                                                  |
| `<script data-bascik-build>`                             | ✓     | Executed at **transpile time** as a Node.js ESM module. The script's stdout is injected in place of the tag. Runs in both dev and build modes. Use `console.log()` / `process.stdout.write()` to output HTML. Top-level `import` and `await` are supported. |
| `<script data-bascik-routes>`                            | ✓     | Executed at **build time** inside bracket templates (e.g. `[slug].html`). Standard output is parsed as a JSON array of `{ params, data? }` objects to expand the template into concrete static HTML pages. |
| `<script data-bascik-server>`                            | ✓     | Executed on the server at **request time** as a Node.js ESM module. Standard output replaces the tag dynamically. Top-level `import` and `await` are supported. |
| DevTools `//# sourceURL` directives                      | ✓     | Automatically appended to every client, build, and server `<script>` block with 1:1 newline padding to preserve source file paths and line numbers in browser DevTools and Node.js debuggers. |
| Stack trace remapping (`stack-trace.ts`)                 | ✓     | Ephemeral build-time and server-side script errors are remapped back to source HTML files and exact line numbers while stripping noisy internal Node.js runtime frames. |
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

---

## HTTP Protocols, Caching & Security Standards

When running Bascik's built-in HTTP/1.1 and HTTP/2 production server (`bascik --server`) or dev server (`bascik`), responses strictly adhere to modern IETF network and caching standards:

| Feature / Standard | Protocol Authority | Status | Implementation Details |
| --- | --- | --- | --- |
| HTTP/2 & ALPN Negotiation | IETF RFC 9113 / RFC 9112 | ✓ | Uses `http2.createSecureServer({ allowHTTP1: true })` for ALPN negotiation with automatic HTTP/1.1 fallback. Handles HTTP/2 pseudo-headers (`:status`, `:path`, `:method`, `:scheme`). |
| Strong & Weak ETags | IETF RFC 9110 §8.8.3 | ✓ | Generates strong SHA-256 base64url ETags for dynamic HTML pages and weak stat-based ETags (`W/"mtime-size"`) for static files. |
| Conditional GET & 304 Responses | IETF RFC 9110 §13.1.1 | ✓ | Evaluates incoming `If-None-Match` request headers against generated ETags and returns `304 Not Modified` with zero response body. |
| Content Negotiation & Vary | IETF RFC 9110 §12.5.5 | ✓ | Sends `Vary: Accept-Encoding` and serves pre-compressed Brotli (`content-encoding: br`) assets when supported by the client. |
| Method Guarding | IETF RFC 9110 §9.1 | ✓ | Enforces `GET` and `HEAD` requests only. Rejects other methods with `405 Method Not Allowed` and sends `Allow: GET, HEAD`. |
| Strict-Transport-Security (HSTS) | IETF RFC 6797 | ✓ | Automatically sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` when serving HTTPS or when behind an SSL reverse proxy (`x-forwarded-proto: https`). |
| Standard Security Headers | OWASP / IETF Guidelines | ✓ | Every response sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: interest-cohort=()`. |
| Modern JavaScript MIME Types | IETF RFC 9239 | ✓ | Serves JavaScript files (`.js`, `.mjs`, `.cjs`) as `text/javascript; charset=utf-8` (`application/javascript` is legacy and deprecated per RFC 9239). |
| Text MIME Charsets | IANA Media Types | ✓ | All text and data MIME types (`text/html`, `text/css`, `application/json`, `application/geo+json`) include explicit `charset=utf-8`. |
| Server-Sent Events (SSE) | WHATWG EventSource | ✓ | Endpoint `/bascik-live-reload` sends `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, and standard double-newline frames (`data: ...\n\n`). Injected client includes automatic reconnect and focus re-sync. |
| Path Traversal Security | WHATWG URL Standard | ✓ | Decodes request paths and strictly enforces boundary containment within `dist/`. Rejects `/../` path segments with `400 Bad Request`. |
| Sitemaps Protocol | Sitemaps.org / W3C | ✓ | Generates valid XML sitemaps with namespace `http://www.sitemaps.org/schemas/sitemap/0.9`, escaping XML metacharacters and normalizing canonical URLs. |
| Robots Exclusion Protocol | IETF RFC 9309 | ✓ | Generates RFC 9309 compliant `robots.txt` pointing crawlers at the XML sitemap. |
