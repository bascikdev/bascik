# The name Attribute

`name` is a contract with the rest of the page, not a private label. A form field's `name` is the key its value is submitted under, radios that share a `name` are one group, and an `<iframe name>` is a target that links elsewhere on the page point at. Bascik ships every `name` exactly as you write it, so each of these works the way the HTML standard says it does.

`id` and `class` are still scoped per component, so two copies of a component never share an id. `name` is different on purpose: when two copies share a `name`, the browser treats them as one group, and this page shows how to decide whether that is what you want.

## What `name` Is For

The HTML standard defines what `name` means on each element. Everything that reads it lives outside the element itself: the form, the server, another element on the page, or a script.

| Element                                         | What `name` does                                                                                                                                                                                   | Who reads it                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `<input>`, `<select>`, `<textarea>`, `<button>` | [Names the control in form submission](https://html.spec.whatwg.org/dev/form-control-infrastructure.html#naming-form-controls:-the-name-attribute): the key its value is sent under                | The server, `new FormData(form)`, `form.elements.email`          |
| `<input type="radio">`                          | [Forms a radio group](https://html.spec.whatwg.org/multipage/input.html#radio-button-group) with every radio that has the same `name` and the same form owner (or no form owner, in the same tree) | The browser: checking one radio unchecks the others in its group |
| `<fieldset>`, `<output>`, `<object>`            | Names the element in its form's `elements` collection                                                                                                                                              | `form.elements.shipping`                                         |
| `<form>`                                        | Names the form in `document.forms`                                                                                                                                                                 | `document.forms.checkout`                                        |
| `<iframe>`, `<object>`                          | [Names a navigable](https://html.spec.whatwg.org/multipage/document-sequences.html#valid-navigable-target-name), a target for other content                                                        | `<a target>`, `<form target>`, `window.open(url, name)`          |
| `<map>`                                         | [Names an image map](https://html.spec.whatwg.org/multipage/image-maps.html#attr-map-name)                                                                                                         | `<img usemap="#name">`                                           |
| `<details>`                                     | [Groups exclusive accordions](https://html.spec.whatwg.org/multipage/interactive-elements.html#attr-details-name): opening one closes the other `<details>` with that `name`                       | The browser                                                      |
| `<slot>` (in a shadow tree)                     | [Names a slot](https://html.spec.whatwg.org/multipage/scripting.html#attr-slot-name) that light-DOM children with `slot="name"` fill                                                               | The custom element's shadow root                                 |
| `<meta>`                                        | [Names a piece of metadata](https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-name) from a fixed vocabulary (`description`, `viewport`, `robots`)                                    | Browsers, search engines, link previews                          |
| Any element with `name`                         | Found by [`document.getElementsByName()`](https://html.spec.whatwg.org/multipage/dom.html#dom-document-getelementsbyname)                                                                          | Scripts                                                          |

## Naming Form Fields for Submission

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

## Radio Groups per Component Instance

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

### Radios Inside a Larger Form

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

The linter catches the mistake. Without its `<form>`, `froth-picker` holds two radios with one `name` and no form owner:

```html
<!-- src/components/froth-picker/froth-picker.html -->
<fieldset>
  <legend data-bascik-prop-cup>Cup</legend>
  <label>
    <input type="radio" name="froth" value="light" data-testid="froth-light" />
    Light foam
  </label>
  <label>
    <input type="radio" name="froth" value="thick" data-testid="froth-thick" />
    Thick foam
  </label>
</fieldset>
```

Used twice on a page, it gets a `shared-name-group` warning on the first `name`, in the editor and in `bascik --check`:

```text
src/components/froth-picker/froth-picker.html:4:25 - warning: (shared-name-group) name="froth" is on 2 radios with no <form> of their own, and <froth-picker> is used 2 times on src/pages/index.html, so the copies act as one radio group on the page: choosing in one copy clears the others. Wrap the radios in the component's own <form>, or give each copy its own name through a prop: data-bascik-attr-name="group" in place of name here, and data-bascik-prop-group="..." with a different value on each <froth-picker>.
```

## Exclusive `<details>` Accordions

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

### One Accordion per Copy

A component that holds the whole accordion, used twice on one page, makes one accordion of both copies. For a group per copy, bind the name to a prop (`<details data-bascik-attr-name="group">` with no literal `name`, and a different `data-bascik-prop-group` on each usage). The linter warns `shared-name-group` for this case too; when one accordion across the copies is what you want, silence it with `<!-- bascik-ignore shared-name-group -->` on the line above.

## `<iframe>` Targets and Image Maps

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

## Do Not Name a Control After a Form Property

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

## What Bascik Does

- **Every `name` ships as written** by default (`scoping.attributes.name: false`), on every element, at build time and at request time, on Node and on the Cloudflare Worker. `getElementsByName()` in a component script is left alone too.
- **`id` and `class` are still scoped.** `<label for>`, `aria-*` id lists, `form="id"`, and other id references are rewritten together with their ids, so a component's labels and controls keep pointing at their own copy.
- **`data-bascik-attr-name="prop"`** sets `name` per usage from a prop, at build time and in server-script output, for a group per copy.
- **The linter warns `shared-name-group`** when a component used more than once on a page holds a whole radio group outside its own `<form>`, two or more `<details>` with one `name`, or a `<map name>`. See [Linter](/tools/linter#shared-name-group).

### Opting In to Name Scoping

`scoping.attributes.name: true` renames every `name` except `<meta name>` per component instance, the default in Bascik releases before this one:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  scoping: { attributes: { name: true } },
});
```

With it on, each copy's radios and `<details>` are their own group without a `<form>` or a prop, `usemap` follows a `<map name>` in the same component, and `getElementsByName("froth")` in a component script is rewritten to match. Everything that reads a name from outside the component breaks, though: field names a server reads come out as `bascik__froth-picker__a1b2c3d4__froth` and need `data-bascik-preserve="name"` on the form, an `<iframe>` target no longer matches the links that point at it, and a `data-bascik-attr-name` binding is left for the build to render. Turn it on only for a site with many components that each hold a whole radio group or accordion, where opting the few page-wide names out with [`data-bascik-preserve="name"`](/preserve) is less work than a form or a prop per component. The linter then checks forms that post to another site for `data-bascik-preserve="name"` (`external-form-missing-preserve-name`) and stops reporting `shared-name-group`.
