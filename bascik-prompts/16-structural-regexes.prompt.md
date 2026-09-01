# 16: Structural regex fixes

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/components.ts`, `pkg/src/lib/processing.ts`.

Three regexes that mis-parse valid HTML. Each silently produces corrupt or wrong output.

---

## Bug 1: `mergeAttributesOntoRoot` is not quote-aware

`components.ts#L860`:

```js
/^(…leading…)(<[a-zA-Z][\w-]*)((?:\s[^>]*?)?)(\s*\/?>)/i;
```

`[^>]*?` terminates at the **first `>`**, including one inside a quoted attribute value.

A root element `<div title="a > b">` splits as `existing = ' title="a '`, `close = '>'`, and
merged attributes are appended **inside the quoted value**, producing corrupt HTML.

Everywhere else in the codebase this was fixed with the shared `ATTR_VALUE` fragment. **This
call site was missed.**

### 1b. The `leading` group is too narrow

It only skips whitespace, comments, `<script>`, and `<style>`. If a template begins with a bare
text node, a `<link>`, or a `<meta>`, the whole regex **fails to match** and inherited
attributes are **silently dropped**.

That is a worse failure than the quote bug, because nothing is corrupt, the attributes just are
not there.

### 1c. `style` on both sides

`components.test.ts#L754-L823` covers `class` merging and a generic "does not override" case,
but **not** `style` present on both the usage and the template root. Today the usage value is
dropped entirely.

Decide the behavior. Merging two style declarations is reasonable and consistent with how
`class` is handled. Document the choice and test it.

### Coverage gap

`components.test.ts#L1040` covers quote-awareness for `extractInheritableAttributes` and
`injectProps` but **not** for this function.

---

## Bug 2: body and head reassembly uses a weaker parse than extraction

`processing.ts#L1009`:

```js
.replace(/(<body[^>]*>)[\s\S]*?(<\/body>)/i, (_m, open, close) => …)
```

The `$`-safety here is **correct**: it uses a function replacement, which was the fix for the
historical out-of-memory bug. **Keep that.**

But:

- `[^>]*` is not quote-aware.
- `[\s\S]*?` stops at the **first literal** `</body>` or `</head>`, including one inside a
  `<textarea>` or a JavaScript string.

Meanwhile **extraction** used the masked, depth-aware `getTag`. When the two disagree, the
transpiled body is spliced into the wrong location and the tail of the original body is
duplicated.

**Fix:** reassemble using the same masked, depth-aware indices that extraction produced. Do not
re-derive them with a second, weaker regex. Thread the indices through.

---

## Bug 3: self-closing nesting depends on one whitespace character

`components.ts#L632`:

```js
const openRe = new RegExp("<" + tn + "[\\s>]", "gi");
```

`<my-list />` matches `<my-list ` because of the space, and increments the depth counter, but
no `</my-list>` follows.

So `<my-list><my-list /></my-list>` never balances, `findMatchingClose` returns `-1`, `getTag`
falls through to the self-closing branch and mis-slices the element.

`<my-list/>` with **no space** is handled correctly.

**The behavior differs on a single whitespace character.**

`components.test.ts#L934-L1010` covers nested paired tags thoroughly but never this case.

---

## TDD steps

Write each failing test first.

1. A root element `<div title="a > b">` merges inherited attributes correctly, outside the
   quotes.
2. A template starting with a bare text node still receives inherited attributes.
3. A template starting with `<link>` or `<meta>` does too.
4. `style` on both the usage and the root behaves per the documented decision.
5. A page whose body contains `</body>` inside a `<textarea>` reassembles correctly, with no
   duplicated tail.
6. The same for `</head>` inside a script string.
7. `<my-list><my-list /></my-list>` parses identically to `<my-list><my-list/></my-list>`.
8. A deeply nested self-closing mix, three levels, with and without the space.

For 5 and 6, assert the **full output**, not just that it contains the expected content.
Duplication is only visible in a full comparison.

## Testing

**Unit:** all of the above, in `components.test.ts` and `processing.test.ts`.

**E2E:** add a fixture page with a `<textarea>` containing the literal text `</body>`, and a
component whose root element has a `>` inside an attribute value and receives an inherited
attribute, and a component used with self-closing nesting.

- `playwright.config.ts` (static build): the page renders once, not twice; the textarea content
  is intact; the inherited attribute is present and the root element is well-formed.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. These are build-time parse bugs. State that reasoning.

A duplicated body tail is the kind of thing a unit test on a fragment misses and a real page
render catches, so the E2E here is doing genuine work.

## Documentation

| File                                    | Change                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/attribute-inheritance.md` | The `leading` fix means inheritance now works for templates that start with a text node, `<link>`, or `<meta>`. Document the `style` merge decision |
| `docs/content/components.md`            | Self-closing usage is equivalent with or without a space                                                                                            |
| `docs/content/compatibility.md`         | **Required by repo policy.** Quote-aware root merging, `</body>` inside raw-text elements, self-closing nesting                                     |
| `docs/content/faq.md`                   | "Why were my inherited attributes dropped?" if worth a searchable entry                                                                             |

## Acceptance criteria

- [ ] All eight tests failed before their fixes and pass after.
- [ ] `mergeAttributesOntoRoot` is quote-aware, reusing the shared `ATTR_VALUE` fragment.
- [ ] Inherited attributes are never silently dropped for a text-node-first, `<link>`-first, or
      `<meta>`-first template.
- [ ] The `style` conflict behavior is decided, documented, and tested.
- [ ] Body and head reassembly uses extraction indices, not a second regex.
- [ ] A `</body>` inside a `<textarea>` does not duplicate the page tail.
- [ ] `<my-list />` and `<my-list/>` behave identically at every nesting depth.
- [ ] Function replacements are still used in reassembly; none were converted to string
      replacements.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` succeeds.
- [ ] E2E added; the user has run `yarn e2e:all`.

## Do not do

- Do not introduce an HTML AST parser. Resilience to malformed input is a design property.
- Do not convert the reassembly function replacements to string replacements.
- Do not consolidate the shielding implementations. Prompt 18.
- Do not run Playwright or pre-push scripts.
