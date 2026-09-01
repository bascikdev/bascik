# 57: `bascik add`

Read `.github/prompts/00-README.md` first.

**Scope:** a new `pkg/src/lib/add.ts`, `pkg/src/lib/cli.ts`, plus docs.

**Depends on prompt 25**, which made duplicate component names a build error, and **prompt 07**,
which unified CLI parsing.

---

## The command

```sh
bascik add @acme/ui           # every component in the package
bascik add @acme/ui/card      # one component
```

**Decision, do not re-litigate:** this is a **copy-in model**, the shadcn approach, **not a
resolved dependency**.

Files are copied into the project's components directory and **belong to the project**. They are
committed, editable, and diffable. Bascik does not resolve them from `node_modules` at build time
and does not know at build time that they came from anywhere.

**Rejected alternative:** resolving components from `node_modules` during the build. It would
require a resolution layer in the transpiler, make the build depend on the install state, and
make a component's source invisible to the person debugging it. The copy-in model keeps the
build exactly as simple as it is today, which is the property worth protecting.

---

## The package contract

A package advertises components with a **`bascik.components`** field in its `package.json`
pointing at a directory.

Keep the contract **minimal**. Every field added here is a field every publisher must understand.
A directory pointer is enough to start; more can be added later, and removing a field is harder
than adding one.

Validate the field's presence and shape, and **fail with a message that tells the publisher what
to add**, since the person seeing that error is usually the consumer, not the publisher.

---

## Naming and collisions

**This is the critical correctness requirement.**

Prompt 25 made **duplicate component names a build error**. Component names are derived from
filenames.

So `bascik add` **must reuse `listComponents`' exact name-derivation logic** to compute the name a
copied file will produce, and **check it against the existing project before writing anything**.

If it collides, **refuse with both paths named** and suggest renaming. A copy that silently
breaks the next build is the single worst outcome this command can produce.

Do not reimplement the derivation. Import it. A second implementation will drift from the first,
and the drift will surface as a build error nobody can explain.

---

## The lockfile

Record what was copied: the package, the version, the file list, and a **hash per file**.

The hash is what makes the command safe. On a re-add:

- File unchanged since it was copied: overwrite freely.
- File **locally modified**: **refuse without `--force`**, naming the file.

Someone who customized a copied component and then re-adds must not lose that work silently.
Overwriting local edits with no warning is the failure mode that makes people distrust a tool.

Choose a location consistent with the rest of Bascik's generated state. Prompts 26, 27, and 29 put
build artifacts under `dist/.bascik/`, but **this is not a build artifact**: it is project state
that must be **committed**. Put it somewhere committed, and say why in the docs.

---

## Behavior details

| Concern              | Requirement                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Non-TTY**          | Must work in CI with no prompt. `--force` and `--yes` cover the interactive decisions. **Never block on stdin when stdin is not a TTY**                                                                |
| **Dry run**          | `--dry-run` lists what would be written and changes nothing                                                                                                                                            |
| **Where files land** | The configured components directory. Subfolders are supported per prompt 25                                                                                                                            |
| **Path safety**      | A package could name a file `../../etc/x`. **Resolve and verify every destination stays inside the components directory.** Prompt 09 fixed a source-deletion bug from exactly this class of assumption |
| **Partial failure**  | If the third of five files fails, **do not leave three copied and no lockfile entry.** Either write all and record, or write none                                                                      |
| **Missing package**  | A clear message: install it first. Do not install it                                                                                                                                                   |

---

## Non-goals

State these in the docs so nobody expects them.

- No registry, index, or discovery. You install the package yourself.
- No `bascik remove`. The files are yours; delete them.
- No `bascik update`. Re-run `add`; the lockfile makes that safe.
- **No `node_modules` resolution at build time.**
- No dependency installation.
- **No file transformation.** Files are copied verbatim. A transform layer means the copied
  component differs from the published one, and debugging that is worse than any convenience it
  buys.

---

## TDD steps

Write each failing test first.

1. `bascik add @acme/ui` copies every component from a fixture package.
2. `bascik add @acme/ui/card` copies one.
3. A package with no `bascik.components` field fails with a **publisher-actionable** message.
4. A malformed field fails clearly.
5. A package that is not installed fails with an install hint.
6. **A name collision with an existing component refuses, naming both paths**, and writes nothing.
7. The collision check uses `listComponents`' derivation, proven by a subfolder case where naive
   basename logic would disagree.
8. The lockfile records package, version, files, and per-file hashes.
9. Re-adding an **unmodified** file overwrites cleanly.
10. Re-adding a **locally modified** file **refuses**, naming it.
11. `--force` overwrites a modified file.
12. `--dry-run` writes nothing and lists everything.
13. **A `../` in a package file path is rejected** and nothing is written outside the components
    directory.
14. **A mid-copy failure leaves no partial state.**
15. Non-TTY execution never blocks on stdin.
16. After a successful add, **`bascik --build` succeeds** and the copied component renders.

Test 16 is the one that proves the whole thing works. Everything else is a precondition for it.

## Testing

**Unit:** all of the above. Use a **fixture package on disk**, not a mock, so the `package.json`
contract is genuinely exercised.

**E2E:**

- `playwright.config.ts` (static build): add a component, build, and assert it **renders in the
  output**. This proves the copy integrates with the real pipeline rather than merely landing on
  disk.
- `playwright.dev.config.ts`: **add a component while the dev server is running** and confirm the
  watcher picks it up. Prompt 44 fixed incremental additions; this exercises that fix.
- The two server configs: **skip.** `bascik add` is a build-time authoring command with no runtime
  behavior, and serving a copied component is identical to serving any other. **State that
  reasoning.**

## Documentation

| File                                           | Change                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/how-to/publishing-components.md` | **New page.** How to publish a component package: the `bascik.components` field, layout, versioning, and that files are copied verbatim so they must not assume a build step |
| `docs/content/how-to/sharing-components.md`    | Prompt 56's guide C. Make `bascik add` the primary path, keeping the manual approaches as alternatives                                                                       |
| `docs/content/cli.md`                          | The command, its flags, and the lockfile                                                                                                                                     |
| `docs/content/components.md`                   | Cross-link                                                                                                                                                                   |
| `docs/content/faq.md`                          | "Is there a component registry?" answering no and why, and "What happens if I edit a component I added?"                                                                     |
| `docs/src/pages/assets/SKILL.md`               | `bascik add` copies files in; they are **project files**, not dependencies. The name-collision error. Sync `create/assets/SKILL.md`                                          |

Both new pages follow prompt 53's h1 convention and need nav and sidebar entries.

## Acceptance criteria

- [ ] All sixteen tests failed first and pass now.
- [ ] Whole-package and single-component forms both work.
- [ ] The `bascik.components` contract is validated with publisher-actionable errors.
- [ ] **The collision check imports `listComponents`' derivation** and is proven correct on a
      subfolder case.
- [ ] The lockfile records per-file hashes and is stored somewhere **committed**, with the reason
      documented.
- [ ] **A locally modified file is never overwritten without `--force`.**
- [ ] `--dry-run` and non-TTY execution both behave.
- [ ] **Path traversal in a package file path is rejected.**
- [ ] **A mid-copy failure leaves no partial state.**
- [ ] **`bascik --build` succeeds after an add**, and the component renders.
- [ ] **No build-time `node_modules` resolution was added.**
- [ ] **No file transformation was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to the static and dev configs; the server skips are justified. The user has run
      `yarn e2e:all`.
- [ ] Both new docs pages exist, are in nav and the sidebar, and follow the naming convention.
- [ ] Both SKILL.md copies in sync.

## Do not do

- Do not resolve components from `node_modules` at build time.
- Do not transform copied files.
- Do not build a registry, `remove`, or `update`.
- Do not install packages.
- Do not reimplement component name derivation.
- Do not overwrite modified files without `--force`.
- Do not run Playwright or pre-push scripts.
