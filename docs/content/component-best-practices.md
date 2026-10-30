# Component Best Practices

Bascik ships the markup a component holds, element for element and attribute for attribute. Two habits follow from that: pick the element the HTML standard defines for each job, and treat `name` as the page-level contract it is. Both use what the browser already does, so a component needs less script, less ARIA, and no surprises when it is used twice on one page.

## Use HTML's Elements

Bascik is built on web standards: HTML, CSS, and JavaScript as browsers ship them, with no runtime in between. Semantic HTML is the same idea applied to your markup. Pick the element the [HTML standard](https://html.spec.whatwg.org/multipage/) defines for the job, and browsers, search engines, AI agents, and screen readers already know what it means.

Bascik ships the code you wrote. A component tag is replaced by its template, and the elements in that template are the elements visitors get. Bascik never adds a wrapper, never turns a `<nav>` into a `<div>`, and never turns a `<div>` into a `<nav>`. The choice of element is yours, and Bascik keeps it.

### Tag Names Never Reach the Browser

`<site-nav>` and `<faq-item>` exist only in your source. At build time each one is replaced by its template, so the browser, search engines, and screen readers never see the tag name. A component tag does not have to be a semantic element, and it cannot be one: what visitors get is the root element and the markup inside it. That markup is where the HTML standard's elements belong.

Still name a component after what it is. `<site-nav>`, `<product-card>`, and `<faq-item>` read like the page they build, so a page made of components reads almost like an outline. `<blue-box>` or `<wrapper-2>` says nothing. A good name often echoes its root element: `<site-nav>` has a `<nav>` root, and `<faq-item>` has a `<details>` root. The name is for the people reading your code, and the root element is for everyone else.

### Why It Matters

- **Accessibility comes with it.** A `<button>` is focusable, works with Enter and Space, and is announced as a button. A `<nav>` is a landmark a screen reader lists and jumps to. You get this from the element, with no ARIA and no script.
- **Less JavaScript.** `<details>`, `<dialog>`, the `popover` attribute, and form validation are built into the browser. A component that uses them needs no script at all.
- **Machines read structure.** Search engines and [AI agents](/lighthouse/agentic-browsing) read headings, landmarks, lists, and tables to understand a page.
- **It is easier to change.** A `<footer>` says what it is. A `<div class="ft-wrap">` needs a comment.

### Components Keep Their Semantics

A component's root element is the element that replaces its tag, and attributes on the usage tag (`class`, `aria-label`, `id`) land on it through [attribute inheritance](/attribute-inheritance). A `class` is appended to the root's own, and a `data-testid` on the usage tag replaces the root's, but any other attribute already on the root wins over the same attribute on the usage tag. So leave a label off the component's root and pass it where the component is used, as the demos below do. Make the root the element for the component's job, not a wrapper `<div>` around it.

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

#### Bad: A Wrapper Div

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

#### Good: The Root Is the Nav

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

### Buttons for Actions, Links for Navigation

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

### Native Elements Before ARIA or JavaScript

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

### Checklist

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

### Check It

Bascik guides and warns. It never rewrites or rejects your markup, so these checks are suggestions you can weigh.

- **The `bascik` agent skill's `audit-components.mjs`** warns about a clickable `<div>` or `<span>`, a component whose root is a `<div>` when its name says it is a nav, header, footer, form, post, review, or section, a skipped heading level in a page's output (it follows headings through components and slots), an `<img>` with no `alt`, a form control with no label, and a page with no `<main>` (rules `clickable-element`, `generic-root`, `skipped-heading`, `missing-alt`, `unlabeled-control`, and `missing-main`). Each warning names `file:line` and the fix. See [Agent Skills](/agent-skills).
- **The `bascik-seo` skill's audit** checks `lang`, one `<h1>` per page, and image `alt` in the built `dist/`.
- **Lighthouse** scores accessibility on the built page. [Accessibility](/lighthouse/accessibility) covers each audit.
- **Tests** that find elements by role and label (`getByRole("button", { name: "Like" })`, `getByLabel("Email")`) pass only when the markup is semantic. See [Testing](/testing).

## Name Form Controls and Groups

`name` is a contract with the rest of the page, not a private label. A form field's `name` is the key its value is submitted under, radios that share a `name` are one group, and an `<iframe name>` is a target that links elsewhere on the page point at. Bascik ships every `name` exactly as you write it, so each of these works the way the HTML standard says it does. `id` and `class` are still [scoped per component](/scoped-styles), so two copies of a component never share an id; `name` is different on purpose, because when two copies share a `name` the browser treats them as one group. The sections below show how to decide whether that is what you want.

### What `name` Is For

Everything that reads a `name` lives outside the element itself: the form, the server, another element on the page, or a script.

| Element                                         | What `name` does                                                                                                                                                                                   | Who reads it                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<input>`, `<select>`, `<textarea>`, `<button>` | [Names the control in form submission](https://html.spec.whatwg.org/dev/form-control-infrastructure.html#naming-form-controls:-the-name-attribute): the key its value is sent under                | The server, `new FormData(form)`, `form.elements.email`          |
| `<input type="radio">`                          | [Forms a radio group](https://html.spec.whatwg.org/multipage/input.html#radio-button-group) with every radio that has the same `name` and the same form owner (or no form owner, in the same tree) | The browser: checking one radio unchecks the others in its group |
| `<fieldset>`, `<output>`, `<object>`            | Names the element in its form's `elements` collection                                                                                                                                              | `form.elements.shipping`                                         |
| `<form>`                                        | Names the form in `document.forms`                                                                                                                                                                 | `document.forms.checkout`                                        |
| `<iframe>`, `<object>`                          | [Names a navigable](https://html.spec.whatwg.org/multipage/document-sequences.html#valid-navigable-target-name), a target for other content                                                        | `<a target>`, `<form target>`, `window.open(url, name)`          |
| `<map>`                                         | [Names an image map](https://html.spec.whatwg.org/multipage/image-maps.html#attr-map-name)                                                                                                         | `<img usemap="#name">`                                           |
| `<details>`                                     | [Groups exclusive accordions](https://html.spec.whatwg.org/multipage/interactive-elements.html#attr-details-name): opening one closes the other `<details>` with that `name`                       | The browser                                                      |
| `<meta>`                                        | [Names a piece of metadata](https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-name) from a fixed vocabulary (`description`, `viewport`, `robots`)                                    | Browsers, search engines, link previews                          |
| Any element with `name`                         | Found by [`document.getElementsByName()`](https://html.spec.whatwg.org/multipage/dom.html#dom-document-getelementsbyname)                                                                          | Scripts                                                          |

### Naming Form Fields for Submission

Write the field names your server reads. A plain form post works with or without JavaScript, and the names arrive exactly as written:

```html
<!-- src/components/newsletter-signup/newsletter-signup.html -->
<form action="/api/subscribe" method="post" data-testid="newsletter-signup">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />
  <button type="submit">Get frother tips</button>
</form>
```

```ts
// src/api/subscribe.ts
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = form.get("email");
  if (typeof email !== "string" || !email.includes("@"))
    return new Response("Enter an email address.", { status: 422 });
  return Response.redirect(new URL("/?subscribed=1", request.url), 303);
}
```

`label for="email"` and `id="email"` are scoped together per instance, so two signups on one page still label their own inputs. `name="email"` stays `email`, so `new FormData(form)` in a component script, a fetch that sends it, and a form service on another domain all see the same key. The [Contact Form](/example-components/contact-form) example posts this way to an API route.

### Radio Groups per Component Instance

Radios are one group when they share a `name` and a form owner. A radio outside any `<form>` has no form owner, so radios with one `name` and no form are one group across the whole page, whichever component they came from. A component that holds a whole radio group needs a `<form>` of its own so each copy on a page is its own group. The form does not have to submit anywhere; it gives the radios their own owner.

Here the same `froth-picker` appears twice. Each copy wraps its radios in a `<form>`, so choosing thick foam for the evening cup leaves the morning cup's choice alone:

<!-- demo:name-radio-usage -->

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother</title>
  </head>
  <body>
    <froth-picker data-bascik-prop-cup="Morning cup" />
    <froth-picker data-bascik-prop-cup="Evening cup" />
  </body>
</html>
```

<!-- demo:name-radio-source-html -->

```html
<!-- src/components/froth-picker/froth-picker.html -->
<form data-testid="froth-picker">
  <fieldset>
    <legend data-bascik-prop-cup>Cup</legend>
    <label>
      <input
        type="radio"
        name="froth"
        value="light"
        data-testid="froth-light"
      />
      Light foam
    </label>
    <label>
      <input
        type="radio"
        name="froth"
        value="thick"
        data-testid="froth-thick"
      />
      Thick foam
    </label>
  </fieldset>
</form>
```

<!-- demo:name-radio-output-html -->

```html
<!-- src/components/froth-picker/froth-picker.html -->
<form data-testid="froth-picker">
  <fieldset>
    <legend>Morning cup</legend>
    <label>
      <input
        type="radio"
        name="froth"
        value="light"
        data-testid="froth-light"
      />
      Light foam
    </label>
    <label>
      <input
        type="radio"
        name="froth"
        value="thick"
        data-testid="froth-thick"
      />
      Thick foam
    </label>
  </fieldset>
</form>

<!-- src/components/froth-picker/froth-picker.html -->
<form data-testid="froth-picker">
  <fieldset>
    <legend>Evening cup</legend>
    <label>
      <input
        type="radio"
        name="froth"
        value="light"
        data-testid="froth-light"
      />
      Light foam
    </label>
    <label>
      <input
        type="radio"
        name="froth"
        value="thick"
        data-testid="froth-thick"
      />
      Thick foam
    </label>
  </fieldset>
</form>
```

#### Radios Inside a Larger Form

When the radios already sit inside a larger form, such as a checkout with one size per line item, a `<form>` per copy is not an option: forms cannot nest. Give each copy its own name through a prop instead. Bind `name` with `data-bascik-attr-name` and leave out the literal `name`:

```html
<!-- src/components/froth-picker/froth-picker.html -->
<fieldset>
  <legend data-bascik-prop-cup>Cup</legend>
  <label>
    <input type="radio" data-bascik-attr-name="group" value="light" />
    Light foam
  </label>
  <label>
    <input type="radio" data-bascik-attr-name="group" value="thick" />
    Thick foam
  </label>
</fieldset>
```

```html
<!-- src/pages/order.html, inside <form action="/api/order" method="post"> -->
<froth-picker
  data-bascik-prop-cup="Morning cup"
  data-bascik-prop-group="morning-froth"
/>
<froth-picker
  data-bascik-prop-cup="Evening cup"
  data-bascik-prop-group="evening-froth"
/>
```

The server then receives `morning-froth=light&evening-froth=thick`, one key per cup. One radio per component, such as a `size-option` used three times to build one group, is the opposite case: there the shared `name` is what makes the copies one group.

The linter catches the mistake. A `froth-picker` with a literal `name="froth"` on both radios and no `<form>` of its own, used twice on a page, gets a `shared-name-group` warning on the first `name`, in the editor and in `bascik --check`:

```text
src/components/froth-picker/froth-picker.html:4:25 - warning: (shared-name-group) name="froth" is on 2 radios with no <form> of their own, and <froth-picker> is used 2 times on src/pages/index.html, so the copies act as one radio group on the page: choosing in one copy clears the others. Wrap the radios in the component's own <form>, or give each copy its own name through a prop: data-bascik-attr-name="group" in place of name here, and data-bascik-prop-group="..." with a different value on each <froth-picker>.
```

### Exclusive `<details>` Accordions

`<details name="faq">` makes every `<details>` on the page with that `name` one exclusive accordion: opening one closes the one that was open. Because `name` ships as written, an accordion can be built from one component per item. Open one question and the open one closes, though each comes from a separate `frother-question`:

<!-- demo:name-details-usage -->

```html
<!-- src/pages/faq.html -->
<!doctype html>
<html lang="en">
  <head>
    <title>Milk frother FAQ</title>
  </head>
  <body>
    <frother-question>
      <span data-bascik-slot="question">Which milk froths best?</span>
      Cold whole milk gives the thickest foam.
    </frother-question>
    <frother-question>
      <span data-bascik-slot="question">Can it froth oat milk?</span>
      Yes. Use a barista blend for a finer foam.
    </frother-question>
    <frother-question>
      <span data-bascik-slot="question">How do I clean the whisk?</span>
      Rinse it under warm water right after use.
    </frother-question>
  </body>
</html>
```

<!-- demo:name-details-source-html -->

```html
<!-- src/components/frother-question/frother-question.html -->
<details name="faq" data-testid="frother-question">
  <summary data-testid="frother-question-summary">
    <span data-bascik-slot="question"></span>
  </summary>
  <p data-bascik-slot></p>
</details>
```

<!-- demo:name-details-output-html -->

```html
<!-- src/components/frother-question/frother-question.html -->
<details name="faq" data-testid="frother-question">
  <summary data-testid="frother-question-summary">
    Which milk froths best?
  </summary>
  Cold whole milk gives the thickest foam.
</details>

<!-- src/components/frother-question/frother-question.html -->
<details name="faq" data-testid="frother-question">
  <summary data-testid="frother-question-summary">
    Can it froth oat milk?
  </summary>
  Yes. Use a barista blend for a finer foam.
</details>

<!-- src/components/frother-question/frother-question.html -->
<details name="faq" data-testid="frother-question">
  <summary data-testid="frother-question-summary">
    How do I clean the whisk?
  </summary>
  Rinse it under warm water right after use.
</details>
```

#### One Accordion per Copy

A component that holds the whole accordion, used twice on one page, makes one accordion of both copies. For a group per copy, bind the name to a prop (`<details data-bascik-attr-name="group">` with no literal `name`, and a different `data-bascik-prop-group` on each usage). The linter warns `shared-name-group` for this case too; when one accordion across the copies is what you want, silence it with `<!-- bascik-ignore shared-name-group -->` on the line above.

### `<iframe>` Targets and Image Maps

An `<iframe name="manual">` is a target: `<a href="/manual/descaling" target="manual">` anywhere on the page loads into it, and so does a form with `target="manual"`. Because the name ships as written, links in other components and in the page shell reach it.

```html
<!-- src/components/manual-viewer/manual-viewer.html -->
<iframe
  name="manual"
  src="/manual/"
  title="Milk frother manual"
  data-testid="manual-viewer"
></iframe>
```

```html
<!-- src/pages/support.html -->
<nav>
  <a href="/manual/descaling" target="manual">Descaling</a>
  <a href="/manual/whisk" target="manual">Replacing the whisk</a>
</nav>
<manual-viewer></manual-viewer>
```

Two copies of `manual-viewer` would be two targets with one name, and a link loads into the first. `usemap="#parts"` works the same way: it uses the first `<map name="parts">` in the page, so a component with a `<map>` used twice gets a `shared-name-group` warning. Give each copy its own names through props (`data-bascik-attr-name` on the `<map>`, `data-bascik-attr-usemap` on the `<img>`), or move the map into the page.

### Do Not Name a Control After a Form Property

A form exposes its named controls as properties, and a named control wins over the form's own property of the same name. This is DOM clobbering, and it breaks code that reads the form:

```html
<form id="order" action="/api/order" method="post">
  <input name="action" value="reorder" />
  <button name="submit">Order</button>
</form>
<script>
  const order = document.getElementById("order");
  order.action; // the <input>, not "/api/order"
  order.submit(); // TypeError: order.submit is not a function
</script>
```

Do not name a control `action`, `method`, `target`, `submit`, `reset`, `requestSubmit`, `elements`, `length`, `name`, `id`, `className`, or any other property or method of `HTMLFormElement`. Choose names that describe the data: `intent` instead of `action`, `delivery` instead of `method`. The same applies to `<form name>`, `<img name>`, `<iframe name>`, and `<object name>`, which also become properties of `document`: a form named `cookie` or `title` hides `document.cookie` or `document.title` from scripts on the page. Bascik never renames `name`, so it never hides a clobbered name from you either: the name in your source is the name on the page.

### What Bascik Does

- **Every `name` ships as written** by default (`scoping.attributes.name: false`), on every element, at build time and at request time, on Node and on the Cloudflare Worker. `getElementsByName()` in a component script is left alone too.
- **`id` and `class` are still scoped.** `<label for>`, `aria-*` id lists, `form="id"`, and other id references are rewritten together with their ids, so a component's labels and controls keep pointing at their own copy.
- **`data-bascik-attr-name="prop"`** sets `name` per usage from a prop, at build time and in server-script output, for a group per copy.
- **The linter warns `shared-name-group`** when a component used more than once on a page holds a whole radio group outside its own `<form>`, two or more `<details>` with one `name`, or a `<map name>`. See [Linter](/tools/linter#shared-name-group).

- **Name scoping is an opt-in.** [`scoping.attributes.name: true`](/configuration#scopingattributesname) renames every `name` except `<meta name>` per component instance, the default in earlier Bascik releases. Each copy's radios and `<details>` are then their own group without a `<form>` or a prop, but everything that reads a name from outside the component breaks: field names a server reads come out as `bascik__froth-picker__a1b2c3d4__froth` and need [`data-bascik-preserve="name"`](/preserve) on the form, and an `<iframe>` target no longer matches the links that point at it. Turn it on only for a site with many components that each hold a whole radio group or accordion, where opting the few page-wide names out is less work than a form or a prop per component. The linter then checks forms that post to another site for `data-bascik-preserve="name"` (`external-form-missing-preserve-name`) and stops reporting `shared-name-group`.
