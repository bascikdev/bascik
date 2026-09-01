# 51: `bascik --check` validations

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/check.ts`, plus reading the validation from prompt 05.

**Depends on prompt 50**, which built the findings model. Add every check below as a finding in
that model; do not print directly.

---

## The claim that has never been true

The `--help` text has always said `--check` validates "pages, components, **config**"
(`cli.ts#L124`).

**It has never inspected a single config key.**

Prompt 05 built a real validation pass with actionable errors. **Wire it in here** so the claim
becomes true. That is the single highest-value addition in this prompt: a config typo currently
survives until it causes a confusing runtime failure.

---

## The checks to add

| Check                                                     | Severity | Why it matters                                                                                                                            |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Config validation from prompt 05**                      | error    | The flag has always advertised it                                                                                                         |
| Site URL present when a feature requires it               | error    | Prompt 04 made this a hard build failure; catching it in `--check` is faster feedback                                                     |
| Duplicate component names                                 | error    | Prompt 25 made this a build error. Report it here with **both paths** so it is caught before a build                                      |
| **Circular component references**                         | error    | `<a-card>` containing `<a-card>` is currently discovered only as an **infinite loop at build time**, which is a miserable way to find out |
| Unknown `data-bascik-*` attributes                        | warning  | A typo such as `data-bascik-props` is **silently ignored** today. List the known set in the message                                       |
| `data-bascik-build` and `data-bascik-server` on one tag   | error    | Documented as forbidden, unchecked                                                                                                        |
| Duplicate route resolution                                | error    | Prompt 30 added detection at build time; surface it here                                                                                  |
| API routes with no recognized method export               | error    | Prompt 49 specified this                                                                                                                  |
| Two API route files resolving to one URL                  | error    | Prompt 49 specified this                                                                                                                  |
| A method-looking export with wrong casing (`Post`, `get`) | warning  | Prompt 49 specified this                                                                                                                  |
| `pipeline.exec[].script` exists                           | error    | Currently a spawn error mid-build                                                                                                         |
| `pipeline.watchPaths` entries exist                       | warning  | A wrong path **silently watches nothing**                                                                                                 |
| `assets.inlineStyles` entries exist                       | warning  | Same                                                                                                                                      |
| TLS key and certificate readable when enabled             | error    | Currently a raw fs error at boot                                                                                                          |
| `directory.pages` exists and is non-empty                 | error    | Prompt 12 made this a build error; catch it earlier                                                                                       |
| `directory.public` exists when set                        | warning  | Silently copies nothing                                                                                                                   |
| Component `<style>` above HTML and `<script>` below       | warning  | A documented convention with **no enforcement**                                                                                           |
| Missing required props on a component usage               | warning  | **Only if cheaply determinable.** Do not build a type system                                                                              |

If a check is already an error at build time, `--check` and the build **must agree on severity**.
Add a test for each duplicated check asserting they agree, so the two cannot drift.

---

## Circular references deserve care

This is the check most likely to be subtly wrong.

A cycle can be indirect: `a` uses `b`, `b` uses `c`, `c` uses `a`. Detect through the full graph,
not just self-reference.

A component referencing itself **inside a `scoping.preserve` region or a `data-bascik-preserve`
subtree** is not a cycle, because it will not be transpiled. Respect the preserve rules from
prompt 19.

A component tag inside a `<script>` string is not a reference. `check.ts#L28-L59` already strips
those regions; reuse that logic rather than writing a second stripper.

Report the **full cycle path** in the message, not just "a cycle exists".

---

## Do not build a type system

The missing-props check is the one that can quietly become enormous.

A cheap version: if a component's template contains `data-bascik-prop-x` and **no** usage
anywhere supplies `x`, warn. That is a whole-project analysis over data already collected.

Anything requiring type inference, control flow, or evaluation is out of scope. **If the cheap
version proves noisy, drop the check and say so** rather than making it clever.

---

## TDD steps

Write each failing test first. One test per row, asserting the finding's category, severity,
message content, and location.

Then the cross-cutting ones:

1. **Config validation runs**, so a fixture with a bad `http.port` is reported by `--check`.
2. `--check` and the build **agree on severity** for every duplicated check.
3. An **indirect** three-component cycle is detected, with the full path in the message.
4. A self-reference inside a preserved region is **not** reported.
5. A component tag inside a `<script>` string is **not** counted as a reference.
6. Every check contributes to the exit code per prompt 50's rules, and `--strict` promotes the
   warnings.
7. `--json` includes the new findings in the documented schema.
8. A clean project reports **nothing** and exits 0.

Test 8 matters. A checker that always finds something is a checker people disable.

## Testing

**Unit:** all of the above.

**E2E:** **none.** `--check` produces no served output and no build artifact. **State that
reasoning explicitly.**

**Verification instead:**

- Run `bascik --check` against the **docs site**. It must pass. Report anything it finds; a
  genuine find is a good outcome, and the docs site should be fixed rather than the check
  weakened.
- Run it against `pkg/e2e/`, which is a smaller and stranger project and will exercise different
  paths.
- Deliberately break each checked condition in a scratch fixture and confirm the message is
  actionable without opening the docs.

## Documentation

| File                                    | Change                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/cli.md`                   | **A table of every check `--check` performs**, with its severity. This is the reference someone reads when a check fires             |
| `docs/content/testing/linting.md`       | Which checks are worth gating CI on, and which are advisory                                                                          |
| `docs/content/components.md`            | The `<style>` above, `<script>` below convention is now checked                                                                      |
| `docs/content/faq.md`                   | "What does `bascik --check` actually check?"                                                                                         |
| `docs/content/internals/diagnostics.md` | Extend prompt 50's extension-point documentation with the new checks as worked examples                                              |
| `docs/src/pages/assets/SKILL.md`        | `--check` validates config, catches circular references, and flags unknown `data-bascik-*` attributes. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] Every row of the table has a failing-first test that now passes.
- [ ] **Config validation runs**, so the `--help` claim is finally true.
- [ ] `--check` and the build agree on severity for every duplicated check, with a test each.
- [ ] **Indirect cycles are detected** with the full path reported.
- [ ] Preserved regions and script strings are correctly excluded from reference counting.
- [ ] Unknown `data-bascik-*` attributes warn, with the known set listed.
- [ ] Every finding flows through prompt 50's model and appears in `--json`.
- [ ] **A clean project reports nothing and exits 0.**
- [ ] The missing-props check is cheap, or was dropped with a stated reason.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `bascik --check` passes against both the docs site and `pkg/e2e/`, and you have reported
      what it found.
- [ ] Docs updated with the full check table; both SKILL.md copies in sync.

## Do not do

- Do not build a type system for prop checking.
- Do not print directly. Use prompt 50's findings model.
- Do not write a second content-stripper. Reuse `check.ts#L28-L59`.
- Do not make a check an error in `--check` that is a warning at build time, or the reverse.
- Do not run Playwright or pre-push scripts.
