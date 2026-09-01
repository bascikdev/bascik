# 14: Class token normalization and component tag matching

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/javascript.ts`, `pkg/src/lib/components.ts`.

Two independent regex bugs. The first corrupts generated JavaScript; the second makes one
component swallow another's tag.

---

## Bug 1: class token splitting is wrong in two ways

`javascript.ts#L331-L340`:

```js
const newInner = match.replace(/  +/g, " ").split(" ");
```

### 1a. Tabs and newlines are not handled

Only runs of **two or more spaces** are collapsed. A multi-line attribute:

```html
<div
  class="a
  b"
></div>
```

yields the token `"a\n"`, whose scoped name becomes `bascik__x__a\n`, and the class never
matches its CSS. The element is silently unstyled.

### 1b. A leading or trailing space yields an empty token

`class="foo "` produces an empty-string token. When the component has no CSS
(`scopedClassesSet === null`), that empty token is pushed to `attributesToReplace`.

Downstream, `javascript.ts#L527` builds:

```js
new RegExp("([\"'])" + "" + "\\1", "g");
```

which matches **every** `""` and `''` in the component's script and replaces each with the
hash. Meanwhile `classNameTokenRegex`, with its `(?<![a-zA-Z0-9_-])(?![a-zA-Z0-9_-])` guards,
matches empty positions.

**The output JavaScript is corrupted.**

### Fix

```js
.trim().split(/\s+/).filter(Boolean)
```

Then confirm no empty token can reach `attributesToReplace` under any input.

### Coverage gap

No test covers `class="a "`, `class=" a"`, `class="a\n b"`, or `class="a\tb"`. The
property-based fuzzing generator at `javascript.test.ts#L1041` emits well-formed tokens only.
**Extend the generator** to produce leading, trailing, doubled, tab, and newline whitespace, so
this class of bug cannot return.

---

## Bug 2: a component name matches a longer hyphenated tag

`components.ts#L456-L458`:

```js
new RegExp(`<\\b(${componentNames.join("|")})\\b[\\s\\S]*?>`, "i");
```

`\b` between `d` and `-` **is** a word boundary. So with a component named `card`, the tag
`<card-header>` matches and is reported as `card`. The `card` template then replaces
`<card-header>`.

`components.ts#L360` compounds it: `<${tn}(?:${ATTR_VALUE})>` has **no boundary guard at all**,
so `findOpenTag(html, "card")` happily matches `<card-header>` and `getTag` returns it as the
`card` usage.

Sorting names by length only protects the case where the longer name is **also** a registered
component. `components.test.ts#L203` tests exactly that case, which is why the bug survived.

### Fix

Add `(?![\w-])` after the name in **both** places.

Add the missing test: `<card-header>` when **only** `card` is registered.

### Related

`getFirstComponent`'s regex cache is keyed on the **key count**
(`components.ts#L448-L460`: `cached.keysCount !== currentKeyCount`). A rename that preserves the
count returns a stale regex. Currently masked because `invalidateComponentListCache` creates a
fresh object, giving a fresh WeakMap key, but the guard itself is wrong. Key on identity or a
content hash.

Also, the `.sort((a,b) => b.length - a.length)` used for longest-first matching is **unstable
for equal-length names**. Add a secondary comparison on the name itself so ordering is
deterministic. Prompt 25 depends on this.

---

## TDD steps

Write each failing test first.

1. `class="a "` produces exactly one token, and no empty string reaches `attributesToReplace`.
2. A component with `class="foo "` and a script containing `const s = "";` emits **uncorrupted**
   JavaScript. This is the test that proves the real-world impact.
3. `class="a\n  b"` yields `["a", "b"]`, and both classes match their CSS.
4. `class="a\tb"` yields `["a", "b"]`.
5. `<card-header>` is **not** matched when only `card` is registered, in `getFirstComponent`.
6. The same, in `findOpenTag`.
7. A component rename that preserves the key count does not return a stale cached regex.
8. Two equal-length component names sort deterministically across repeated calls.
9. The extended fuzzing generator finds no new failure.

## Testing

**Unit:** all of the above, in `javascript.test.ts` and `components.test.ts`.

**E2E:** add a fixture with a component whose markup uses `class="card "` with trailing
whitespace and whose script contains an empty string literal, plus a component named `card`
used alongside a literal `<card-header>` element that is **not** a component.

- `playwright.config.ts` (static build): the styled element actually has its styles applied,
  the script runs with no console error, and `<card-header>` is untouched in the output.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. Both bugs are build-time. State that reasoning.

The console-error assertion matters: a corrupted script is otherwise invisible in a screenshot.

## Documentation

| File                            | Change                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/compatibility.md` | **Required by repo policy.** Note that class attributes are normalized across all whitespace forms, and that a component name never matches a longer hyphenated tag |
| `docs/content/components.md`    | Naming guidance: a component named `card` does not claim `<card-header>`                                                                                            |
| `docs/content/faq.md`           | Only if either bug is worth a searchable entry. Judge and say which                                                                                                 |

## Acceptance criteria

- [ ] All nine tests failed before their fixes and pass after.
- [ ] Class tokens are normalized with `.trim().split(/\s+/).filter(Boolean)`.
- [ ] **No empty token can reach `attributesToReplace` under any input.**
- [ ] A component with trailing class whitespace emits uncorrupted JavaScript.
- [ ] `<card-header>` is not matched by a component named `card`, in **both** call sites.
- [ ] The regex cache is keyed on identity or content, not key count.
- [ ] Equal-length component names sort deterministically.
- [ ] The fuzzing generator emits whitespace variants.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added with a console-error assertion; the user has run `yarn e2e:all`.

## Do not do

- Do not change the HTML minifier. Prompt 15.
- Do not touch `mergeAttributesOntoRoot` or body reassembly. Prompt 16.
- Do not consolidate the shielding implementations. Prompt 18.
- Do not run Playwright or pre-push scripts.
