# 24: Deterministic instance IDs

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/names.ts`, `pkg/src/lib/processing.ts`, `pkg/src/lib/javascript.ts`.

---

## The problem

`names.ts#L47-L52`:

```ts
export const getUniqueId = (length: number): string => {
  if (length % 2 !== 0) length++;
  return randomBytes(length / 2).toString("hex");
};
```

`recursivelyTranspile` (`processing.ts#L396`, `#L423-L425`) calls `getUniqueId(8)` for every
component instance, and that value becomes part of every scoped `id` and `name`:
`bascik__my-card__<random>__title`.

Because the source is `crypto.randomBytes`, **the same source tree produces different output
bytes on every build.**

---

## Scope this accurately

**Verified fact.** `javascript.ts#L139`:

```ts
const scopeKey =
  attribute === "class" && deduplicateCss
    ? component.name
    : componentInstanceName;
```

Under the default `deduplicateCss: true`, **class names are already deterministic**. The random
instance ID reaches scoped `id` and `name` **only**.

So the blast radius is narrower than "every build differs entirely": it is every page containing
a component that scopes an `id` or a `name`. State this accurately in the docs rather than
overselling the fix.

It is still worth fixing:

- The output directory cannot be diffed between builds to review what actually changed.
- A deployed artifact cannot be verified against the commit that produced it.
- CI cannot assert that a refactor was output-neutral.
- Inline scripts contain instance IDs, so the CSP hashes from prompt 29 would change on every
  rebuild even when nothing changed.
- It contradicts the stated philosophy in `docs/content/faq.md`: long-term stability, and "the
  code that ships is the code you wrote". Random output is neither stable nor predictable.

---

## Required behavior

Derive the instance ID deterministically from **(page path, component name, ordinal occurrence
index on that page)**. Same uniqueness guarantee, reproducible output.

- Same source in, same bytes out, on any machine and any run.
- The ordinal is stable because `recursivelyTranspile` resolves components iteratively,
  first-match-first, in document order.
- **Per-page derivation** keeps this correct under `pipeline.workers`, since each page is
  transpiled independently and workers never share counter state.
- Two instances of the same component **on the same page** must receive different IDs.
- The same component at the same ordinal **on two different pages** must receive different IDs,
  so the page path must be part of the input.
- **Keep the output shape and length identical to today**, eight hexadecimal characters, so
  nothing downstream needs to change.

**Do not add a config option.** Deterministic output is strictly better; there is no use case
for opting back into randomness.

---

## Collision handling

Hash collisions at eight hexadecimal characters are unlikely but no longer impossible in the way
random generation made them.

Track the set of IDs issued **per page**. On a collision, extend or salt **deterministically**,
for example by appending the colliding ordinal, rather than falling back to randomness. **Never
silently emit a duplicate ID.**

---

## Do not change genuine randomness

`getUniqueId` is used **outside** component scoping. **Audit every call site before touching the
function.**

Prefer adding a separate, purpose-named function for instance IDs and leaving `getUniqueId`
alone where real randomness is wanted, such as TLS material and cache keys.

**Do not make `makeEtag` or any security-sensitive value deterministic.**

Enumerate every remaining genuine-randomness call site in a comment in the test file, so a
future change that touches one is caught in review.

Note that prompt 18 flagged `getUniqueId` rounding odd lengths up. That is a separate cosmetic
issue; do not conflate it with this change.

---

## TDD steps

### Step 1: the determinism test, first

In `processing.test.ts`:

```
"transpiling the same page twice produces byte-identical output"
```

**It must fail** because of the random instance IDs. This is your anchor.

### Steps 2 to 8

2. Two instances of one component on a page receive **different** IDs.
3. The same component at the same ordinal on two **different** pages receives different IDs.
4. Output is identical whether `pipeline.workers` is on or off.
5. Adding a component **earlier** on the page shifts later IDs. That is expected. Assert the new
   output is **stable across repeated runs**, not that IDs never move.
6. A **forced collision** is resolved deterministically, never randomly, and never emits a
   duplicate ID on one page.
7. The output shape is still eight hexadecimal characters.
8. `makeEtag` and every other genuine-randomness call site is untouched, with the enumeration
   comment in place.

## Testing

**Unit:** all of the above.

**E2E:** the strongest available proof is at the build level.

- `playwright.config.ts` (static build): add a check that builds the fixture site **twice** and
  asserts the output directories are byte-identical. If the harness cannot build twice, do it as
  a script-level test outside Playwright and say so.
- `playwright.dev.config.ts`: a component using scoped `id` and `name`, used twice, still
  behaves correctly. Determinism must not have broken uniqueness.
- The two server configs: no new tests. This is build-time. State that reasoning.

**Also verify end to end:** build the docs site twice and assert `docs/dist` is byte-identical.
That is the real proof, since the docs site is the largest real Bascik project available.

## Documentation

| File                                       | Change                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/internals/scoping-system.md` | Instance IDs are derived from page path, component name, and ordinal. Note that class names were already deterministic under the default config, so this affects `id` and `name` |
| `docs/content/faq.md`                      | "Why do two builds of the same source produce different output?" Now fixed, but searchable                                                                                       |
| `docs/content/deploying.md`                | Builds are reproducible, so output can be diffed and verified against a commit                                                                                                   |
| `docs/src/pages/assets/SKILL.md`           | Output is deterministic. Sync `create/assets/SKILL.md`                                                                                                                           |
| `docs/content/compatibility.md`            | **Required by repo policy** since a scoping behavior changed                                                                                                                     |

## Acceptance criteria

- [ ] The step-1 test failed before and passes after.
- [ ] Building the same source twice produces byte-identical output, **including `docs/dist`**.
- [ ] Instance IDs are unique per instance per page and stable across machines and runs.
- [ ] Worker and non-worker builds produce identical output.
- [ ] A forced collision resolves deterministically with no duplicate ID.
- [ ] The output shape is unchanged at eight hexadecimal characters.
- [ ] `makeEtag` and all other genuine-randomness call sites are untouched and enumerated.
- [ ] **No config option was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added; the user has run `yarn e2e:all`.
- [ ] Docs updated including `compatibility.md`; both SKILL.md copies in sync.

## Do not do

- Do not add a config toggle for random IDs.
- Do not make any security-sensitive value deterministic.
- Do not change `deepReadDir` ordering or duplicate component handling. **Prompt 25.**
- Do not fix `getUniqueId`'s odd-length rounding here.
- Do not run Playwright or pre-push scripts.
