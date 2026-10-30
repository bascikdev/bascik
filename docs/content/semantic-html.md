# Semantic HTML

Bascik is built on web standards: HTML, CSS, and JavaScript as browsers ship them, with no runtime in between. Semantic HTML is the same idea applied to your markup. Pick the element the [HTML standard](https://html.spec.whatwg.org/multipage/) defines for the job, and browsers, search engines, AI agents, and screen readers already know what it means.

Bascik ships the code you wrote. A component tag is replaced by its template, and the elements in that template are the elements visitors get. Bascik never adds a wrapper, never turns a `<nav>` into a `<div>`, and never turns a `<div>` into a `<nav>`. The choice of element is yours, and Bascik keeps it.

## Why It Matters

- **Accessibility comes with it.** A `<button>` is focusable, works with Enter and Space, and is announced as a button. A `<nav>` is a landmark a screen reader lists and jumps to. You get this from the element, with no ARIA and no script.
- **Less JavaScript.** `<details>`, `<dialog>`, the `popover` attribute, and form validation are built into the browser. A component that uses them needs no script at all.
- **Machines read structure.** Search engines and [AI agents](/lighthouse/agentic-browsing) read headings, landmarks, lists, and tables to understand a page.
- **It is easier to change.** A `<footer>` says what it is. A `<div class="ft-wrap">` needs a comment.

## Components Keep Their Semantics

A component's root element is the element that replaces its tag, and attributes on the usage tag (`class`, `aria-label`, `id`) land on it through [attribute inheritance](/attribute-inheritance). A `class` is appended to the root's own, but any other attribute already on the root wins over the same attribute on the usage tag. So leave a label off the component's root and pass it where the component is used, as the demos below do. Make the root the element for the component's job, not a wrapper `<div>` around it.

| Component job                         | Root element                         |
| ------------------------------------- | ------------------------------------ |
| Site navigation, breadcrumbs, paging  | `<nav aria-label="...">`             |
| Site header or footer                 | `<header>`, `<footer>`               |
| A post, review, or testimonial        | `<article>`                          |
| A region with its own heading         | `<section>`                          |
| A form                                | `<form>`                             |
| Content beside the main content       | `<aside>`                            |
| An image or code sample with caption  | `<figure>` with `<figcaption>`       |
| An action (open, save, toggle, close) | `<button type="button">`             |
| A disclosure (show more, FAQ answer)  | `<details>` with `<summary>`         |
| A list of links or items              | `<ul>` or `<ol>` with `<li>` per row |

A card is an [`<article>`](https://html.spec.whatwg.org/multipage/sections.html#the-article-element) only when it stands on its own, something that could be shared or reused as a whole, such as a blog post or a product. A stat, icon, or feature card is fine as a `<div>`, or as an `<li>` when the cards form a list. Every `<article>` adds an entry to the accessibility tree, so a page of them is noise for a screen reader user.

### Bad: A Wrapper Div

This `<site-nav>` looks the same as the good one below, but its output is a `<div>` of links. A screen reader does not list it as navigation, and the `aria-label` from the usage tag lands on a `<div>`, where it means nothing.

<!-- demo:semantic-nav-bad-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother</title>
  </head>
  <body>
    <site-nav aria-label="Demo site" />
    <main id="main">
      <h1>Milk frother</h1>
    </main>
  </body>
</html>
```

<!-- demo:semantic-nav-bad-html -->

```html
<!-- src/components/site-nav/site-nav.html -->
<style>
  .nav {
    display: flex;
    gap: 1rem;
  }
</style>
<div class="nav">
  <a class="link" href="/">Home</a>
  <a class="link" href="/components">Components</a>
  <a class="link" href="/faq">FAQ</a>
</div>
```

<!-- demo:semantic-nav-bad-output -->

```html
<!-- src/components/site-nav/site-nav.html -->

<div class="bascik__site-nav__nav" aria-label="Demo site">
  <a class="link" href="/">Home</a>
  <a class="link" href="/components">Components</a>
  <a class="link" href="/faq">FAQ</a>
</div>

<main id="main">
  <h1>Milk frother</h1>
</main>
```

### Good: The Root Is the Nav

The root is a `<nav>`, the links are a list, and the `aria-label` from the usage tag names the landmark, which a screen reader announces as "Demo site navigation". It looks the same. Bascik adds no element or role to it; only the scoped class names change.

<!-- demo:semantic-nav-good-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother</title>
  </head>
  <body>
    <site-nav aria-label="Demo site" />
    <main id="main">
      <h1>Milk frother</h1>
    </main>
  </body>
</html>
```

<!-- demo:semantic-nav-good-html -->

```html
<!-- src/components/site-nav/site-nav.html -->
<style>
  .nav ul {
    display: flex;
    gap: 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
<nav class="nav" data-testid="site-nav">
  <ul>
    <li><a href="/">Home</a></li>
    <li><a href="/components">Components</a></li>
    <li><a href="/faq">FAQ</a></li>
  </ul>
</nav>
```

<!-- demo:semantic-nav-good-output -->

```html
<!-- src/components/site-nav/site-nav.html -->

<nav
  class="bascik__site-nav__nav"
  data-testid="site-nav"
  aria-label="Demo site"
>
  <ul class="bascik__site-nav__el__ul">
    <li><a href="/">Home</a></li>
    <li><a href="/components">Components</a></li>
    <li><a href="/faq">FAQ</a></li>
  </ul>
</nav>

<main id="main">
  <h1>Milk frother</h1>
</main>
```

## Buttons for Actions, Links for Navigation

A link (`<a href>`) goes somewhere. A button (`<button type="button">`) does something on the page. A `<div>` or `<span>` with a click listener does neither for a keyboard user: it cannot be focused with Tab, does not respond to Enter or Space, and a screen reader reads it as plain text. Adding `role="button"` and `tabindex="0"` brings back only some of that, and you then write the key handling yourself.

Here is a clickable `<div>`:

<!-- example:semantic-button-bad -->

```html
<!-- src/components/like-button/like-button.html -->
<div class="like" id="like">Like</div>
<script type="text/typescript">
  const like = document.getElementById("like") as HTMLElement;
  like.addEventListener("click", () => like.classList.toggle("on"));
</script>
```

The [`bascik` agent skill](/agent-skills)'s `audit-components.mjs` flags it with the line and the fix:

<!-- example:semantic-button-audit -->

```text
warn  clickable-element  src/components/like-button/like-button.html:2  <div class="like"> gets a click listener from its script (#like), so it acts as a button that a keyboard cannot reach and a screen reader does not announce.
-> Use <button type="button"> (keep the class and id, and move the listener to it): it is focusable, works with Enter and Space, and is announced as a button with no extra ARIA. Reset its look with CSS (border: 0; background: none; font: inherit). Use <a href> instead when it navigates.
```

The fix is a `<button>`. `aria-pressed` tells a screen reader whether it is on, and the CSS styles that same attribute, so there is one source of truth for the state.

<!-- demo:semantic-button-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother</title>
  </head>
  <body>
    <main id="main">
      <h1>Milk frother</h1>
      <like-button />
    </main>
  </body>
</html>
```

<!-- demo:semantic-button-html -->

```html
<!-- src/components/like-button/like-button.html -->
<style>
  .like {
    padding: 0.4rem 0.9rem;
    border: 1px solid currentColor;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .like[aria-pressed="true"] {
    background: #d3ff8d;
    color: #111;
  }
</style>
<button
  class="like"
  id="like"
  type="button"
  aria-pressed="false"
  data-testid="like-button"
>
  Like
</button>
<script type="text/typescript">
  const like = document.getElementById("like") as HTMLButtonElement;
  like.addEventListener("click", () => {
    const pressed = like.getAttribute("aria-pressed") === "true";
    like.setAttribute("aria-pressed", String(!pressed));
  });
</script>
```

<!-- demo:semantic-button-output -->

```html
<main id="main">
  <h1>Milk frother</h1>
  <!-- src/components/like-button/like-button.html -->

  <button
    class="bascik__like-button__like"
    id="bascik__like-button__bc33f42c__like"
    type="button"
    aria-pressed="false"
    data-testid="like-button"
  >
    Like
  </button>
  <script>
    (function () {
      const like = document.getElementById(
        "bascik__like-button__bc33f42c__like",
      );
      like.addEventListener("click", () => {
        const pressed = like.getAttribute("aria-pressed") === "true";
        like.setAttribute("aria-pressed", String(!pressed));
      });
    })();
    //# sourceURL=src/components/like-button/like-button.html
  </script>
</main>
```

## Native Elements Before ARIA or JavaScript

The [first rule of ARIA](https://www.w3.org/TR/using-aria/#rule1) is to use a native HTML element when one exists. The same goes for JavaScript: reach for a script only when HTML and CSS cannot do the job.

- **Show and hide:** [`<details>` and `<summary>`](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-details-element) for FAQs, "read more", and accordions.
- **Modals:** [`<dialog>`](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element) with `showModal()`, which traps focus and closes on Escape.
- **Menus and tooltips:** the [`popover`](https://html.spec.whatwg.org/multipage/popover.html#the-popover-attribute) attribute with `popovertarget` on a `<button>`, with no script.
- **Input:** the right [`type`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input#input_types) (`email`, `tel`, `url`, `number`, `date`) and `autocomplete`, which bring the right mobile keyboard and autofill, plus `required` and `pattern` for validation the browser explains.

This FAQ item opens and closes with a click, Enter, or Space, and screen readers announce it as expanded or collapsed. It has no script.

<!-- demo:semantic-details-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother</title>
  </head>
  <body>
    <main id="main">
      <h1>Milk frother</h1>
      <faq-item
        data-bascik-prop-question="Does Bascik add JavaScript?"
        data-bascik-prop-answer="No. Every script in the output is one you wrote."
      />
    </main>
  </body>
</html>
```

<!-- demo:semantic-details-html -->

```html
<!-- src/components/faq-item/faq-item.html -->
<style>
  .item {
    padding: 0.75rem 0;
    border-bottom: 1px solid #3a3d40;
  }
  .question {
    font-weight: 600;
    cursor: pointer;
  }
</style>
<details class="item" data-testid="faq-item">
  <summary class="question" data-bascik-prop-question>Question</summary>
  <p data-bascik-prop-answer></p>
</details>
```

<!-- demo:semantic-details-output -->

```html
<main id="main">
  <h1>Milk frother</h1>
  <!-- src/components/faq-item/faq-item.html -->

  <details class="bascik__faq-item__item" data-testid="faq-item">
    <summary class="bascik__faq-item__question">
      Does Bascik add JavaScript?
    </summary>
    <p>No. Every script in the output is one you wrote.</p>
  </details>
</main>
```

## Checklist

Each item links to the HTML standard (WHATWG) or MDN.

- **Language:** [`lang`](https://html.spec.whatwg.org/multipage/dom.html#the-lang-and-xml:lang-attributes) on `<html>` (`<html lang="en">`), so screen readers pick the right voice and browsers the right hyphenation.
- **Landmarks:** a [`<header>`](https://html.spec.whatwg.org/multipage/sections.html#the-header-element), a [`<nav>`](https://html.spec.whatwg.org/multipage/sections.html#the-nav-element) with an `aria-label` when there is more than one, one [`<main id="main">`](https://html.spec.whatwg.org/multipage/grouping-content.html#the-main-element) per page, and a [`<footer>`](https://html.spec.whatwg.org/multipage/sections.html#the-footer-element). A skip link to `#main` comes first in the header (see [Landmarks and Skip Links](/components#page-shells-vs-component-templates-landmarks-skip-links)).
- **Headings:** one `<h1>` that names the page, then [`<h2>` to `<h6>` without skipping a level](https://html.spec.whatwg.org/multipage/sections.html#headings-and-outlines). Pick the level for the outline and the size with CSS. A component used under different levels takes its heading through a [slot](/slots).
- **Sections:** [`<section>`](https://html.spec.whatwg.org/multipage/sections.html#the-section-element) for a region with a heading, [`<article>`](https://html.spec.whatwg.org/multipage/sections.html#the-article-element) for an item that stands on its own, [`<aside>`](https://html.spec.whatwg.org/multipage/sections.html#the-aside-element) for content beside it. Use `<div>` only for styling hooks.
- **Buttons and links:** [`<button type="button">`](https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element) for actions and `<a href>` for navigation. Never a clickable `<div>` or `<span>`. A button that shows only an icon gets an `aria-label`.
- **Lists:** [`<ul>`, `<ol>`](https://html.spec.whatwg.org/multipage/grouping-content.html#the-ul-element), and `<li>` for groups of links, cards, and steps, and [`<dl>`](https://html.spec.whatwg.org/multipage/grouping-content.html#the-dl-element) for terms and their values.
- **Tables:** [`<table>`](https://html.spec.whatwg.org/multipage/tables.html#the-table-element) for tabular data, with a `<caption>` and `<th scope="col">`. Never for layout.
- **Text with meaning:** [`<figure>` and `<figcaption>`](https://html.spec.whatwg.org/multipage/grouping-content.html#the-figure-element), [`<time datetime="2026-10-29">`](https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-time-element), [`<address>`](https://html.spec.whatwg.org/multipage/sections.html#the-address-element) for contact details, `<blockquote>` for quotes, and `<code>` for code.
- **Forms:** every control has a [`<label>`](https://html.spec.whatwg.org/multipage/forms.html#the-label-element) (a placeholder is not a label), related controls sit in a [`<fieldset>` with a `<legend>`](https://html.spec.whatwg.org/multipage/form-elements.html#the-fieldset-element), and the form is a `<form>`, so Enter submits it.
- **Images:** every [`<img>` has `alt`](https://html.spec.whatwg.org/multipage/images.html#alt): words for what it shows, or `alt=""` when it is decoration. In a component, take it from a prop with `data-bascik-attr-alt`.

[MDN's guide to HTML accessibility](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML) covers each of these with examples.

## Check It

Bascik guides and warns. It never rewrites or rejects your markup, so these checks are suggestions you can weigh.

- **The `bascik` agent skill's `audit-components.mjs`** warns about a clickable `<div>` or `<span>`, a component whose root is a `<div>` when its name says it is a nav, header, footer, form, post, review, or section, a skipped heading level in a page's output (it follows headings through components and slots), an `<img>` with no `alt`, a form control with no label, and a page with no `<main>` (rules `clickable-element`, `generic-root`, `skipped-heading`, `missing-alt`, `unlabeled-control`, and `missing-main`). Each warning names `file:line` and the fix. See [Agent Skills](/agent-skills).
- **The `bascik-seo` skill's audit** checks `lang`, one `<h1>` per page, and image `alt` in the built `dist/`.
- **Lighthouse** scores accessibility on the built page. [Accessibility](/lighthouse/accessibility) covers each audit.
- **Tests** that find elements by role and label (`getByRole("button", { name: "Like" })`, `getByLabel("Email")`) pass only when the markup is semantic. See [Testing](/testing).
