# 35: CSS scoping memoization

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/javascript.ts`, `pkg/src/lib/styles.ts`, `pkg/src/lib/components.ts`.

**Byte-neutral refactor.** Use the byte-identical harness from prompt 34.

---

## The problem

`getTag` returns `{...returnObj, ...componentList[name]}`, a **fresh shallow copy per
instance**, so `component.cssFileContent` is re-scoped from scratch **every single time**.

Per instance, `javascript.ts#L293` and `#L640` call `resolveCssImportsSync`, which does
**synchronous `existsSync`, `statSync`, and `readFileSync`**, blocking the event loop **once per
instance**.

Then the entire chain runs:

`shieldCssStrings`, the class regex, `convertCssElementSelectorsToClasses`, `prefixKeyframes`,
`convertCssIdSelectorsToClasses`, `removeIdSelectors`, `scopeCssCustomProperties`,
`scopeLayerNames`, `scopeContainerNames`, `scopeViewTransitionNames`, `scopeCounterStyleNames`,
`scopeAnchorNames`.

Then `deduplicateCss` **throws away all but the first copy**.

With the default `deduplicateCss: true` the result is **byte-identical every time**. This is pure
waste, proportional to instances multiplied by CSS size.

---

## The design constraint you must honor

**Verified fact.** `javascript.ts#L139`:

```ts
const scopeKey =
  attribute === "class" && deduplicateCss
    ? component.name
    : componentInstanceName;
```

So:

- With **`deduplicateCss: true`** (the default), the scope key for classes is the **component
  name**. Memoizing scoped CSS per component **type** is sound.
- With **`deduplicateCss: false`**, the scope key includes the **instance ID**. The memoization
  key **must include the instance ID too**, or every instance gets the first instance's class
  names and the page is broken.

**Get this wrong and the failure is subtle:** the page renders, but every instance after the
first has unstyled or mis-styled elements.

### The cache key

Include **every** input that can change the output:

- component name
- instance ID, **when `deduplicateCss` is false**
- the `minify.identifiers` setting
- a hash or mtime of the CSS source, including resolved imports
- anything else the scoping chain reads from config

Write a test for **each** key component: change it, assert the cache misses.

Note prompt 21 may have opted some components out of deduplication for CSS fragment references.
If so, those components must key per instance regardless of the global setting. Coordinate.

---

## Also fix: synchronous disk I/O per instance

Even with memoization, the first call per component should not block the event loop.

**Resolve CSS imports once, asynchronously, when the component is loaded** in `listComponents`,
and cache the resolved content on the component record.

Assert the fix by spying on `readFileSync` and confirming it is **not called during
transpilation**.

---

## Also fix: the fixed-point loop

`convertCssElementSelectorsToClasses` pass 4 (`styles.ts#L114-L122`):

```js
do { … } while (result !== previousResult)
```

It re-scans the whole stylesheet with a lookbehind-heavy regex until stable. Multiplied by the
per-instance re-run above, this is `O(instances × css × depth)`.

Memoization removes most of the cost. **Measure again afterward.** If it is still hot, bound the
iteration count and warn rather than looping unboundedly, since an unbounded fixed-point loop on
adversarial input is a hang.

---

## Also fix: the duplicated import resolver

`resolveCssImports` and `resolveCssImportsSync` (`styles.ts#L474-L620`) are about 55 lines
duplicated verbatim except for `await readFile` versus `readFileSync`.

Prompts 18 and 34 both flagged this. If it is still duplicated, factor it out now, since you are
changing both.

---

## TDD steps

### Step 1: the guard, currently failing

A page with **50 instances of one component** that has CSS. Instrument the scoping chain entry
point with a counter. Assert it runs **once**, not 50 times. It must fail.

### Steps 2 to 8

2. Implement memoization keyed per component type. The guard passes. The byte-identical harness
   passes.
3. **`deduplicateCss: false`**: two instances produce **different** scoped class names, and each
   instance's CSS matches its own markup. This is the test that catches the subtle failure.
4. **`minify.identifiers`** on and off both produce correct output, and toggling it invalidates
   the cache.
5. Changing a component's CSS source invalidates the cache.
6. Changing a **resolved import** of that CSS invalidates the cache.
7. `readFileSync` is **not called during transpilation**.
8. A component with no CSS does not populate or consult the cache.

Also confirm the cache is bounded, or that its size is naturally bounded by the component count.
An unbounded cache keyed by instance ID under `deduplicateCss: false` grows with page size;
decide whether that matters and say so.

## Testing

**Unit:** all of the above.

**E2E:** the byte-neutral claim needs a real check, and the `deduplicateCss: false` path needs a
visual one.

- `playwright.config.ts` (static build): a fixture component with distinctive CSS, used **five
  times**, built with `deduplicateCss: true`. Assert all five instances are styled correctly and
  that only **one** copy of the CSS appears in the output.
- Add a second fixture built with `deduplicateCss: false`, asserting all five are styled
  correctly with per-instance class names. **This is the config that breaks if the cache key is
  wrong**, and a unit test on strings is easier to get accidentally passing than a rendered page.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. Build-time CSS generation. State that reasoning.

Assert styling via computed style, not by inspecting class names, since production hashes them.

## Documentation

| File                                               | Change                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `docs/content/internals/scoping-system.md`         | Scoped CSS is memoized per component type, **and the `deduplicateCss` caveat** |
| `docs/content/internals/transpilation-pipeline.md` | CSS imports are resolved once at component load, not per instance              |
| `docs/content/performance.md`                      | Only if numbers materially improved. Use recorded measurements                 |

No SKILL.md change expected. Say so explicitly if none is needed.

## Acceptance criteria

- [ ] The guard existed and failed before, and passes after.
- [ ] The scoping chain runs **once per component type** under the default config.
- [ ] **`deduplicateCss: false` produces correct per-instance output**, proven by a rendered-page
      E2E.
- [ ] The cache key includes every input that can change the output, with a test per component.
- [ ] Changing CSS or a resolved import invalidates the cache.
- [ ] **`readFileSync` is not called during transpilation.**
- [ ] The fixed-point loop is measured again, and bounded if still hot.
- [ ] `resolveCssImports` and its sync twin share one implementation.
- [ ] The byte-identical harness passes; `docs/dist` is unchanged.
- [ ] Two consecutive docs builds remain byte-identical.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added for both `deduplicateCss` settings; the user has run `yarn e2e:all`.

## Do not do

- **Do not change any output.**
- Do not memoize per component type without handling `deduplicateCss: false`.
- Do not convert function replacements to string replacements.
- Do not touch the transpile loop or `attributesToReplace`. Prompts 34 and 36.
- Do not run Playwright or pre-push scripts.
