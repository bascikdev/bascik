# Preserve Scoping

Keep selected component attributes literal when an external system or browser API must see the original `id`, `name`, or `class` values. Preserving a value also stops Bascik from rewriting the references that point to it or sit beside it, so read the reference rules below before preserving an `id`.

## How Preserve Works

Bascik scopes `id`, `name`, and `class` inside components so repeated instances never collide. It also rewrites the references that follow those ids: `<label for>`, `aria-*` id lists, fragment-only `href` values on `<a>`, `<area>`, and `<use>`, SVG `url(#id)` values, and similar attributes.

Preserve removes a region from both halves of that process:

- **Declarations inside the preserved region are not scoped.** An element with `id="target"` keeps `id="target"`.
- **References inside the preserved region are not rewritten.** A `href="#other"` there stays `#other`, even when `#other` is a scoped id elsewhere in the component.

Because a preserved id is never declared as scoped, a reference *outside* the region that points at it is left alone too, and it keeps working.

## Reference Rules

Links and their targets must agree. Both ends are literal, or both ends are scoped together.

| Link | Target | Result |
| --- | --- | --- |
| Normal | Preserved | Works. The target keeps its literal `id` and the link stays literal. |
| Preserved | Preserved | Works. Both stay literal. |
| Normal | Normal | Works. Bascik rewrites both to the same scoped id. |
| **Preserved** | **Normal** | **Broken.** The link stays `#target` while the target becomes a scoped id. |

The broken case happens when a link sits inside a preserved subtree and points at an id that is scoped:

```html
<!-- Broken: the nav is preserved, so its href is never rewritten,
     but #target is still scoped. The link points at nothing. -->
<nav data-bascik-preserve="id"><a href="#target">Jump</a></nav>
<section id="target">Content</section>
```

Fix it by preserving the target too, or by moving the link out of the preserved region:

```html
<nav><a href="#target">Jump</a></nav>
<section id="target" data-bascik-preserve="id">Content</section>
```

> **Skip links.** Preserving `id` on the link of a skip link is the usual way to hit the broken case. For a "Skip to main content" link, do not preserve the link. Put the target on the page shell instead, where ids are never scoped, as described in [Page Shells vs. Component Templates](/components#page-shells-vs-component-templates-landmarks-skip-links).

A `<label for>` outside a preserved region that points at a preserved input behaves the same way: the input keeps its literal id and the label stays literal, so the pair still works.

## Third-Party Widget Mount Points

Add a bare `data-bascik-preserve` directive when a third-party script looks up a literal mount ID:

```html
<div id="turnstile-container" data-bascik-preserve></div>
<script>
  turnstile.render('turnstile-container');
</script>
```

The bare directive preserves `id`, `name`, and `class` on the element and every descendant. Bascik removes the directive from compiled output.

## External Form Endpoints

External services usually require exact field names. Preserve only `name` so IDs and classes keep their normal component isolation:

```html
<form action="https://forms.example/submit" method="post" data-bascik-preserve="name">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
</form>
```

Values are space-separated. The valid tokens are `id`, `name`, and `class`:

```html
<div id="mount" class="vendor-theme" data-bascik-preserve="id class"></div>
```

An unknown token produces a warning and is ignored. Valid tokens beside it still apply.

Preserving only `name` leaves ids scoped, so the `label for="email"` above is still rewritten together with its input id.

> **Radio group tradeoff.** Normal `name` scoping gives each component instance an independent radio group while keeping radios within one instance grouped together. Preserving `name` gives every instance the same literal group name, so selecting a radio in one instance can clear the selection in another. Prefer `data-bascik-preserve="name"` only where an external endpoint requires literal names. Do not disable `scoping.attributes.name` site-wide for this case.

## Hand-Authored SVG

A bare directive keeps an SVG's whole internal id graph literal when another tool or script owns it. Declarations and `url(#id)` references are both inside the region, so they stay consistent:

```html
<svg data-bascik-preserve viewBox="0 0 100 100">
  <defs>
    <linearGradient id="brand-gradient"></linearGradient>
  </defs>
  <rect fill="url(#brand-gradient)" width="100" height="100"></rect>
</svg>
```

## Preserve Every Matching Tag

Use `scoping.preserve` for a tag that should always be preserved across all components:

```ts
export default defineConfig({
  scoping: {
    preserve: ['code'],
  },
});
```

Configured tags use the same behavior as a bare directive. Their `id`, `name`, and `class` attributes, contents, and descendants remain unscoped. The default is `['code']`.

Entries can also be wildcard patterns, which is useful for preserving an entire family of third-party web components at once. A `*` matches any run of tag-name characters:

```ts
export default defineConfig({
  scoping: {
    preserve: ['vendor-*', '*-widget'],
  },
});
```

`vendor-*` preserves every tag whose name starts with `vendor-`, `*-widget` matches a suffix, and a bare `*` preserves every tag. A wildcard-matched tag behaves exactly like an exact-name entry.

Preserve affects attribute and content scoping only. It does not change component resolution: a component tag inside a preserved element still expands.

Preserve scopes are inherited and nesting only widens. A descendant can add preserved attribute types, but it cannot re-enable scoping disabled by an ancestor.

## Preserve Does Not Silence Unresolved-Tag Warnings

A hyphenated tag with no component file prints `Unresolved component tag` during transpilation and appears in `bascik --check`, even when `scoping.preserve` matches it. Preserve and component resolution are separate. If a tag belongs to a browser custom element or a third-party library, declare it in [`components.external`](/configuration#componentsexternal):

```ts
export default defineConfig({
  components: {
    external: ['heading-anchors', 'vendor-*'],
  },
  scoping: {
    // Only needed if the element's contents must keep literal ids and classes.
    preserve: ['vendor-*'],
  },
});
```

The two options are independent. Most external elements need only `components.external`.
