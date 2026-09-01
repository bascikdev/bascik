# Preserve Scoping

Keep selected component attributes literal when an external system, browser API, or authored ID graph must see the original values.

## Third-Party Widget Mount Points

Bascik scopes component IDs by default. Add a bare `data-bascik-preserve` directive when a third-party script looks up a literal mount ID:

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

> **Radio group tradeoff.** Normal `name` scoping gives each component instance an independent radio group while keeping radios within one instance grouped together. Preserving `name` gives every instance the same literal group name, so selecting a radio in one instance can clear the selection in another. Prefer `data-bascik-preserve="name"` only where an external endpoint requires literal names. Do not disable `scoping.attributes.name` site-wide for this case.

## Hand-Authored SVG

A bare directive can keep an SVG's internal ID graph literal when another tool or script owns it:

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

Preserve scopes are inherited and nesting only widens. A descendant can add preserved attribute types, but it cannot re-enable scoping disabled by an ancestor.