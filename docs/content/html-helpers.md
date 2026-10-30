# HTML Helpers

`@bascik/bascik/html` is a small module of plain functions for building HTML safely in server, stream and build scripts. You import each function and call it; nothing is injected and nothing runs on its own. Each function returns a value you can return from a script. See [Security](/security) for why it exists and how it fits with the rest of a site's protection.

## Import

```js
import { html, raw, esc, safeUrl, json } from "@bascik/bascik/html";
```

The module has no Node builtins, so the same import works in a script on the dev server, `bascik --server` and Cloudflare Workers, and in a shared helper under your import root.

## html

```js
html`<p>Hello, ${name}</p>`;
```

A tagged template with contextual escaping. The first time a template runs, `html` reads its static parts and records where each `${...}` hole lands: text, a quoted attribute, a URL, or the body of a JSON script. Each value is then escaped for its place. Places escaping cannot make safe throw an [`HtmlError`](#htmlerror) on every call, whatever the values, so a test of the page finds them.

It returns a `SafeHtml` value. Nested inside another `html` template, it is inserted as it is. It is an object, not a string: `typeof` gives `"object"` and it has no string methods such as `includes` or `replace`. It turns into the HTML string where JavaScript converts a value to a string (`String(value)`, a plain `${value}`, `JSON.stringify`), and every host accepts it as a script's return value. Call `String(value)` before you treat it as text, for example in a test:

```js
const output = await handler(new Request("https://example.com/?q=kettle"));
expect(String(output)).toContain("kettle");
```

In TypeScript, a helper that returns `html` declares `SafeHtml`, not `string`:

```ts
// src/lib/card.ts
import { html, type SafeHtml } from "@bascik/bascik/html";

export function card(product: { name: string; price: string }): SafeHtml {
  return html`<product-card
    data-bascik-prop-name="${product.name}"
    data-bascik-prop-price="${product.price}"
  ></product-card>`;
}
```

## Where a value lands

| Context                                                              | Example                                                       | What `html` does                                                                                    |
| :------------------------------------------------------------------- | :------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| Text, including inside component tags and `<template>`               | `<p>${q}</p>`                                                 | Escapes `& < > " '`; nested `html` values and arrays are inserted as they are                       |
| `<textarea>`, `<title>`                                              | `<title>${title}</title>`                                     | Escapes; refuses an `html` value (they hold text only)                                              |
| `<noscript>`, `<xmp>`, `<iframe>`, `<noembed>`, `<noframes>` content | `<noscript>${note}</noscript>`                                | Escapes; a hole inside a tag there is also checked as that tag's attribute                          |
| Quoted attribute, any name not listed below                          | `<a title="${t}">`, `data-bascik-prop-name="${n}"`            | Escapes; refuses an `html` value or an array                                                        |
| URL attribute, hole at the URL start                                 | `<a href="${url}">`, `<img src="${src}">`, `<form action>`    | script URLs such as `javascript:`, and non-image `data:` URLs, become `about:invalid`, then escapes |
| URL attribute after a static prefix that settles the scheme          | `href="/u/${id}"`, `href="https://x.example/${p}"`, `?q=${q}` | Escapes                                                                                             |
| URL lists                                                            | `srcset`, `imagesrcset`, `ping`, SVG animation `values`       | Checks every entry; a blocked entry makes the hole `about:invalid`; then escapes                    |
| JSON script, the hole as its only content                            | `<script type="application/json">${json(data)}</script>`      | Inserts `json(value)` output as it is; refuses anything else                                        |
| Unquoted attribute value                                             | `class=${c}`                                                  | Throws `unquoted-attribute`                                                                         |
| Event handler                                                        | `onclick="${x}"`                                              | Throws `event-handler`                                                                              |
| `style` attribute, `srcdoc`, `<meta http-equiv>`                     | `style="${s}"`                                                | Throws `style-attribute`, `srcdoc`, `meta-http-equiv`                                               |
| `<script>` or `<style>` body, also inside `<svg>` or `<math>`        | `<script>${x}</script>`                                       | Throws `script-body`, `style-body`                                                                  |
| Tag or attribute name                                                | `<${tag}>`, `<input ${attr}>`                                 | Throws `tag-name`, `attribute-name`                                                                 |
| Comment, `<!DOCTYPE>`, CDATA                                         | `<!-- ${x} -->`                                               | Throws `comment`                                                                                    |

URL attributes are `href`, `xlink:href`, `src`, `action`, `formaction`, `poster`, `background`, `cite`, `codebase`, `longdesc`, `lowsrc`, `dynsrc`, `manifest`, `icon`, and `data` on `<object>`, on any element. Image slots (`<img src>`, `<img srcset>`, `<source srcset>`, `<video poster>`, `<input src>`, `<link imagesrcset>`) keep `data:image/*` URLs. Any `http:` or `https:` URL, another site's included, is kept, as the browser takes it; see [Loading scripts and styles from other sites](/security#loading-scripts-and-styles-from-other-sites). This is the same rule Bascik applies to props bound to URL attributes.

`html` follows the browser's tokenizer exactly where code, comments and tag structure are concerned, and refuses wherever it cannot. Where parsers differ, it reads the template every way a browser might and keeps the strictest result. The content of `<noscript>` is inert text in a page, but `template.innerHTML`, `DOMParser` and libraries that swap HTML into a page (htmx, Turbo) parse with scripting off and read it as markup, so a hole in `<noscript><img onerror="${x}">` is refused like one outside. An html`...` or `raw()` value nested in one of these elements is inserted as markup (an `<img>` in `<noscript>` is the scripting-off fallback), but one that contains the element's own end tag, such as `</noscript` inside an attribute, is refused: the browser would end the element there and read the rest of the value as markup that `html` checked as attribute text. Inside `<svg>` and `<math>`, the content of `<script>`, `<style>`, `<title>` and the elements above is markup, and `html` reads it that way. The same goes for `<plaintext>`: a fragment nested in `<svg>`, or a `<select>` in an older parser, reads what follows it as markup, so holes after it are checked as markup too. An `</svg>` or `</math>` end tag closes the element only where the browser's tree builder would: with an HTML element still open inside it (in `<foreignObject>` or `<mtext>`, for example), the browser ignores the end tag and stays in SVG or MathML, and so does `html`. A template must also end outside every tag, comment, `<script>`, `<style>`, `<textarea>`, `<title>`, `<svg>` and `<math>`, so a fragment can never open a context in the template it is nested in. An ordinary unclosed element such as `<div>` is fine.

## Values

| Value                                | In text                                | In an attribute                     |
| :----------------------------------- | :------------------------------------- | :---------------------------------- |
| string                               | Escaped                                | Escaped (URL checked in a URL slot) |
| number, bigint, `true`               | `String(value)`                        | `String(value)`                     |
| `null`, `undefined`, `false`         | Nothing                                | Empty (the attribute stays present) |
| `html` or `raw()` value              | Inserted as it is                      | Throws `markup-in-attribute`        |
| Array (up to 1000 levels deep)       | Each item by these rules, no separator | Throws `array-in-attribute`         |
| `json()` value                       | Escaped as a string                    | Escaped as a string                 |
| Promise or thenable                  | Throws `promise`                       | Throws `promise`                    |
| Any other object (a `Date`, a class) | `String(value)`, escaped               | `String(value)`, escaped            |

An array nested deeper than 1000 levels, or one that contains itself, throws `array-depth`. An object that `String(value)` cannot convert, such as `{ "toString": "x" }` from a JSON body or a null-prototype object from a query-string parser, throws `unconvertible-value`. Check that visitor fields are strings before you use them.

## Boolean attributes

`checked`, `selected`, `disabled`, `hidden`, `required` and other boolean attributes are on whenever they are present, whatever their value. `checked="${isChecked}"` with `false` renders `checked=""`, and the box is checked. A hole cannot add or remove an attribute either: `<option ${selected ? "selected" : ""}>` throws `attribute-name`. Write the attribute in the template and choose in code:

```js
const option = (value, label, selected) =>
  selected
    ? html`<option value="${value}" selected>${label}</option>`
    : html`<option value="${value}">${label}</option>`;

return html`<select name="size">
  ${sizes.map((s) => option(s.value, s.label, s.value === current))}
</select>`;
```

For an element with many attributes, put the attributes that change in one small helper like this, so the tag is written twice in one place. `aria-*` attributes such as `aria-pressed` and `aria-expanded` are different: they take the text `"true"` or `"false"`, so pass `String(value)`.

## Nesting and .map

Because an array of `html` values is inserted with no separator, `.map` needs no `.join("")`:

```js
return html`<ul>
  ${items.map((item) => html`<li>${item.name}</li>`)}
</ul>`;
```

Keep `html` at every level. Joining fragments with `+` or `.join("")` makes a plain string, and a plain string in an outer `html` is escaped. A shared helper in `src/lib/` can return `html` values, and fragments from two copies of the module (a monorepo duplicate, a Worker bundle) nest too: the brand is a registered symbol. Data from JSON, a query string, headers or `structuredClone` can never carry it, so a visitor cannot forge an `html` value. `raw()` is the only intended way to make one from a string.

A script that returns an array of fragments without wrapping it prints commas between them, because an array becomes a string with `String(array)`. Return `` html`${items}` `` instead.

## raw

```js
raw(sanitizedHtml);
```

Marks a string of trusted HTML, such as sanitized CMS or Markdown output, so `html` inserts it as it is. `null` and `undefined` give empty HTML, a number gives its digits, and an `html` value is returned unchanged. It takes one string: called as a tag, with an array or a plain object, or with a Promise, it throws a `TypeError`. Sanitize with an allowlist before you call it; see [CMS and Markdown content](/security#cms-and-markdown-content).

## esc

```js
esc(value); // "&lt;b&gt;"
```

Returns `value` as an entity-escaped string for text or a quoted attribute, for code that builds strings without `html`. `null`, `undefined` and `false` give `""`. Inside `html` it escapes twice, so the page shows `&amp;lt;`; the linter reports that as `html-escaped-twice`.

## safeUrl

```js
safeUrl(value);
safeUrl(value, "https://example.com/"); // base as the second argument
safeUrl(value, { base, origins, image: true });
```

Returns the URL when it cannot run script, and `about:invalid` otherwise or when `value` is not a string. It never escapes: put the result in `html` or `esc` it.

- `base` resolves the URL against a base and returns the absolute URL (`new URL(value, base).href`).
- `origins` lists the origins you accept, each written as `scheme://host[:port]`. A same-site relative path passes; an absolute or `//host` URL must match one origin exactly (look-alike hosts and `user@host` tricks do not); a `//host` URL without a `base` is blocked. With a `base`, the base's own origin is accepted too.
- `image: true` keeps `data:image/*` URLs, for an image slot.

An `origins` entry that is not an origin throws a `TypeError` naming it, for example `safeUrl: origins[1] "cdn.example.com" is not an origin. Write it as https://cdn.example.com.`

## json

```js
html`<script type="application/json" id="data">
  ${json(data)}
</script>`;
```

Returns `JSON.stringify(value)` with `<`, `>`, `&`, U+2028 and U+2029 written as the JSON escapes `\u003c`, `\u003e`, `\u0026`, `\u2028` and `\u2029`, so the text cannot end the script and still parses to the same value. For example, `json({ a: "</script>&" })` returns `{"a":"\u003c/script\u003e\u0026"}`. `undefined` becomes `null`. Errors from `JSON.stringify` (a cycle, a BigInt) are thrown. Inside an inline server script, write the returned script's end tag as `<\/script>`.

## isHtml

```js
isHtml(value); // true for an html or raw value
```

Tells whether a value came from `html` or `raw`, from this copy of the module or another.

## HtmlError

Thrown where a value cannot be made safe. `error.code` is one of the codes below, `error.hole` is the 1-based hole number (0 for a problem with the whole template), and `error.template` is the template's static text with each hole shown as `${…}`, cut to about 80 characters around the hole. The message starts with the same facts, and the throw happens inside your call, so Bascik's script error report adds the file and line. Like any server script error, it is written to the terminal that runs `bascik` or `bascik --server` (and to the Worker's log on Cloudflare); the browser gets a plain `500 Internal Server Error` page, so look in the terminal. Each message has an entry in [Troubleshooting](/testing/troubleshooting#server-script-safety).

## Errors

Refused when the template is first read, on every call. Each message starts with `html: hole N in html` and the template, then:

| Code                       | Message after the location                                                                                                                                                                                                                    |
| :------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unquoted-attribute`       | `is an unquoted attribute value (class). A space in the value would start a new attribute. Quote it: class="${…}".`                                                                                                                           |
| `event-handler`            | `is inside the onclick attribute. An event handler's value is JavaScript, which escaping cannot make safe. Put the value in a data-* attribute and read it from a component script.`                                                          |
| `style-attribute`          | `is inside a style attribute. CSS can load URLs and change the page, and escaping does not make it safe. Choose between fixed classes in code, or put the value in a data-* attribute.`                                                       |
| `script-body`              | `is inside a <script> element. Escaping HTML does not make JavaScript safe. Put the value in a data-* attribute, or in <script type="application/json">${json(value)}</script>.`                                                              |
| `style-body`               | `is inside a <style> element. Escaping HTML does not make CSS safe. Choose between fixed classes in code.`                                                                                                                                    |
| `tag-name`                 | ``is a tag name. A value never chooses which element to write. Choose between fixed html`...` fragments in code.``                                                                                                                            |
| `attribute-name`           | ``is where an attribute name goes, inside <input>. A value never chooses which attributes an element has. Write the attribute in the template with a quoted value, or choose between fixed html`...` fragments in code.``                     |
| `comment`                  | `is inside an HTML comment (or a <!...> declaration). Move the value out of the comment.`                                                                                                                                                     |
| `srcdoc`                   | `is inside srcdoc, an HTML document that runs with the page's origin. Set src to a URL instead.`                                                                                                                                              |
| `meta-http-equiv`          | `is a <meta http-equiv> value, which acts on the page (a redirect, a policy). Write it in the template.`                                                                                                                                      |
| `svg-animation-attribute`  | `chooses which attribute an SVG animation sets. Write attributeName in the template.`                                                                                                                                                         |
| `url-scheme-split`         | `continues the URL's scheme from the template text "java", so the value could complete javascript:. Start the attribute with the value (href="${…}"), or write the scheme and the first / in the template (href="https://example.com/${…}").` |
| `url-scheme-split`         | `is followed by the template text ":8080" before the URL's first /, ? or #, so together they could form a scheme such as javascript:. Build the URL in code (for example with safeUrl) and use one hole: href="${…}".`                        |
| `url-scheme-split`         | `is followed directly by another hole in the href URL, so together the values could form a scheme such as javascript:. Build the URL in code (for example with safeUrl) and use one hole: href="${…}".`                                       |
| `script-url`               | `is inside a javascript: URL, which runs as script. Use a real URL and handle the click in a component script.`                                                                                                                               |
| `script-comment-ambiguous` | `follows a <script> whose text contains <!--, which changes where the browser ends the script, so html cannot tell where hole 1 lands. Remove <!-- from the script.`                                                                          |

Two refusals are about the whole template (`error.hole` is 0). Their message starts with ``html: the template html`...` `` instead:

| Code                       | Message after the template                                                                                                                                                                                         |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unterminated`             | ``ends inside the href attribute of <a> (the quote is not closed). An html`...` fragment must end outside any tag, comment, <script>, <style>, <textarea>, <title>, <svg> or <math>, so it can be nested safely.`` |
| `script-comment-ambiguous` | `has a <script> whose text contains <!--, which changes where the browser ends it, so the fragment cannot be nested safely. Remove <!-- from the script.`                                                          |

The `unterminated` message names where the template ends: inside an attribute, a tag (`the > is missing`), a comment, an element such as `<title>` (`the </title> end tag is missing`), or `<svg>` and `<math>`.

Refused when a value arrives:

| Code                  | Message                                                                                                                                                                                                                                                                                                                |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promise`             | `received a Promise. Await the value before putting it in the template.`                                                                                                                                                                                                                                               |
| `markup-in-attribute` | ``(the title attribute) received an html`...` or raw() value. An attribute holds text; pass a string, which html escapes.``                                                                                                                                                                                            |
| `array-in-attribute`  | `(the class attribute) received an array. An attribute holds one text value; join it in code, for example ${classes.join(" ")}.`                                                                                                                                                                                       |
| `markup-in-text-only` | ``received an html`...` or raw() value, but <title> holds text only. Pass a string.``                                                                                                                                                                                                                                  |
| `json-script-value`   | `received a string. Only json(value) can fill this script, so the data cannot end it early.`                                                                                                                                                                                                                           |
| `foreign-content`     | ``received an html`...` value with a <script> or <style> whose text contains <, inside <svg> or <math>. There the browser reads that text as markup, so the element can end somewhere else. Move the fragment out of the <svg> or <math>, or remove < from its script or style.``                                      |
| `unconvertible-value` | `received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError). Data from JSON or a query string can hold an object where a string was expected: check that the value is a string before you use it.`                                                                 |
| `array-depth`         | `received an array nested more than 1000 levels deep, or an array that contains itself. Flatten the data in code before you put it in the template.`                                                                                                                                                                   |
| `raw-text-end`        | ``received an html`...` or raw() value that contains </noscript, which ends the <noscript> early. The browser would read the rest of the value as markup that html did not check, so its holes could land in an href or an event handler. Remove </noscript from the value, or put the value outside the <noscript>.`` |

`TypeError`s for misuse:

- ``html is a tagged template: write html`<p>${value}</p>`, not html(...). To insert trusted markup, use raw(value).``
- ``raw() takes a string of trusted HTML, not a template. Use html`...` for templates.``
- ``raw() takes one string of trusted HTML; received an array. Map each item to html`...` or raw(item).``
- `raw() received a Promise. Await the value first.`
- `safeUrl: origins[1] "cdn.example.com" is not an origin. Write it as https://cdn.example.com.`
- `esc() received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError). Check that the value is a string before you use it.`

## Performance

`html` reads each template's static parts once, on its first call, and caches what it found per call site. Every later call is a loop over the holes. On a list of 1,000 product cards with four holes each, nested with `.map` (`pkg/bench/html.bench.ts`, Node 24, Apple silicon):

| Variant                                       | Renders per second | Relative |
| :-------------------------------------------- | -----------------: | -------: |
| Plain template literal, no escaping (unsafe)  |             10,394 |    1.00x |
| Plain template literal with `esc()` per value |              2,266 |    4.59x |
| `html`                                        |              2,024 |    5.14x |

`html` costs about 1.12x the hand-escaped version, and almost all of the difference from the unsafe floor is the escaping itself. Run `yarn pkg:bench html` to measure on your machine.

## Compatibility

- Node.js 22.22 and later, and Cloudflare Workers: the module uses only `String`, `RegExp`, `URL`, `JSON`, `WeakMap` and `Symbol.for`, with no Node builtins.
- On Cloudflare the adapter bundles the import into the Worker; on Node it resolves through the package's `./html` export.
- About 21 KB minified and under 9 KB gzipped, most of it the error messages and the readings for parser differences.
- Build scripts may return an `html` value too, so a card helper can be shared between build-time and request-time pages.
