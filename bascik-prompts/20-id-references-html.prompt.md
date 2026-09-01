# 20: ID-reference rewriting in HTML

Read `.github/prompts/00-README.md` first.

**Scope:** a new `pkg/src/lib/id-references.ts`, plus `pkg/src/lib/javascript.ts`.

**Depends on prompt 19** for the preserve exclusion hook.

**This is a bug fix, not a feature.** Bascik currently emits silently broken HTML.

---

## How this was found

`prefixElementAttribute` in `javascript.ts` is typed as:

```ts
export const prefixElementAttribute = (
  component: BascikComponent,
  attribute: "id" | "name" | "class",
  ...
)
```

Bascik rewrites the **value** of those three attributes, plus JavaScript selector calls and CSS
selectors. **Nothing rewrites a reference to an ID held in any other attribute.**

So when Bascik scopes `id="x"` into `id="bascik__comp__a1b2c3__x"`, every reference to `x`
elsewhere in the component points at an ID that no longer exists.

**Proof, in Bascik's own test fixture**, `pkg/e2e/src/components/form-test/form-test.html`:

```html
<label class="label" for="username-input">Username</label>
<input
  id="username-input"
  class="input"
  name="username"
  type="text"
  value="alice"
/>
```

After scoping the `id` becomes `bascik__form-test__<hash>__username-input` while `for` still
says `username-input`. **The label is orphaned. No test catches it.**

Impact: broken HTML, an automatic Lighthouse accessibility failure, and broken form
associations for screen reader users.

This is not a documented limitation. `docs/content/compatibility.md` documents scoped `name`
and FormData, attribute selectors, template literals, and the `element.id` setter, but says
nothing about `for`, `aria-*`, or fragment links.

---

## The rule

**When Bascik scopes an ID, it must scope every reference to that ID within the same
component.**

This completes `scoping.attributes.id`. **Do not add a config toggle**: an option would let
users opt into emitting broken HTML. If `scoping.attributes.id` is `false`, no IDs are scoped
and no references need rewriting.

### Scope boundary

**Only rewrite a reference when the referenced ID is declared in the same component.**

- Resolves to a local declaration: rewrite to the scoped name.
- Does not resolve: **leave byte-identical.**

Rationale: IDs are scoped per instance, so a cross-component reference cannot be resolved at
build time. Leaving it alone is correct, because page-level IDs are never scoped, so
`<a href="#main">` in a component pointing at `<main id="main">` in the page keeps working.

**Implementation:** build the set of declared IDs **before** rewriting, then rewrite in a
second pass. Do not attempt both in one pass.

---

## Attribute inventory

### Single ID reference

| Attribute               | Element                  | Notes                                 |
| ----------------------- | ------------------------ | ------------------------------------- |
| `for`                   | `<label>`                | Highest-impact accessibility case     |
| `form`                  | form-associated elements | Points at a `<form id>`               |
| `list`                  | `<input>`                | Points at a `<datalist id>`           |
| `popovertarget`         | `<button>`, `<input>`    | HTML popover API                      |
| `commandfor`            | `<button>`               | HTML invoker commands API             |
| `aria-activedescendant` | any                      | Combobox and listbox focus management |
| `aria-details`          | any                      |                                       |
| `aria-errormessage`     | any                      | Form validation messaging             |

### Space-separated ID lists, rewrite each token independently

`aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-flowto`, `headers`
on `<td>` and `<th>`, and **`for` on `<output>`**, which unlike `for` on `<label>` is a
multi-value attribute.

### Fragment URLs

| Location                               | Example                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `href` on `<a>` and `<area>`           | `href="#section"`                                                                                             |
| `href` and `xlink:href` on SVG `<use>` | `<use href="#icon">`                                                                                          |
| SVG presentation attributes            | `fill="url(#grad)"`, plus `stroke`, `mask`, `clip-path`, `filter`, `marker-start`, `marker-mid`, `marker-end` |
| inline `style=""` values               | `style="clip-path: url(#c)"`                                                                                  |

CSS inside `<style>` blocks and component stylesheets is **prompt 21**.

### A `name`-based reference, not an `id` one

`usemap` on `<img>`: `usemap="#mapname"` points at `<map name="mapname">`, which uses **`name`**,
not `id`. Rewrite it against the scoped **name** set, and only when `scoping.attributes.name`
is enabled. Put a one-line comment at that call site; it is easy to get wrong.

---

## Edge cases

| Case                                                | Behavior                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `href="#"` (bare hash)                              | Leave untouched                                                                                                                                              |
| `href="#top"` where `#top` is not local             | Leave untouched                                                                                                                                              |
| `aria-labelledby="a b"`, `a` local and `b` not      | Rewrite `a`, leave `b`. Per-token resolution                                                                                                                 |
| Duplicate whitespace in a token list                | Preserve the author's spacing where practical; never crash                                                                                                   |
| `href="/page#x"`                                    | Untouched. A different document                                                                                                                              |
| A reference inside `scoping.preserve` tags          | Untouched                                                                                                                                                    |
| A reference inside a `data-bascik-preserve` subtree | Untouched, and the declaration there is unscoped, so both directions agree                                                                                   |
| A value containing `$&`, `$1`, or `` $` ``          | **Function replacements only**                                                                                                                               |
| Malformed HTML, unclosed tags                       | Warn and continue. Never crash                                                                                                                               |
| The same ID declared twice in one component         | Existing behavior applies. Do not add new validation here                                                                                                    |
| `minify.identifiers: true`                          | The reference must get the **same hash** as the declaration. **Reuse the existing `minifyAttributeName` path** rather than recomputing, so they cannot drift |

---

## Where to implement

New `pkg/src/lib/id-references.ts`, exporting **pure functions** so the logic unit tests
without disk:

```ts
/** Collect the set of original ID values declared in the component HTML. */
export const collectDeclaredIds = (html: string): Set<string>;

/** Rewrite ID-holding attributes in HTML, using a resolver for declared IDs. */
export const rewriteIdReferencesInHtml = (
  html: string,
  resolve: (originalId: string) => string | null,
): string;
```

Call it from the `id` branch of `prefixElementAttribute`.

Keep the regex-and-depth-counter approach the rest of the codebase uses. **Do not introduce an
HTML AST parser.**

---

## TDD steps

### Step 1: prove the bug, before any fix

In `javascript.test.ts`:

```
"scopes the for attribute to match a scoped input id"
```

A component with `<label for="email"><input id="email">`. Assert `for` equals the scoped `id`.
**It must fail.**

Companions that must also fail: `aria-labelledby`, `href="#section"`.

### Step 2: `collectDeclaredIds`, pure

Single and multiple IDs; single versus double quotes; no IDs; malformed and unclosed tags; IDs
inside `<code>`; duplicate IDs; IDs on SVG elements.

### Step 3: `rewriteIdReferencesInHtml`, pure

Exhaustive coverage of the inventory. For **each** attribute: a resolvable reference is
rewritten, an unresolvable one is untouched.

Then token lists: mixed resolvable and unresolvable, extra whitespace, an empty value, `headers`
on `<td>`, and `for` on `<output>` as multi-value versus `for` on `<label>` as single-value.

Then fragments: `href="#x"`, `href="#"`, `href="/page#x"`, `<use href="#icon">`,
`<use xlink:href="#icon">`, every SVG presentation attribute, and inline
`style="clip-path: url(#c)"`.

Then regex-token safety: a value containing `$&` and `$1` survives verbatim.

### Step 4: wire into the pipeline

Step 1's tests pass. Then:

- **Two instances** of the same component get different scoped IDs, and **each label points at
  its own instance's input**.
- With `minify.identifiers: true`, reference and declaration share one hash.
- `usemap` resolves against the scoped `name` set, and is untouched when name scoping is off.
- A `data-bascik-preserve` subtree is excluded in both directions.

## Testing

**Unit:** all of the above.

**E2E:** **fix `pkg/e2e/src/components/form-test/form-test.html`** and add the behavioral proof.

In `pkg/e2e/tests/form-scoping.test.ts`, assert that **clicking each `<label>` focuses its
associated input**, for a component used **twice** on one page. That is the real-world proof
that a unit test on a string cannot give.

Add a second fixture with `aria-describedby` and a fragment link, also used twice.

- `playwright.config.ts` (static build): label clicks focus the right input in both instances;
  the fragment link scrolls to the right element; `aria-describedby` resolves.
- `playwright.dev.config.ts`: same, proving parity.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: the label-click
  assertion at minimum, since a served page is what a user actually gets.

Use `data-testid` and `page.getByTestId()`. Production builds hash IDs, so **never** assert on a
raw ID; assert on focus and on resolved relationships instead.

## Documentation

| File                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/compatibility.md`     | **Required by repo policy, and this file is why the bug survived.** Add an **ID References** table covering every attribute above, each marked supported with a note. Add rows for: fragment links, SVG `<use href>` and `xlink:href`, SVG presentation attributes, cross-component references (marked **unsupported** with the build-time-resolution reason), `usemap` (tied to `name`, not `id`), and `data-bascik-preserve` as the escape hatch. Also correct the file's implied completeness: it documents what Bascik supports without stating what it does not |
| `docs/content/scoped-javascript.md` | ID-reference rewriting and the same-component boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/content/faq.md`               | "Why is my `<label for>` not working?" Now fixed, but searchable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `docs/src/pages/assets/SKILL.md`    | References are rewritten automatically within a component; cross-component ones are not. Sync `create/assets/SKILL.md`                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## VS Code extension

Add an **info** diagnostic: an ID reference (`for`, `aria-*`, `href="#…"`) that does not resolve
to an ID declared in the same component, explaining it will be left unscoped. Add a test.

## Acceptance criteria

- [ ] The step-1 tests failed before and pass after.
- [ ] Every attribute in the inventory is rewritten when it resolves locally.
- [ ] Unresolvable references are byte-identical.
- [ ] Token lists resolve per token.
- [ ] Reference and declaration share a hash under `minify.identifiers: true`, via the existing
      `minifyAttributeName` path.
- [ ] `usemap` resolves against `name`, only when name scoping is on.
- [ ] Preserved subtrees are excluded in both directions.
- [ ] Values containing `$&` or `$1` survive verbatim; **function replacements throughout**.
- [ ] No HTML AST parser was introduced.
- [ ] `pkg/e2e/src/components/form-test/form-test.html` is fixed and **label clicks are
      behaviorally verified in a two-instance page**.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] `compatibility.md` has the ID References table; both SKILL.md copies in sync.
- [ ] The extension has the new diagnostic with a test.

## Do not do

- Do not rewrite `url(#id)` in CSS. **Prompt 21.**
- Do not add a config toggle for reference rewriting.
- Do not rewrite references across component boundaries.
- Do not claim `href="/path"`. That is prompt 22's base-path transform; **this prompt owns
  `href="#id"` only**.
- Do not run Playwright or pre-push scripts.
