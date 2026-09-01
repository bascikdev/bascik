# Attribute Inheritance

Any attribute on a component usage tag that is not a Bascik-specific attribute (`data-bascik-*`) is automatically merged onto the component's root element. This is analogous to Vue's "fallthrough attributes".

## How It Works

When Bascik transpiles a component, it reads the usage tag, extracts any inheritable attributes, and merges them onto the first element of the compiled output. The component template and the usage attributes are combined, classes are appended, all other attributes are forwarded:

If a component template contains multiple root elements (for example, a heading followed by a paragraph), inherited attributes are merged onto the **first** root HTML element in the component template.

Leading text nodes and metadata elements such as `<link>` and `<meta>` remain in place and do not consume inherited attributes. Bascik continues to the first content element, even when its quoted attribute values contain `>`.

The demo above shows the usage tag and component template separately under Source, then combines them under Output → HTML.

## Class Merging

When the root element already has a scoped `class`, the inherited class is **appended** rather than replacing it.

In the demo output, the scoped `inherit-card` class and usage-site `featured-card` class both remain on the root `<article>`.

When both the component root and usage tag define `style`, Bascik appends the usage declarations after the root declarations. Normal CSS cascade rules therefore let the usage declaration win when both set the same property.

## What Gets Inherited

All attributes on the usage tag are inherited **except** `data-bascik-*` attributes, which are consumed by Bascik for slots, props, and build instructions.

Common use cases:

- **Layout classes:** `class="sticky"`, `class="hidden"`
- **Accessibility:** `aria-label`, `role`, `aria-hidden`
- **Testing hooks:** `data-testid`, `data-cy`
- **Custom data:** any `data-*` attribute except `data-bascik-*`

Attribute inheritance is root-only. To send a prop to an attribute on a non-root element, use [`data-bascik-attr-{attribute}="{propName}"`](/props#put-a-prop-in-an-attribute). Use slots when the consumer should provide the element or richer markup itself.

## What Happens with `id`

`id` is treated like any other inheritable attribute **unless the component root already has its own `id`**.

The demo passes `id="featured-inheritance"` to a template root with no ID; Output → HTML shows it forwarded unchanged.

If the template root already defines an `id`, Bascik keeps the template's root `id` and does not overwrite it with the usage-site `id`. That prevents root-level collisions while still letting you anchor page-level CSS or JavaScript to a component root that does not already declare one.

> **Practical rule:** If page code needs to target a component root by `id`, put the `id` on the usage tag only when the component root does not already define one.

## Interaction with Scoped Classes

Inherited class names are not scoped, they are treated as global classes. This is intentional: you are passing a page-level concern onto the component's root element.

```html
<my-card class="featured">
  <p>Featured content</p>
</my-card>
```

The `featured` class is a global class that you define in your page-level stylesheet, separate from the component's scoped CSS.

> **Self-closing syntax works too:** Attribute inheritance works with both paired and self-closing usage syntax: `<my-icon class="large" aria-hidden="true" />`

**MDN reference.** Bascik forwards standard HTML attributes instead of inventing a new API. Use [MDN's HTML attribute reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes) as the primary guide for what each inherited attribute means.

## Disabling It

Attribute inheritance is enabled by default. Set `inheritAttributes: false` in `bascik.config.ts` when you want every component root to be controlled only by its own template:

```js
export default {
  inheritAttributes: false,
};
```

## See it in action

This example forwards a class, an ID, an accessibility label, and a testing hook onto the component root.

<!-- demo:source-usage -->
```html
<inherit-demo-card
  class="featured-card"
  id="featured-inheritance"
  aria-label="Featured inheritance demo"
  data-testid="inherit-demo">
</inherit-demo-card>
```

<!-- demo:source-html -->
```html
<article class="inherit-card">
  <p class="inherit-card-kicker">Template root</p>
  <h3 class="inherit-card-title">Attribute inheritance</h3>
  <p class="inherit-card-body">Usage attributes merge onto this root element at build time.</p>
</article>
```

<!-- demo:source-css -->
```css
.inherit-card {
  width: min(100%, 34rem);
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px;
}

.inherit-card-kicker {
  margin: 0 0 10px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #d3ff8d;
}

.inherit-card-title {
  margin: 0 0 10px;
  font-size: 1.05rem;
}

.inherit-card-body {
  margin: 0;
  color: #8d929e;
}
```

<!-- demo:output-html -->
```html
<article
  class="bascik__inherit-demo-card__inherit-card featured-card"
  id="featured-inheritance"
  aria-label="Featured inheritance demo"
  data-testid="inherit-demo">
  <p class="bascik__inherit-demo-card__inherit-card-kicker">Template root</p>
  <h3 class="bascik__inherit-demo-card__inherit-card-title">Attribute inheritance</h3>
  <p class="bascik__inherit-demo-card__inherit-card-body">Usage attributes merge onto this root element at build time.</p>
</article>
```
