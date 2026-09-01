# Props

Props let you pass text values into a component template at usage time using `data-bascik-prop-*` attributes.

## Define and pass props

Props in Bascik borrow the same basic idea as props in React: pass values into a reusable component from the usage site. In Bascik, the mechanism is vanilla HTML via `data-bascik-prop-*` attributes.

Add a `data-bascik-prop-{name}` attribute (no value) to any element in the component template. The element's inner content will be replaced with the prop value at build time.

Set `data-bascik-prop-{name}="value"` on the component tag. The value is injected into the matching template element.

Prop values are HTML-escaped when injected, so `&`, `<`, `>`, quotes, and apostrophes render as text rather than markup. Use entity-encoded quotes such as `&quot;` or `&#39;` inside the usage attribute. Use a [slot](/slots) when the value should be interpreted as HTML.

<!-- demo:basic-props-html -->
```html
<aside class="alert-box">
  <strong class="alert-box-title" data-bascik-prop-title>Notice</strong>
  <p class="alert-box-message" data-bascik-prop-message>
    Props replace this text at build time.
  </p>
</aside>
```

<!-- demo:basic-props-css -->
```css
.alert-box {
  padding: 20px;
  border: 1px solid #3a3d40;
  border-left: 3px solid #d3ff8d;
}
```

<!-- demo:basic-props-usage -->
```html
<alert-box
  data-bascik-prop-title="Success"
  data-bascik-prop-message="Your changes have been saved.">
</alert-box>
```

<!-- demo:basic-props-output-html -->
```html
<aside class="bascik__alert-box__alert-box">
  <strong class="bascik__alert-box__alert-box-title">Success</strong>
  <p class="bascik__alert-box__alert-box-message">Your changes have been saved.</p>
</aside>
```

## Props with Existing Attributes

Other attributes on the target element are preserved. The prop marker attribute itself is removed from the output.

```html
<!-- template -->
<p class="lead" data-bascik-prop-body></p>

<!-- compiled -->
<p class="bascik__comp__lead">Your prop value here.</p>
```

## Put a Prop in an Attribute

Use `data-bascik-attr-{attribute}="{propName}"` when the same prop values should go to an element attribute instead of its inner content. The attribute name may contain hyphens, including `aria-*` and `data-*` targets.

```html
<!-- component template -->
<article class="card">
  <img data-bascik-attr-src="image" data-bascik-attr-alt="alt">
  <a data-bascik-attr-href="link">Read more</a>
</article>

<!-- usage -->
<media-card
  data-bascik-prop-image="/images/launch.jpg"
  data-bascik-prop-alt="Product launch"
  data-bascik-prop-link="/launch">
</media-card>
```

The directive is removed from compiled output. If the named prop is missing, Bascik adds no target attribute. If the target attribute already exists, the prop value wins and Bascik warns. Values are HTML-attribute-escaped. Bound `id`, `name`, and `class` values enter the normal scoping pipeline.

This is the same prop mechanism with a different destination. It adds no variables, expressions, interpolation, or templating syntax. A prop may independently drive both element content and an attribute.

## Naming Conventions

Prop names use the portion of the attribute after `data-bascik-prop-`. You can use lowercase alphanumeric names with hyphens:

```html
data-bascik-prop-title
data-bascik-prop-href
data-bascik-prop-alt-text
data-bascik-prop-icon-url
```

> **Use slots for HTML content.** Props inject plain text values. If you need to inject rich HTML, nested elements, or reusable layout regions, use [slots](/slots) instead.

```html
<!-- template -->
<article>
  <h2 data-bascik-prop-title></h2>
  <div data-bascik-slot></div>
</article>

<!-- usage: the prop is text, while the slot remains markup -->
<feature-card data-bascik-prop-title="Use &lt;strong&gt; safely">
  <strong>New</strong>
  <status-badge data-bascik-prop-label="Ready"></status-badge>
</feature-card>
```

Props are read only from the component's opening usage tag. A prop declared on a nested component in slot content belongs to that nested component and never leaks into its parent.

## Why `data-*`?

Bascik extends HTML through standard `data-*` attributes rather than a custom template language. Browsers already understand `data-*`, and you do **not** need to use props or slots to make Bascik useful, plain reusable HTML components still work without them.

> **MDN reference.** For the underlying attribute rules, treat [MDN's `data-*` attribute reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/data-*) and the broader [HTML reference](https://developer.mozilla.org/en-US/docs/Web/HTML) as the primary documentation.

## Example: Feature Card

A common pattern is a card component with a configurable label, title, and description:

```html
<!-- src/components/feature-card.html -->
<div class="card">
  <span class="card-label" data-bascik-prop-label></span>
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-desc></p>
</div>
```

```html
<feature-card
  data-bascik-prop-label="New"
  data-bascik-prop-title="Live Reload"
  data-bascik-prop-desc="Automatic browser reload on every change.">
</feature-card>
```

## See it in action

This example passes values directly into the `feature-card` component via `data-bascik-prop-*` attributes.

<!-- demo:source-usage -->
```html
<feature-card
  data-bascik-prop-title="Component Props"
  data-bascik-prop-desc="These values are injected into the component template at build time.">
</feature-card>
```

<!-- demo:source-html -->
```html
<div class="fcard">
  <h3 data-bascik-prop-title></h3>
  <p data-bascik-prop-desc></p>
</div>
```

<!-- demo:source-css -->
```css
.fcard {
  padding: 24px;
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;

  h3 { color: #f0f1f2; }
  p  { font-size: 0.875rem; color: #8d929e; }

  &:hover {
    border-color: rgba(211,255,141,0.35);
    box-shadow: 0 0 0 1px rgba(211,255,141,0.12);
  }
}
```

<!-- demo:output-html -->
```html
<div class="bascik__feature-card__fcard">
  <h3 class="bascik__feature-card__el__h3">Component Props</h3>
  <p class="bascik__feature-card__el__p">These values are injected into the component template at build time.</p>
</div>
```
