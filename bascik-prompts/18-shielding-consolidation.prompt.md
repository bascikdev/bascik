# 18: Consolidate the shielding implementations

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/javascript.ts`, `styles.ts`, `components.ts`, `html-minifier.ts`,
`check.ts`, `names.ts`.

**This prompt is a prerequisite for prompt 19**, which adds `data-bascik-preserve` and must not
become a sixth mechanism.

---

## The problem

There are **five independent implementations** of "hide raw-text element contents while
scanning", using **three different sentinel formats**:

| Implementation                         | File                         | Sentinel           |
| -------------------------------------- | ---------------------------- | ------------------ |
| `preserveElementContents`              | `javascript.ts#L150-L185`    | `\x00BSKIP<n>\x00` |
| `extractInlineStyles`                  | `styles.ts`                  | `\x00BSKIP<n>\x00` |
| `maskRawTextContent`                   | `components.ts#L316-L345`    | its own            |
| the preserve block inside `minifyHtml` | `html-minifier.ts#L110-L118` | its own            |
| `stripElementContents`                 | `check.ts#L40-L57`           | its own            |

### Two of them collide

`preserveElementContents` and `extractInlineStyles` use the **identical**
`\x00BSKIP<n>\x00` format with **independent counters**, and `extractInlineStyles` is called
**while the outer sentinels are live** (`javascript.ts#L616-L622`).

With the default `scoping.preserve: ["code"]` the index spaces coincidentally align and it is a
no-op. With `scoping.preserve: ["pre","code"]` the indices are swapped and the inner restore
rewrites the outer sentinels, so **`<pre>` and `<code>` contents get swapped**.

Latent, config-dependent, and untested. `javascript.test.ts#L919-L947` tests nested
`pre > code` but always with an ordering where the indices happen to align.

---

## Required

**One shielding utility. One sentinel namespace. One counter.**

Requirements:

- Nested and interleaved shields round-trip correctly.
- The sentinel format must be impossible to produce from user input. Document why the chosen
  format is safe.
- Restoration is order-independent, or the order is enforced by the API rather than by the
  caller remembering.
- Two shields active at once cannot see each other's sentinels.

### `maskRawTextContent` keeps its distinct semantic

It is **temporary**: it blanks content during a scan and the mask is **discarded**, never
restored. It is correctly hardcoded and must stay internal.

But it should use the **shared sentinel namespace** so the two can never collide. Keep the
semantic, share the namespace.

### Document the pair

`maskRawTextContent` and `scoping.preserve` are adjacent and easy to confuse. Prompt 02 added
guidance to `SKILL.md`; make sure the code comments agree, one line each, and that the
distinction is discoverable from the source.

---

## Also in these files

### Dead and buggy code

| Item                                          | Location                                                                                        | Action                                                                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getTagContents`                              | `components.ts#L419`                                                                            | Dead, referenced only by tests. It duplicates `getTag` but with a naive lazy `([\s\S]*?)` pairing that is **not depth-aware**, so it is also inconsistent with the function that replaced it. Delete |
| `getCssClasses`                               | `styles.ts#L202`                                                                                | Dead, tests only. Also buggy: the character class `[\w\s\:;#-_]` contains an unintended range `#`-`_` (0x23 to 0x5F) covering digits, uppercase letters, `<`, `>`, and `@`. Delete                   |
| `obfuscateAttributeName`                      | `names.ts#L45`                                                                                  | Dead alias for `minifyAttributeName`. Tests and one `vi.mock` still reference it. Delete and update them                                                                                             |
| `ComponentScriptsResult.scripts`              | `javascript.ts#L780-L830`                                                                       | Computed as string-joined `<script>` blocks but **never consumed**; `listComponents` uses only `scriptMap`. Wasted work per component. Delete                                                        |
| `resolveCssImports` / `resolveCssImportsSync` | `styles.ts#L474-L620`                                                                           | About 55 lines duplicated verbatim except `await readFile` versus `readFileSync`. Factor out the shared logic                                                                                        |
| Re-export shims                               | `components.ts#L542`, `javascript.ts` `export { minifyJs }`, `styles.ts` `export { minifyCss }` | Duplicate public surface. `extractScriptTags` is imported from both `components.ts` and `html-minifier.ts` in different test files. Pick one home each                                               |

### String replacements that must become function replacements

Most of the pipeline correctly uses function replacements or index splicing. These sites still
interpolate user-derived text into a **replacement string**:

| Site                                                | Replacement                                     | Risk                                                                                        |
| --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `javascript.ts#L470-L500` `rewriteInSelectorString` | `` `${prefix}${obfuscatedAttributeName}` ``     | a class or id containing `$&` or `$1`                                                       |
| `javascript.ts#L527-L560` `classTokenAllRegex`      | `` `$1${obfuscatedAttributeName}$1` ``          | same                                                                                        |
| `javascript.ts#L578-L595` `classNameTokenRegex`     | `obfuscatedAttributeName`                       | same                                                                                        |
| `styles.ts#L228-L234` `prefixKeyframes`             | `scoped`                                        | a keyframe or component name                                                                |
| `styles.ts#L525` and `#L595`                        | `` `/* @import "${parsed.url}" not found */` `` | **`parsed.url` is raw user input**, and `@import "$&.css"` re-injects the matched statement |

With `minify.identifiers: true` the first four are hashed and safe. With it off, which is the
**dev default**, they are not. **The `@import` case is unconditional.**

Convert all five. The existing "Resilience to regex replacement patterns" suite at
`styles.test.ts#L1628` does **not** cover the `resolveCssImports` failure branch; add it.

### `scopeLayerNames` word-boundary bug

`styles.ts#L735-L745` uses `'(?<=@layer[^{;]*)\\b' + name + '\\b'`. Layer names are matched with
`[\w-]+`, so a leading-hyphen name such as `--utils` makes `\b-` unmatchable and the layer is
**silently left unscoped**. `name` is also unescaped, which is safe only because of the source
character set. Fix both.

### `getUniqueId` rounds odd lengths up

`names.ts#L47-L52`: `getUniqueId(7)` returns 8 characters. Harmless but surprising. Document or
fix. Note that prompt 24 replaces its use for instance IDs, so do not change its randomness
here.

---

## TDD steps

Write each failing test first.

1. **The collision test that does not exist today:** `scoping.preserve: ["pre","code"]` with an
   inline `<style>` present, asserting **no content swap** between `<pre>` and `<code>`.
2. Nested shields round-trip: a shielded region inside another shielded region.
3. Interleaved shields: two independent shield operations active at once do not see each
   other's sentinels.
4. A user input containing a literal sentinel-lookalike string is not mistaken for a sentinel.
5. `maskRawTextContent` still discards rather than restores, and uses the shared namespace.
6. Each of the five string replacements survives a value containing `$&`, `$1`, and `` $` ``.
7. `@import "$&.css"` that fails to resolve does not re-inject the matched statement.
8. A `--utils` layer name is scoped.
9. Each deleted item is gone and `yarn typecheck:all` is clean.

## Testing

**Unit:** all of the above.

**E2E:** add a fixture component with `scoping.preserve: ["pre","code"]` configured, containing
both a `<pre>` and a `<code>` block with distinguishable content, plus an inline `<style>`.

- `playwright.config.ts` (static build): the `<pre>` and `<code>` contents are **not swapped**.
- `playwright.dev.config.ts`: same, proving parity.
- The two server configs: no new tests. Build-time only. State that reasoning.

This is a config-dependent bug, so the fixture must actually set the non-default config value.

## Documentation

| File                                       | Change                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`            | `scoping.preserve` accepts multiple tags safely                                                                                  |
| `docs/content/compatibility.md`            | **Required by repo policy** if any scoping behavior changed. The multi-tag preserve fix and the `--utils` layer fix both qualify |
| `docs/content/internals/scoping-system.md` | One shielding utility; the distinction from the internal mask                                                                    |
| `docs/src/pages/assets/SKILL.md`           | Confirm the mask-versus-preserve wording prompt 02 added is still accurate. Sync `create/assets/SKILL.md`                        |

## Acceptance criteria

- [ ] All nine tests failed before their fixes and pass after.
- [ ] **One** shielding utility, one sentinel namespace, one counter.
- [ ] `scoping.preserve: ["pre","code"]` does not swap contents.
- [ ] Nested and interleaved shields round-trip; a sentinel-lookalike input is safe.
- [ ] `maskRawTextContent` keeps its discard semantic and shares the namespace.
- [ ] Every item in the dead-code table is deleted or factored.
- [ ] All five string replacements are now function replacements, including the unconditional
      `@import` case.
- [ ] A leading-hyphen layer name is scoped.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` succeeds.
- [ ] E2E added with the non-default config; the user has run `yarn e2e:all`.

## Do not do

- Do not add `data-bascik-preserve`. Prompt 19 builds on this utility.
- Do not change `getUniqueId`'s randomness. Prompt 24.
- Do not optimize anything. Prompts 34 to 36.
- Do not run Playwright or pre-push scripts.
