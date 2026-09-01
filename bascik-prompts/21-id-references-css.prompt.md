# 21: ID-reference rewriting in CSS

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/id-references.ts` (created in prompt 20), `pkg/src/lib/styles.ts`.

**Depends on prompt 20** for `collectDeclaredIds` and the resolver contract.

---

## The problem

Inline SVG commonly references its own gradients, masks, filters, and markers by ID:

```html
<svg>
  <defs><linearGradient id="grad">…</linearGradient></defs>
  <rect fill="url(#grad)" />
</svg>
```

Prompt 20 handles `fill="url(#grad)"` when it is an **HTML attribute**. This prompt handles the
same reference when it appears in **CSS**:

```css
.icon {
  fill: url(#grad);
}
.card {
  clip-path: url(#rounded);
  filter: url(#shadow);
}
```

Properties that take a fragment URL: `fill`, `stroke`, `clip-path`, `mask`, `filter`,
`marker-start`, `marker-mid`, `marker-end`. Check for others rather than treating that list as
closed.

Without this, a scoped `id="grad"` leaves `url(#grad)` pointing at nothing and the SVG renders
unstyled or invisible.

---

## The shielding carve-out

`shieldCssStrings` in `pkg/src/lib/styles.ts#L343` preserves `url(...)` contents with a regex so
CSS processing does not corrupt them, then restores them unchanged.

**That shielding is exactly what currently prevents `url(#gradient)` from being rewritten.**

You need a carve-out distinguishing **fragment-only** URLs from real URLs:

| Value                  | Action                                                               |
| ---------------------- | -------------------------------------------------------------------- |
| `url(#foo)`            | Rewrite the fragment                                                 |
| `url('#foo')`          | Rewrite the fragment                                                 |
| `url("#foo")`          | Rewrite the fragment                                                 |
| `url(/img/x.png)`      | **Leave completely alone**                                           |
| `url(https://…)`       | **Leave completely alone**                                           |
| `url(data:…)`          | **Leave completely alone**                                           |
| `url(sprite.svg#icon)` | **Leave completely alone.** The fragment belongs to another document |

The distinguishing test is that the URL content, after trimming optional quotes and whitespace,
**starts with `#`**. Anything else is untouched.

**Do not attempt to parse general URLs.** The `#`-prefix test is the whole rule.

Note prompt 18 consolidated the shielding implementations. Work with that utility; the carve-out
belongs inside it or immediately adjacent, not as a separate pre-pass that could disagree.

---

## The per-type versus per-instance problem

**This is the subtlety that makes this prompt harder than prompt 20. Read carefully.**

Verified fact, `javascript.ts#L139`:

```ts
const scopeKey =
  attribute === "class" && deduplicateCss
    ? component.name
    : componentInstanceName;
```

So under the **default** `scoping.deduplicateCss: true`:

- **`class` names are per component TYPE.** Two instances produce identical scoped class names
  and identical scoped CSS, which is what lets `deduplicateCss` emit **one** `<style>` block.
- **`id` and `name` are per component INSTANCE.** They include the instance ID.

Now consider a component with an inline SVG gradient used **twice** on a page:

- Instance one declares `id="grad"` which scopes to `…__a1b2c3__grad`.
- Instance two declares `id="grad"` which scopes to `…__d4e5f6__grad`.
- But there is **one** shared stylesheet containing `.icon { fill: url(#???); }`.

**One stylesheet cannot reference two different IDs.** So under `deduplicateCss: true`, a CSS
`url(#id)` reference to a **per-instance** ID is not expressible.

### Required resolution

You must pick one and implement it deliberately. Options:

1. **Emit per-instance CSS for components that contain a CSS fragment reference**, opting those
   components out of deduplication. Correct, at the cost of duplicated CSS for those components
   only.
2. **Scope the referenced IDs per type rather than per instance** when they are referenced from
   CSS. Keeps one stylesheet, but two instances then share an ID, which is invalid HTML and
   breaks the second instance's rendering in some browsers.
3. **Leave CSS fragment references unrewritten and warn**, directing the author to
   `data-bascik-preserve` or to an inline `style` attribute, which prompt 20 already handles
   per instance.

Option 1 is the only one that is both correct and useful. Option 2 emits invalid HTML. Option 3
is honest but leaves a real pattern broken.

**Whichever you choose, document the reasoning in `docs/content/scoped-styles.md` and in a
one-line code comment, and test both `deduplicateCss` settings.**

Under `deduplicateCss: false` the CSS is already per instance, so the reference resolves per
instance with no special handling. That case must be tested too, and it is the easy one.

---

## Where to implement

Extend `pkg/src/lib/id-references.ts` from prompt 20:

```ts
/** Rewrite url(#id) fragments in a CSS string. */
export const rewriteIdReferencesInCss = (
  css: string,
  resolve: (originalId: string) => string | null,
): string;
```

Pure function. Call it from the CSS path in `pkg/src/lib/styles.ts`.

---

## TDD steps

### Step 1: prove the bug, before any fix

In `styles.test.ts`:

```
"rewrites url(#grad) to match a scoped svg gradient id"
```

**It must fail.**

### Step 2: `rewriteIdReferencesInCss`, pure

Positive cases: `filter: url(#f)`, `clip-path`, `mask`, `fill`, `stroke`, `marker-end`. Quoted
forms `url('#f')` and `url("#f")`. Extra whitespace inside `url( #f )`.

**Negative cases that must stay byte-identical:** `url(/img/x.png)`, `url(https://…)`,
`url(data:image/svg+xml,…)`, `url(sprite.svg#icon)`, and a `url()` inside a CSS comment.

Unresolvable fragment: `url(#not-local)` is untouched.

Regex-token safety: an ID containing `$&` survives. **Function replacements only.**

### Step 3: the shielding carve-out

Assert that real URLs still round-trip through shielding unchanged, and that CSS processing
still cannot corrupt them. The carve-out must not weaken the original protection.

### Step 4: the deduplication decision

- `deduplicateCss: false`: two instances, each with its own stylesheet, each resolving to its
  own ID.
- `deduplicateCss: true`: whichever behavior you chose, asserted explicitly, plus the warning if
  you chose option 3.
- A component **without** any CSS fragment reference must still deduplicate normally under
  `true`. Confirm you did not accidentally opt every component out.

### Step 5: interaction

- A preserved subtree's IDs are unscoped, so a `url(#id)` referring to one is untouched.
- With `minify.identifiers: true`, the CSS reference and the HTML declaration share one hash.

## Testing

**Unit:** all of the above.

**E2E:** the visual proof is what matters here. Add a fixture component containing an inline SVG
with a `<linearGradient id>` and a CSS rule using `fill: url(#…)`, used **twice** on one page
with different gradient colors if the chosen resolution supports it.

- `playwright.config.ts` (static build): **both** SVGs render with their gradient applied. Assert
  via computed style or a screenshot comparison, not by inspecting the ID.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. This is build-time CSS generation. State that reasoning.

A gradient that fails to resolve renders as black or transparent, so a computed-style assertion
on the rendered fill is a genuine check. Add a second fixture with `clip-path` if the gradient
check proves flaky.

## Documentation

| File                             | Change                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/scoped-styles.md`  | `url(#id)` rewriting, the fragment-versus-real-URL rule, and **the deduplication decision with its reasoning**. This is the load-bearing explanation                                                |
| `docs/content/compatibility.md`  | **Required by repo policy.** Extend prompt 20's ID References table with CSS `url(#id)`, listing which properties are covered, and a row for `url(other.svg#frag)` marked as deliberately untouched |
| `docs/content/faq.md`            | "Why is my inline SVG gradient not showing?" Now fixed, but searchable                                                                                                                              |
| `docs/src/pages/assets/SKILL.md` | CSS fragment references are rewritten; note the deduplication caveat if the chosen resolution has one. Sync `create/assets/SKILL.md`                                                                |

## Acceptance criteria

- [ ] The step-1 test failed before and passes after.
- [ ] Every listed CSS property with a fragment URL is rewritten.
- [ ] Every negative case is byte-identical, including `url(sprite.svg#icon)`.
- [ ] The shielding carve-out does not weaken protection for real URLs.
- [ ] **The `deduplicateCss: true` resolution is chosen deliberately, documented with its
      reasoning in both code and docs, and tested.**
- [ ] `deduplicateCss: false` resolves per instance.
- [ ] A component with no fragment reference still deduplicates normally.
- [ ] Preserved subtrees are excluded.
- [ ] Reference and declaration share a hash under `minify.identifiers: true`.
- [ ] Values containing `$&` survive; **function replacements throughout**.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] **A two-instance inline SVG renders correctly in both**, verified by E2E in static build
      and dev; the user has run `yarn e2e:all`.
- [ ] `compatibility.md` extended; both SKILL.md copies in sync.

## Do not do

- Do not parse general URLs. The `#`-prefix test is the rule.
- Do not rewrite `url()` in an inline `style` attribute. **Prompt 20 owns that**, since it is an
  HTML attribute.
- Do not rewrite `url(/path)` for base-path purposes. **Prompt 22 owns that**, and the two
  transforms must not both claim a `url()` value. State the ordering.
- Do not introduce a CSS AST parser.
- Do not run Playwright or pre-push scripts.
