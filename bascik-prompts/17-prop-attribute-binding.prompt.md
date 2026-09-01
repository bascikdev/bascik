# 17: Prop-to-attribute binding

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/components.ts`, `pkg/src/lib/processing.ts`,
`extensions/vscode-bascik/`.

**Decision, do not re-litigate:** implement `data-bascik-attr-{attribute}="{propName}"`.

---

## The gap

`data-bascik-prop-{name}` fills an element's **inner content**. There is no way to put a prop
value into an **attribute** of a non-root element.

So this is impossible today:

```html
<!-- component template -->
<article class="card">
  <img src="???" alt="???" />
  <a href="???">Read more</a>
</article>
```

Three mechanisms partly cover it, and none covers this case:

- **Attribute inheritance** merges non-`data-bascik-*` attributes from the usage tag onto the
  component's **root** element. `<my-link href="/about">` works when the root **is** the `<a>`.
- **Named slots** carry arbitrary HTML, so the usage site can pass a complete `<img src alt>`.
  But that pushes markup authorship to the consumer and takes styling control away from the
  component.
- **Build scripts** can generate the whole markup with any attribute values.

The genuine gap is attributes on **non-root** elements in components that are not otherwise
using a slot, which is common in card and media components.

---

## The syntax

```html
<!-- component template -->
<a data-bascik-attr-href="link" data-bascik-attr-aria-label="label">
  <span data-bascik-prop-text>Read more</span>
</a>

<!-- usage -->
<my-link
  data-bascik-prop-link="/about"
  data-bascik-prop-label="About us"
  data-bascik-prop-text="About"
/>
```

Read it as: **set attribute `href` from prop `link`**.

### The framing to use in docs

It is the same prop _values_ with a different _destination_. It introduces no templating and no
variables. It is just another spec-compliant `data-*` attribute, exactly like props. Nothing is
invented.

---

## Rules

- The attribute name is everything after `data-bascik-attr-`. It **may contain hyphens**, which
  is required for `aria-*` and `data-*` targets.
- The value is a **prop name**, not a literal. This is deliberate.
- The `data-bascik-attr-*` attribute itself is **stripped from the compiled output**. It is a
  build-time directive.
- If the named prop was **not supplied**, the directive is removed and **no attribute is
  added**. Do not emit an empty attribute.
- Values are HTML-attribute-escaped on injection, consistent with prompt 13.
- If the target attribute **already exists** on the element, the prop value wins and a warning
  is emitted naming both. Do not silently pick one.
- An unknown or malformed directive warns and is ignored, per the resilience rule.
- A prop may drive both content and an attribute; they are independent.

---

## Interaction with scoping

If the target attribute is `id`, `name`, or `class`, the injected value must go through the
**same scoping pipeline** as an authored one.

Decide the ordering. Injecting **before** scoping is simplest and means the value is treated
exactly like authored markup, which is the behavior authors will expect.

Test with a **two-instance** component to prove `id` and `name` values are scoped **per
instance**, and that `class` follows the `deduplicateCss` rule from `00-README.md`.

---

## Explicitly not doing

- No `{{expr}}` or `${expr}` interpolation. That is a templating language, which
  `docs/content/faq.md` positions Bascik against.
- No expressions, conditionals, or default values in the directive.
- No binding to anything other than a prop name.

---

## TDD steps

Write each failing test first.

1. A simple attribute: `data-bascik-attr-href="link"` with `data-bascik-prop-link="/about"`
   emits `href="/about"`.
2. A hyphenated attribute: `data-bascik-attr-aria-label` and `data-bascik-attr-data-foo`.
3. The directive is stripped from output in both cases.
4. A missing prop adds **no** attribute and leaves no residue.
5. A conflicting existing attribute: the prop wins and a warning names both.
6. The value is attribute-escaped. Test a value containing `"` and one containing `<`.
7. A value containing `$&` and `$1` survives verbatim. **Function replacements only.**
8. `data-bascik-attr-id` on a two-instance component produces two distinct scoped ids.
9. `data-bascik-attr-name` likewise.
10. `data-bascik-attr-class` follows the `deduplicateCss` rule.
11. A malformed directive, for example `data-bascik-attr-` with no attribute name, warns and is
    ignored without crashing.
12. The same prop drives both content and an attribute on different elements.

## Testing

**Unit:** all of the above, in `components.test.ts`.

**E2E:** add a card fixture component with `data-bascik-attr-href` on a non-root `<a>` and
`data-bascik-attr-src` plus `data-bascik-attr-alt` on a non-root `<img>`, used **twice** with
different props.

- `playwright.config.ts` (static build): both links navigate to their own target, both images
  load their own source with their own alt text, and no `data-bascik-attr-*` attribute remains
  in the DOM.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. This is build-time. State that reasoning.

Assert the absence of the directive attribute explicitly. A leftover `data-bascik-attr-*` in
shipped HTML is exactly the kind of thing that passes a content check and fails review.

## Documentation

| File                                    | Change                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/props.md`                 | The new directive, with the "same prop values, different destination" framing. Explicitly: no templating, no variables, spec-compliant `data-*`. Show the card example |
| `docs/content/components.md`            | Add it to the directive family list                                                                                                                                    |
| `docs/content/attribute-inheritance.md` | Clarify the division: inheritance is root-only, this is for non-root elements, slots are for consumer-authored markup                                                  |
| `docs/content/compatibility.md`         | **Required by repo policy.** A row for the directive, including the `id`/`name`/`class` scoping interaction and the conflict warning                                   |
| `docs/content/faq.md`                   | "How do I put a prop into an attribute?"                                                                                                                               |
| `docs/src/pages/assets/SKILL.md`        | Default-first: the directive and one example. Gotchas: a missing prop adds nothing, and a conflict warns. Sync `create/assets/SKILL.md`                                |

## VS Code extension

`extensions/vscode-bascik/`, see `.github/skills/bascik-vscode-extension/SKILL.md`.

- Update the grammar so `data-bascik-attr-*` highlights alongside the other directives.
- Add a **warning** diagnostic: a `data-bascik-attr-*` naming a prop that no usage of the
  component supplies.
- Add a test for the diagnostic.

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] Plain and hyphenated attribute targets both work.
- [ ] The directive is stripped from output.
- [ ] A missing prop adds no attribute.
- [ ] A conflict warns naming both, and the prop wins.
- [ ] Values are attribute-escaped and `$&`-safe via function replacements.
- [ ] `id`, `name`, and `class` targets are scoped correctly per instance and per the
      `deduplicateCss` rule.
- [ ] A malformed directive warns without crashing.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E asserts no `data-bascik-attr-*` remains in the DOM; the user has run `yarn e2e:all`.
- [ ] Docs updated including `compatibility.md`; both SKILL.md copies in sync.
- [ ] The extension highlights the directive and has a passing diagnostic test.

## Do not do

- Do not add interpolation, expressions, defaults, or any templating syntax.
- Do not allow the directive value to be a literal rather than a prop name.
- Do not change attribute inheritance or slots.
- Do not run Playwright or pre-push scripts.
