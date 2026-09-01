# 50: `bascik --check` output

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/check.ts`, `pkg/src/lib/cli.ts`.

This prompt restructures **how findings are produced and presented**. Prompt 51 adds the
additional checks. Doing them separately keeps each small and means prompt 51 plugs into a
finished model rather than reshaping one.

---

## What `--check` does today

`check.ts#L110-L186` does exactly two things:

1. A hyphenated tag in a page or component file with **no matching component file**: **error**,
   exit 1.
2. A component file **never referenced anywhere**: warning, exit 0.

That is all. Content inside `<script>`, `<style>`, `<textarea>`, and the configured preserve tags
is stripped first (`#L28-L59`), and HTML comments at `#L68`.

---

## Problem 1: unknown hyphenated tags are errors

**Every real third-party web component fails**: `<model-viewer>`, `<ion-icon>`, `<lite-youtube>`,
`<swiper-slide>`. There is no allowlist and no escape hatch, so `--check` **exits 1 on a
perfectly valid site**.

**Decision, do not re-litigate:** unknown hyphenated tags become a **warning**, not an error.

**Rejected alternative:** a config allowlist such as `externalElements: ['model-viewer']`. It is
permanent API surface for something the severity change solves, and it would need maintaining as
the web component ecosystem grows. The structured output below tells the user what Bascik could
not resolve; that is enough.

---

## Problem 2: one build script disables the unused-component check entirely

`#L145-L149`: a **single** page containing `data-bascik-build` marks **every** component as used
project-wide.

On any realistic site this makes check number two **permanently inert**.

### Fix

**Narrow the exemption.** Suppress the unused warning only for components whose name appears as a
string literal somewhere in a build script's source.

That is still a heuristic, but a **targeted** one, and it restores the check's value on sites
that use build scripts.

If that proves unreliable, the fallback is to keep the warning and add a note in the output
explaining that a build script may reference it. **Do not go back to disabling the check
project-wide.**

---

## The findings model

**Refactor `checkProject` to produce a data structure**, not to print.

Every subsequent step tests the **data**, and one thin layer formats it. This makes `--json`
nearly free, makes the human formatter independently testable, and gives prompt 51 a clean place
to add checks.

A finding needs at minimum: a **category**, a **severity**, a **message**, a list of
**locations** (file plus line where known), and an optional **suggestion**.

`checkProject` currently writes human prose directly to stdout and stderr (`#L155-L184`), which
is why it is unusable as a CI gate.

---

## The human output

Group by **category**, not by file. Show **every** location for a repeated finding, not just the
first. Explain **why** each category exists, briefly, so the output teaches.

```text
bascik --check

Components with no matching file (3)
  These are either typos, or third-party web components. Bascik does not
  transpile them; they are passed through to the browser unchanged.

  <model-viewer>     src/pages/gallery.html:42
  <ion-icon>         src/components/nav/nav.html:8, src/pages/index.html:14
  <my-crd>           src/pages/about.html:31
                     did you mean <my-card>?

Unused components (1)
  Defined but never referenced. Safe to delete, or referenced only from a
  build script, which this check cannot always see.

  src/components/legacy-banner/legacy-banner.html

✗ 0 errors, 4 warnings
```

**Suggestions** use a simple edit-distance check against the known name set. Do not add a
dependency for it.

**The exit code derives from the error count only.** Warnings do not fail the build unless
`--strict` is passed.

---

## `--json`

A **stable, documented schema** for CI consumption. Document the schema in the docs so it can be
relied on.

Follow prompt 07's CLI conventions for the flag.

## `--strict`

Treat warnings as errors, changing the exit code. Without it, unused components and unmatched
tags do not fail the build.

This is how someone who **wants** the old strictness gets it, which is the honest answer to
downgrading the severity.

---

## TDD steps

Write each failing test first.

1. **Prove `--check` is currently unusable.** A fixture site containing a `<model-viewer>` tag and
   a build script. Assert that today it **exits 1** and reports **zero** unused components. Both
   are the wrong answer. These are your anchors.
2. `checkProject` returns a findings **data structure** and prints nothing itself.
3. Unknown hyphenated tags are **warnings**; the fixture site exits **0**.
4. Findings are grouped by category, with **every** location listed.
5. A near-miss name produces a suggestion; an unrelated name does not.
6. The exit code derives from errors only.
7. `--strict` promotes warnings to errors and changes the exit code.
8. `--json` emits the documented schema, and it parses.
9. `--json` and the human formatter are driven by the **same** findings data.
10. **The narrowed build-script exemption:** an unused component **is** reported on a site that
    has build scripts, which is the whole point.
11. A component genuinely referenced only from a build script is **not** reported.

## Testing

**Unit:** all of the above. `--check` is a pure analysis over files, so nearly everything belongs
here.

**E2E:** **none.** `--check` produces no served output and no build artifact.

**State that reasoning explicitly** rather than skipping silently.

**Verification instead:** run `bascik --check` against the **docs site**, which is the largest
real Bascik project available. It must pass, and its output must be **genuinely useful**. If it
reports nothing, the checks are too weak; if it reports noise, the severities are wrong. Report
what it found.

## Documentation

| File                                    | Change                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/cli.md`                   | The new output format, `--json` **with its schema**, and `--strict`                                                                                                                  |
| `docs/content/testing/linting.md`       | `--check` in CI, using `--json` and `--strict`                                                                                                                                       |
| `docs/content/internals/diagnostics.md` | The findings model and how a new check is added, so prompt 51 has a documented extension point                                                                                       |
| `docs/content/faq.md`                   | **Update the entry prompt 02 added** about referencing a nonexistent component: it is now a **warning**, not an error. Add: "Why does `--check` list my third-party web components?" |
| `docs/src/pages/assets/SKILL.md`        | `--check` no longer fails on third-party web components. Sync `create/assets/SKILL.md`                                                                                               |

## Acceptance criteria

- [ ] The step-1 anchors failed before and pass after.
- [ ] Unknown hyphenated tags are **warnings**; a site using `<model-viewer>` exits 0.
- [ ] `checkProject` returns findings data and does not print.
- [ ] Output is sectioned, shows every location, explains each category, and suggests near
      matches.
- [ ] The exit code derives from errors only; `--strict` promotes warnings.
- [ ] `--json` emits a documented, stable schema, driven by the same data as the human output.
- [ ] **The build-script exemption is narrowed**, and unused components are reported on a site
      with build scripts.
- [ ] **No `externalElements` config option was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `bascik --check` against the docs site passes and produces useful output, and you have
      reported what it found.
- [ ] Prompt 02's FAQ entry is updated; both SKILL.md copies in sync.

## Do not do

- Do not add a config allowlist for external elements.
- Do not disable the unused-component check project-wide.
- Do not add the new validations. **Prompt 51.**
- Do not add a dependency for edit distance.
- Do not run Playwright or pre-push scripts.
