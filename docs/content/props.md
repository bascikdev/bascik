# Props

Props let you pass text values into a component template at usage time using `data-bascik-prop-*` attributes.

## Define and pass props

Props in Bascik borrow the same basic idea as props in React: pass values into a reusable component from the usage site. In Bascik, the mechanism is vanilla HTML via `data-bascik-prop-*` attributes.

Add a `data-bascik-prop-{name}` attribute (no value) to any element in the component template. The element's inner content will be replaced with the prop value at build time.

The receiver needs an end tag, since the value becomes its content. On a void element such as `<meta>` or `<img>`, or on an element the template leaves unclosed, the value is not written and Bascik warns, naming the component file; bind the value to an attribute instead (see [Put a prop in an attribute](#put-a-prop-in-an-attribute)). An end tag with attributes or a slash, such as `</p class="x">`, still closes the element, as it does in a browser.

Set `data-bascik-prop-{name}="value"` on the component tag. The value is injected into the matching template element.

Prop values are HTML-escaped when injected, so `&`, `<`, `>`, quotes, and apostrophes render as text rather than markup. Use entity-encoded quotes such as `&quot;` or `&#39;` inside the usage attribute. Use a [slot](/slots) when the value should be interpreted as HTML.

Character references in a prop value are decoded the way the browser decodes an attribute value, then the character is escaped once where it lands, so `data-bascik-prop-title="Milk &mdash; frother"` shows an em dash. Bascik decodes every numeric reference (`&#8212;`, `&#x2014;`), the named references whose character is ASCII (`&amp;`, `&quot;`, `&apos;`, `&colon;`), and the 252 named references of HTML 4, which cover Latin-1 letters and symbols (`&eacute;`, `&nbsp;`, `&copy;`), Greek letters, math symbols, arrows and typographic punctuation (`&mdash;`, `&hellip;`, `&rsquo;`, `&euro;`, `&trade;`). A named reference outside that set, or one without its closing `;`, stays as written and shows as text: write the character itself instead, or its numeric reference.

A receiver on a `<script>` or `<style>` element is never filled: escaping cannot keep a value from running as code there. The element keeps the template's own text and Bascik warns. To hand a value to a script, bind it to a `data-*` attribute (see below) and read it from the element's `dataset`.

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
  data-bascik-prop-message="Your changes have been saved."
>
</alert-box>
```

<!-- demo:basic-props-output-html -->

```html
<aside class="bascik__alert-box__alert-box">
  <strong class="bascik__alert-box__alert-box-title">Success</strong>
  <p class="bascik__alert-box__alert-box-message">
    Your changes have been saved.
  </p>
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
  <img data-bascik-attr-src="image" data-bascik-attr-alt="alt" />
  <a data-bascik-attr-href="link">Read more</a>
</article>

<!-- usage -->
<media-card
  data-bascik-prop-image="/images/launch.jpg"
  data-bascik-prop-alt="Product launch"
  data-bascik-prop-link="/launch"
>
</media-card>
```

The directive is removed from compiled output. If the named prop is missing, Bascik adds no target attribute. If the target attribute already exists, the prop value wins and Bascik warns. Values are HTML-attribute-escaped. Bound `id` and `class` values enter the normal scoping pipeline. A bound `name` ships as the prop's value, which gives each usage its own radio group or `<details>` group (see [Component Best Practices](/component-best-practices#name-form-controls-and-groups)); with `scoping.attributes.name: true` it is scoped too.

A few targets give the browser a value to run, and escaping cannot make that safe, so Bascik checks them. The rules are the same at build time and when a [server script returns the tag](/server-scripts#security):

- **URL attributes** (`href`, `xlink:href`, `src`, `srcset`, `action`, `formaction`, `poster`, `cite`, `ping`, and other URL attributes) keep any URL except one that can run script: script URLs such as `javascript:`, and `data:` URLs, are replaced with `about:invalid` and Bascik warns. Relative, `https:`, `mailto:`, `tel:`, `sms:`, `webcal:`, and app URLs are kept. Where the element only shows a picture (`<img src>`, `srcset` on `<img>` and `<source>`, `<video poster>`, `<input type="image" src>`), a `data:image/...` URL is kept too, for placeholders. Leading spaces, control characters, tabs, and line breaks are ignored when the scheme is read, as the browser does. A `srcset` is split into URLs the way the browser splits it (a comma inside a URL is part of it), and one script URL in a `srcset` or `ping` list replaces the whole value.
- **URLs the page runs or applies**, `<script src>` (and `href` on an SVG `<script>`), `<object data>`, `<embed src>`, `<base href>`, and a stylesheet or preload `<link href>`, take any `http:` or `https:` URL, another site's included, as the browser does. They get the same script-scheme check as every URL binding. Whoever picks such a URL picks the code or styles the page runs, so when it can come from visitor-influenced data, restrict it as [Loading scripts and styles from other sites](/security#loading-scripts-and-styles-from-other-sites) describes: a CSP `script-src` or `style-src`, `safeUrl(value, { origins })`, or the URL written in the template.
- **SVG animations** (`<set>`, `<animate>`, `<animateMotion>`, `<animateTransform>`) write `to`, `from`, `by`, and `values` into another attribute, so each `;`-separated value gets the URL check. `attributeName` is never bound, and nothing is bound into a value animated into an `on*` attribute.
- **Event handlers** (`on` followed by letters only, such as `data-bascik-attr-onclick`; a name with a hyphen like `onboarding-step` is an ordinary attribute), **`srcdoc`**, and **`<meta http-equiv>`** (its `content` or `http-equiv`) are never bound: their values are code, a whole document, or an instruction to the page such as a redirect. Bascik warns and leaves the template's own attribute, if any.
- **`style`** is not bound when the value runs script or imports CSS: `expression(`, `behavior:`, `-moz-binding`, `@import`, or one of the script URLs such as `javascript:` or a non-image `data:` URL, in `url()`, `image-set()`, or a string. CSS escapes are decoded before the check. Plain declarations and images are bound: `color: red`, `--progress: 40%`, `background-image: url(/img/hero.jpg)`.

Each of these checks is a protection that changes what you wrote, so each can be turned off by name: [`security.blockScriptUrls: false`](/configuration#security) binds every URL as given, and [`security.blockCodeBindings: false`](/configuration#security) binds event handlers, `srcdoc`, `<meta http-equiv>`, SVG animation targets and unsafe `style` values, and fills `<script>` and `<style>` receivers. An attribute value is still escaped, so it stays one attribute; a `<script>` or `<style>` gets the text as written, with only `</script` (or `</style`) changed to `<\/script` so it cannot end the element. Turning `blockCodeBindings` off lets a prop become code. See [Turning protections off](/security#turning-protections-off).

This is the same prop mechanism with a different destination. It adds no variables, expressions, interpolation, or templating syntax. A prop may independently drive both element content and an attribute.

The [Copy Button](/example-components/copy-button) example binds its `text` prop to a `data-text` attribute that its script reads, and uses `label` as the button's content.

## Naming Conventions

Prop names use the portion of the attribute after `data-bascik-prop-`. You can use lowercase alphanumeric names with hyphens:

```html
data-bascik-prop-title data-bascik-prop-href data-bascik-prop-alt-text
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
  data-bascik-prop-desc="Automatic browser reload on every change."
>
</feature-card>
```

## See it in action

This example passes values directly into the `feature-card` component via `data-bascik-prop-*` attributes.

<!-- demo:source-usage -->

```html
<feature-card
  data-bascik-prop-title="Component Props"
  data-bascik-prop-desc="These values are injected into the component template at build time."
>
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

  h3 {
    color: #f0f1f2;
  }
  p {
    font-size: 0.875rem;
    color: #8d929e;
  }

  &:hover {
    border-color: rgba(211, 255, 141, 0.35);
    box-shadow: 0 0 0 1px rgba(211, 255, 141, 0.12);
  }
}
```

<!-- demo:output-html -->

```html
<div class="bascik__feature-card__fcard">
  <h3 class="bascik__feature-card__el__h3">Component Props</h3>
  <p class="bascik__feature-card__el__p">
    These values are injected into the component template at build time.
  </p>
</div>
```
