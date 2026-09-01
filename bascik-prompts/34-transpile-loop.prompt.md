# 34: Transpile loop performance

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/processing.ts` (`recursivelyTranspile`), `pkg/src/lib/components.ts`
(`getFirstComponent`, `getTag`, `findOpenTag`, `findMatchingClose`, `replaceTag`).

**This is a refactor with real regression risk.** Every change must be **byte-neutral**.

---

## The method for this prompt

1. **Add a measurement guard that currently fails.** Count operations, not wall-clock time.
2. **Add a byte-identical output harness.** Output before and after must match exactly.
3. Optimize until the guard passes.
4. Re-run the byte-identical harness.

**Counting operations beats measuring time.** Wall-clock assertions are flaky in CI. Instrument
the hot functions with counters the tests can read, or spy on them. If you must measure time,
use a generous bound and mark the test skippable in constrained environments.

Prompt 24 made builds deterministic, so byte-identical comparison is now a **valid and reliable**
signal. Confirm that holds before proceeding; if two builds already differ, stop and find out
why.

---

## The problem

`recursivelyTranspile` (`processing.ts#L351`) is quadratic.

`maskRawTextContent(transpiledHtmlBody)` is recomputed **on every loop iteration**, over the full
and **growing** page string. Per substitution the loop performs at minimum:

1. `maskRawTextContent`: **two full-document regex passes**
2. `getFirstComponent`: a full-document regex
3. `getTag`, calling `findOpenTag` and `findMatchingClose`: a scan **from index 0**
4. `replaceTag`, calling `findOpenTag` and `findMatchingClose` **again**, duplicating step 3
5. two `<!--bascik-source-file…-->` marker insertions that **permanently inflate** the string

On a page with 300 component instances that is roughly **1500 full-document scans over a
monotonically growing buffer**.

This is the single largest scaling problem in the pipeline.

---

## Fixes, in order of value and risk

### 1. Reuse the indices (lowest risk, immediate win)

`getFirstComponent` and `getTag` already computed the open and close positions. `replaceTag`
throws them away and re-derives them.

Thread them through. This alone removes a third of the scanning with essentially no risk.

**Do this first.** It is the cheapest win and it validates your byte-identical harness before you
attempt anything riskier.

### 2. Incrementalize the mask (highest risk)

The mask does not need recomputing over the whole document on every iteration. Options, in
increasing complexity:

- Cache the mask and invalidate only the region affected by the last substitution.
- Maintain masked ranges as a data structure updated on each splice, rather than re-deriving by
  regex.
- Compute the mask **once per outer pass** rather than once per substitution, **if** a
  substitution cannot introduce new raw-text regions.

**That last assumption is almost certainly false.** A component template can absolutely contain a
`<script>` or `<style>`, so a substitution **can** introduce raw-text regions.

**If you take that option, write the test that would falsify the assumption first**, and only
proceed if it passes. Do not assume.

Take this in small steps and re-run the byte-identical harness after each.

### 3. Reconsider the source-file markers

They inflate the string permanently, and every subsequent scan pays for them.

Check whether they can be tracked **out-of-band** instead of inline. If they must stay inline,
ensure the mask treats them as skippable so they do not slow matching.

### 4. Add a cursor (medium risk)

`getFirstComponent` restarts from index 0 every time. If substitutions proceed roughly in
document order, a cursor avoids rescanning the resolved prefix.

**Be careful.** A substitution **can** introduce a component **earlier** than the cursor, if a
template places one before its own content. Verify before assuming, and **fall back to a full
scan when the invariant is violated** rather than producing wrong output.

---

## Existing guards to preserve

`processing.test.ts#L397` has a `MAX_SUBSTITUTIONS` and `MAX_OUTPUT_BYTES` guard test. That
bounds runaway expansion, not work. **Keep it passing.** Your new guard bounds work; the two are
complementary.

---

## TDD steps

### Step 0: baseline

Build the docs site and record the wall time and the output hash. You compare against both at the
end.

### Step 1: the byte-identical harness

A reusable helper that transpiles a fixture and compares output bytes against a snapshot. Use it
after **every** subsequent step.

### Step 2: the guard, currently failing

A synthetic page with **300 component instances**. Instrument `maskRawTextContent`,
`findOpenTag`, and `findMatchingClose` with counters. Assert bounds the current code fails.

Pick bounds that express the intent: the scan count should be roughly linear in instance count,
not quadratic. State the expected relationship in a comment so a future reader knows what the
number means.

### Step 3: index reuse

Guard improves. Harness still passes.

### Step 4: mask incrementalization

Small steps, harness after each. Write the falsification test first if you take the
once-per-pass option.

### Step 5: markers

### Step 6: cursor, with the fallback

Include a fixture where a template introduces a component **before** its own content, proving the
fallback fires and output is still correct.

### Step 7: verify end to end

```sh
yarn unit:all && yarn typecheck:all && yarn check:spelling
yarn pkg:build && yarn docs:build
```

- The docs output must be **byte-identical** to the step 0 baseline.
- Record the new build wall time against the baseline.
- Build **twice** and confirm output is still byte-identical between runs, so no cache introduced
  nondeterminism.

### Step 8: benchmark

`pkg/bench/transpile.bench.ts` exists. Extend it with the 300-instance case. **Record before and
after numbers** for the pull request description.

---

## Testing

**Unit:** the guard, the harness, and the fallback correctness cases.

**E2E:** no new fixtures needed. The existing suite across all four configs is the safety net for
a refactor this size, and running it is the point.

State explicitly that you added no E2E because the change is byte-neutral by construction, and
that the existing suite is the regression check. Then ask the user to run `yarn e2e:all`.

---

## Documentation

| File                                               | Change                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/transpilation-pipeline.md` | Update the loop description if its structure changed                                                              |
| `docs/content/internals/architecture.md`           | Any complexity notation that changed. **Prompt 01 converted `$O(1)$` to inline code spans; keep that formatting** |
| `docs/content/performance.md`                      | Only if the numbers materially improved. **Use the recorded before and after; do not invent benchmark claims**    |

No SKILL.md change is expected. **If none is needed, say so explicitly** rather than making a
token edit.

---

## Acceptance criteria

- [ ] The operation-count guard existed and failed before, and passes after.
- [ ] A 300-instance page no longer performs full-document scans proportional to the square of
      the instance count.
- [ ] The byte-identical harness passes at **every** step.
- [ ] `docs/dist` after this prompt is byte-identical to before it.
- [ ] Two consecutive docs builds remain byte-identical.
- [ ] The existing `MAX_SUBSTITUTIONS` guard still passes.
- [ ] If a cursor was added, the fallback fires correctly for an out-of-order substitution.
- [ ] If the once-per-pass mask option was taken, a falsification test justifies it.
- [ ] Before and after benchmark numbers are recorded.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The user has run `yarn e2e:all` and reported passing.

## Do not do

- **Do not change any output.** This prompt is byte-neutral.
- Do not convert function replacements to string replacements for speed. The out-of-memory bug
  they prevent is worse than any gain.
- Do not introduce an HTML AST parser.
- Do not touch CSS scoping or `attributesToReplace`. Prompts 35 and 36.
- Do not invent benchmark claims for the docs.
- Do not run Playwright or pre-push scripts.
