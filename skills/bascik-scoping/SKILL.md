---
name: bascik-scoping
description: How Bascik scopes component CSS and JavaScript at build time. Use when writing or debugging a Bascik component's <style>, companion .css, or <script> code; when choosing between id and class selectors in component scripts; when a component works once but breaks with multiple instances; when compiled class or ID names look wrong; or when configuring deduplicateCss, preserve, data-bascik-preserve, Tailwind, or browser TypeScript.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Bascik Scoping

Bascik isolates every component at build time by renaming what the component declares and rewriting the strings that refer to it. You write a component as if it were the only one on the page. This skill explains what gets renamed, what does not, and which patterns break.

Requires the `bascik` skill for project basics and its `scripts/preview.mjs` for checking real output.

## The naming scheme

```text
class  ->  bascik__<component>__<name>                  shared by every instance
id     ->  bascik__<component>__<instance>__<name>      unique per instance
name   ->  bascik__<component>__<instance>__<name>      unique per instance
element selector p  ->  .bascik__<component>__el__p     class injected on template elements
@keyframes fade     ->  bascik__<component>__keyframe__fade
--brand (declared locally) -> --bascik__<component>__brand
```

Production builds (`minify.identifiers`, on by default for `--build`) shorten these to hashes. Never hard-code a scoped name anywhere.

## Script rules (must follow)

1. **Find per-instance elements with `id`.** `document.getElementById('btn')` is rewritten to that instance's ID, so every copy of the component controls its own elements.
2. **Never use a class selector to find a per-instance element.** Classes are shared across instances, so `document.querySelector('.btn')` returns the first instance on the page, and the other instances look dead.
3. **For compound queries, start from an `id`.** `document.getElementById('list').querySelectorAll('li')` stays inside the instance.
4. **Keep class names static.** `classList.add('is-open')` is discovered and rewritten. A template literal (`` el.className = `box ${state}` ``) is not.
5. **Use `data-` attributes for runtime state.** `el.dataset.state = 'open'` with CSS `.panel[data-state="open"]` needs no rewriting.

```html
<!-- Broken with two instances -->
<button class="toggle">Open</button>
<script>
  document.querySelector('.toggle').addEventListener('click', () => {});
</script>

<!-- Correct -->
<button class="toggle" id="toggle">Open</button>
<script>
  document.getElementById('toggle').addEventListener('click', () => {});
</script>
```

## What scripts get rewritten

Rewritten (string literals): `getElementById`, `querySelector`/`querySelectorAll` with `#id`, `.cls`, and compound selectors, `getElementsByClassName`, `getElementsByName`, `closest`, `matches`, all `classList` methods including `replace`, `setAttribute('class'|'id'|'name', ...)`, `className =` and `+=`, and class names inside `innerHTML`/`insertAdjacentHTML` strings that also appear in the template.

Not rewritten:

| Pattern | Use instead |
|---|---|
| `el.id = 'x'` | Look the element up with `getElementById` and keep the reference |
| `` el.className = `a ${b}` `` | `classList.add/remove/toggle` with static names |
| `el.style.setProperty('--my-var', v)` on a locally declared property | A `data-` attribute, or a custom property the component does not declare (global token) |
| `querySelector("[name='email']")` | `getElementsByName('email')` |
| Classes only in an `innerHTML` string, never in the template | Add the class to the template, or use `classList` |

Each client `<script>` becomes its own IIFE, so top-level variables never collide. `<script type="module">` is not wrapped but its selectors are rewritten. Scripts with any other `type` (for example `application/ld+json`) are untouched. Details: [references/javascript.md](references/javascript.md).

## CSS rules

- Every class, element selector, `#id` selector, `@keyframes`, locally declared custom property, `@property`, `@counter-style`, `view-transition-name`, and `anchor-name` in component CSS is scoped to the component.
- **Classes the component's CSS does not define stay global.** A utility class like `skip-link` or `hidden` in the template passes through unscoped, so global stylesheets still match. A component with no CSS has no scoped classes at all.
- `html`, `body`, and `head` are never renamed: `html[data-theme="dark"] .card {}` works for theming.
- Element selectors apply only to the component's own template, never to slotted content or child component roots. Style slotted markup through a wrapper class plus `:is()`: `.prose :is(h2) {}`.
- `var(--token)` for a property the component never declares is left alone, so global design tokens in `:root` work everywhere.
- Gotchas: a standalone attribute selector `[data-state]` is not scoped and leaks; anchor it as `.card[data-state]`. `[id]` and `[id="..."]` selectors are stripped. Element names inside `:is()`, `:where()`, and `:has()` are not converted; use classes there.

Full CSS coverage, including nesting, `@layer`, `@container`, `@scope`, `@import`, and `url(#id)` fragments: [references/css.md](references/css.md).

## `deduplicateCss` (default `true`)

| | `true` (default) | `false` |
|---|---|---|
| Class names | `bascik__card__wrapper`, shared | `bascik__card__a1b2c3d4__wrapper`, per instance |
| CSS emitted | One `<style>` per component type | One `<style>` per instance |
| `querySelector('.cls')` | First instance on the page | That instance |

Keep the default and target elements by `id`. Set `scoping.deduplicateCss: false` only when migrating code that depends on class queries per instance.

## Keeping names literal

- `scoping.preserve` (default `['code']`): tags whose whole subtree keeps literal `id`, `name`, and `class`. Exact names or `*` wildcards (`vendor-*`).
- `data-bascik-preserve` on one element keeps its subtree literal; `data-bascik-preserve="name"` keeps only selected attributes. Use it for external form endpoints or third-party scripts that need literal names.
- A link and its target must be both preserved or both scoped. A scoped link to a preserved target works; a preserved link to a scoped target does not.
- Never preserve a skip link to "make it work". Put the target `id` on the page shell instead.
- `scoping.attributes.class: false` turns off class scoping project-wide (Tailwind). IDs and names stay scoped.

## References between elements

Same-component ID references are rewritten together with the ID: `<label for>`, form and ARIA ID-reference attributes, microdata `itemref`, fragment-only `href="#x"`, SVG fragment attributes, inline `style` `url(#x)`, and `usemap` (against `<map name>`). Space-separated lists resolve token by token. References to IDs on the page shell or in another component are left unchanged.

Form inputs get per-instance `name` values, so `new FormData(form)` keys are the scoped names. Read values through element references, or preserve `name` when a server needs literal field names.

## Verify scoping

1. `node <skills-dir>/bascik/scripts/preview.mjs '<my-card />' --count 2` prints the compiled HTML for two instances, so you can confirm IDs differ, classes match the CSS, and script strings were rewritten.
2. `npx @bascik/language-server --check` flags unscopable patterns (`.id =` assignments, template-literal classes, attribute selectors, element names inside `:is()`).
3. In the browser, component scripts appear in DevTools Sources as `src/components/<name>.html` with original line numbers (dev server or `minify.js: false`).

## References

- [references/css.md](references/css.md): complete CSS scoping behavior and compatibility notes
- [references/javascript.md](references/javascript.md): DOM rewriting details, JS-only class discovery, TypeScript in component scripts, debugging
