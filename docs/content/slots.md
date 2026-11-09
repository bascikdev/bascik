# Slots

Slots let you pass inner HTML content into a component at the usage site. Bascik supports a default slot, named slots, and slot fallback content.

Slot content is the raw-markup path for components. Elements remain HTML and may include nested Bascik components. Bascik adds scoped class names only to elements in the component's own template, so the component's CSS cannot target a class on slotted markup, and an element selector such as `footer a` never reaches a slotted element. Style slotted content with `:is()` under a scoped wrapper class (see the example below), or from the page's own CSS. Prop values are escaped text instead; see [Props](/props).

## Default slots and fallback content

Add `data-bascik-slot` (no value) to any element in your component template to mark where inner content should be inserted. The element itself is replaced by the slot content, unless it is the component's root element: then the root stays and the content (or the fallback) goes inside it, so the root keeps its own class and receives the attributes written on the component tag.

Place default content inside the marker and it renders whenever the component tag has no inner content.

<!-- demo:basic-slot-html -->

```html
<section>
  <p class="label">Default slot</p>
  <div data-bascik-slot>
    <p class="fallback">Fallback content appears when the tag is empty.</p>
  </div>
</section>
```

<!-- demo:basic-slot-css -->

```css
section {
  min-height: 9rem;
  padding: 20px;
  border: 1px solid #3a3d40;
}
```

<!-- demo:basic-slot-usage -->

```html
<simple-slot-card>
  <p>Custom content replaces the fallback.</p>
</simple-slot-card>

<simple-slot-card />
```

<!-- demo:basic-slot-output-html -->

```html
<section class="b_el_simple-slot-card_section">
  <p class="label">Default slot</p>
  <p>Custom content replaces the fallback.</p>
</section>

<section class="b_el_simple-slot-card_section">
  <p class="label">Default slot</p>
  <p class="fallback">Fallback content appears when the tag is empty.</p>
</section>
```

## Named Slots

Use `data-bascik-slot="name"` in the component template to define named slot zones. At the usage site, wrap content for each zone with the same attribute.

The first demo on this page combines named `eyebrow`, `title`, and `actions` slots with a default body slot. Open its Source tab to compare the component template with its usage.

Slotted content can also be read by the component's script. The [Tab Group](/example-components/tab-group) turns each slotted section into a tab, and the [Filter List](/example-components/filter-list) filters its slotted `<li>` items.

> **How it works:** Named slot wrappers in the usage inner HTML are extracted by name and injected into the matching `data-bascik-slot="name"` placeholder in the template. Everything left over goes into the default slot.
>
> **A name the template does not declare is dropped.** Content wrapped for a slot name with no matching `data-bascik-slot="name"` in the template does not render, and the build and dev server print a warning naming the component, the slot, and the file the usage is in. Names match in any letter case.
>
> **The wrapper is removed.** The usage-site element that carries `data-bascik-slot="name"` only names the zone. Bascik keeps what is inside it and drops the element, with its tag and attributes. Writing `<a data-bascik-slot="actions" href="/docs">Docs</a>` leaves the text `Docs` with no link. Put the real element inside the wrapper: `<div data-bascik-slot="actions"><a href="/docs">Docs</a></div>`.

## Forwarding a Slot into a Nested Component

A component template can use another component. To pass the outer component's default slot content through to the inner component, put a valueless `data-bascik-slot` marker between the inner component's tags:

```html
<!-- outer-box.html -->
<div class="outer">
  <inner-box>
    <div data-bascik-slot>Shown when the outer tag is empty.</div>
  </inner-box>
</div>
```

```html
<outer-box><p>Given to the outer component.</p></outer-box>
```

The `<p>` becomes the inner component's default slot content. When the outer tag is empty, the marker's own content is used. Each instance forwards its own content.

Only the default slot is forwarded. A named wrapper written between the inner component's tags (`<div data-bascik-slot="head">`) fills the inner component's named slot, and the outer component's named slots are filled separately by the outer usage. Forwarding works through any depth of nesting.

## Whitespace Handling

Leading and trailing whitespace is trimmed from all slot content at build time, default and named alike. This means you can write component usage on multiple lines without worrying about stray newlines or indentation appearing in the output:

```html
<!-- these two usages produce identical output -->

<my-card><p>Hello</p></my-card>

<my-card>
  <p>Hello</p>
</my-card>
```

Whitespace _within_ slot content is preserved exactly as written. A named slot wrapper (`<div data-bascik-slot="actions">`) is trimmed the same way: the newline and indentation inside the wrapper never reach the output, so a wrapper written on several lines renders the same as one written on a single line.

> **Code examples stay literal by default.** Bascik skips transpilation inside `<code>` elements by default, so slot trimming only applies to regular component resolution. If you configure `scoping.preserve: ['code', 'pre']`, raw `<pre>` content is preserved too.

**MDN reference.** Bascik slots are build-time insertion points built with standard HTML plus `data-*` attributes. For the actual elements you place into slots, treat [MDN's HTML reference](https://developer.mozilla.org/en-US/docs/Web/HTML) as the primary source of truth.

## See it in action

This example uses three named slots (`eyebrow`, `title`, and `actions`) plus the default slot for the body content.

<!-- demo:source-usage -->

```html
<slot-layout-demo>
  <span data-bascik-slot="eyebrow">Named slot</span>
  <span data-bascik-slot="title">Build-time slot layout</span>
  <p>
    Use named slots for fixed regions and the default slot for body content.
  </p>
  <div data-bascik-slot="actions">
    <a href="/configuration">Read configuration</a>
  </div>
</slot-layout-demo>
```

<!-- demo:source-html -->

```html
<section>
  <header>
    <p class="eyebrow">
      <span data-bascik-slot="eyebrow">Overview</span>
    </p>
    <h3>
      <span data-bascik-slot="title">Fallback title</span>
    </h3>
  </header>

  <div class="body">
    <div data-bascik-slot>
      <p>Fallback body copy.</p>
    </div>
  </div>

  <footer class="actions">
    <div data-bascik-slot="actions">
      <a href="/getting-started">Read docs</a>
    </div>
  </footer>
</section>
```

<!-- demo:source-css -->

```css
section {
  width: min(100%, 34rem);
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px;
}

header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.eyebrow {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #d3ff8d;
}

h3 {
  margin: 0;
  font-size: 1.1rem;
}

footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #3a3d40;
}

.actions :is(a) {
  display: inline-flex;
  font-weight: 600;
  color: #d3ff8d;
  text-decoration: none;
}
```

<!-- demo:output-html -->

```html
<section class="b_el_slot-layout-demo_section">
  <header class="b_el_slot-layout-demo_header">
    <p class="bascik__slot-layout-demo__eyebrow">Named slot</p>
    <h3 class="b_el_slot-layout-demo_h3">Build-time slot layout</h3>
  </header>
  <div class="body">
    <p>
      Use named slots for fixed regions and the default slot for body content.
    </p>
  </div>
  <footer
    class="bascik__slot-layout-demo__actions b_el_slot-layout-demo_footer"
  >
    <a href="/configuration">Read configuration</a>
  </footer>
</section>
```

<!-- demo:output-css -->

```css
.b_el_slot-layout-demo_section {
  width: min(100%, 34rem);
  background: #242628;
  border: 1px solid #3a3d40;
  border-radius: 10px;
  padding: 24px;
}

.b_el_slot-layout-demo_header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.bascik__slot-layout-demo__eyebrow {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #d3ff8d;
}

.b_el_slot-layout-demo_h3 {
  margin: 0;
  font-size: 1.1rem;
}

.b_el_slot-layout-demo_footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #3a3d40;
}

.bascik__slot-layout-demo__actions :is(a) {
  display: inline-flex;
  font-weight: 600;
  color: #d3ff8d;
  text-decoration: none;
}
```

> **Why `.actions :is(a)` and not `footer a`.** The link comes from the usage site, so Bascik never adds a scoped class to it. A selector like `footer a` is rewritten to need that class and matches nothing. `:is(a)` leaves the element name alone, so the rule reaches the slotted link, while `.actions` stays scoped to this component. `.body` has no rule in the CSS, so it stays unscoped. See [Element selector vs. slotted content](/compatibility#selectors).
