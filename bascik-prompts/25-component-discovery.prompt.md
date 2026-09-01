# 25: Component discovery determinism

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/file-system.ts`, `pkg/src/lib/components.ts`.

---

## The problem

`deepReadDir` (`file-system.ts#L163-L178`) returns `readdir` order with **no sort**.

Combined with:

- component name derived as `basename.split(".")[0].toLowerCase()` (`components.ts#L177`), so
  `header.html` in two different subfolders, or `card.html` and `card.v2.html`, collapse to the
  same key
- the `reduce` in `listComponents` (`components.ts#L282-L290`) silently **last-wins**
- the length sort in `getFirstComponent` being unstable for equal-length names, which prompt 14
  addressed

**Which component definition wins can differ between machines and filesystems, with no
warning.**

Note that `resolveInlineStyles` **does** sort. The inconsistency is telling.

---

## Fix 1: sort the traversal

Sort `deepReadDir` output. **Locale-independent, byte-wise** comparison, not
`localeCompare`, which varies by environment and defeats the purpose.

Sort directory entries at each level so the flattened result is fully determined by the tree,
not by filesystem order.

---

## Fix 2: duplicate component names are an ERROR

**Decision, do not re-litigate.** Not a warning. An error.

Tag names come from the **filename only**, so subfolders do not create namespaces. Two files
producing the same tag is an ambiguity Bascik cannot resolve, and silently picking one produces
a site that differs by machine.

The message must name the tag and **both file paths**, and explain the naming rule:

```text
error: two component files both define the tag <card>
  src/components/marketing/card.html
  src/components/admin/card.html
  Component names come from the filename, so subfolders do not create separate
  namespaces. Rename one file, for example marketing-card.html.
```

If more than two collide, list all of them.

### Organizational subfolders remain supported

**Decision, do not re-litigate.** `card.html` inside `components/marketing/` still registers as
`<card>`. Only the **collision** is an error.

The docs will recommend staying flat, but the capability stays.

### Watch for the extension case

`card.html` and `card.v2.html` also collapse to `card`, because the name is
`split(".")[0]`. Decide whether that is a collision (it is) and make sure the error fires for
it, not just for the subfolder case.

Check how companion file resolution (`javascript.ts#L765-L780`) treats `card.v2.js`, so the
error message does not fire for a legitimate companion file pattern.

---

## Fix 3: stable ordering everywhere else

Audit for other places where iteration order affects output:

- `Object.keys` or `Map` iteration over the component list
- the `.sort((a,b) => b.length - a.length)` in `getFirstComponent`, which prompt 14 should have
  made stable; confirm
- CSS deduplication ordering
- the order components are emitted into the page `<style>` block

Anything that reaches output must be deterministic. Anything that does not can stay as-is, but
say which is which.

---

## TDD steps

Write each failing test first.

1. `deepReadDir` returns entries in byte-wise sorted order, for a tree with mixed-case names,
   numbers, and nested directories.
2. Two files producing the same tag name **error**, naming both paths.
3. Three or more colliding files list all of them.
4. `card.html` plus `card.v2.html` errors.
5. A legitimate companion file, `card.js` beside `card.html`, does **not** error.
6. A component in a subfolder still registers under its filename-derived tag.
7. Two components with **different** names in different subfolders both work.
8. The component list iteration order is stable across repeated runs with the same tree.
9. Equal-length component names sort deterministically.
10. Building the same source twice produces byte-identical output. This should already pass from
    prompt 24; confirm it still does after the sorting change.

## Testing

**Unit:** all of the above, using isolated temp directories with controlled filesystem ordering
where possible.

**E2E:**

- `playwright.config.ts` (static build): a fixture with components in subfolders builds and
  renders correctly, proving organizational nesting still works.
- `playwright.dev.config.ts`: same, plus adding a component in a subfolder at runtime is picked
  up.
- The two server configs: no new tests. Build-time discovery. State that reasoning.

Add a **negative** build test: a fixture with a deliberate name collision fails the build with
the expected message. If the E2E harness cannot assert a build failure, cover it at the unit
level and say so.

## Documentation

| File                                     | Change                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/components.md`             | Tag names come from the filename. Subfolders are supported for organization but do not namespace. **Duplicate names are an error.** Add an aside recommending a flat directory unless there is a real organizational need |
| `docs/content/faq.md`                    | "Can I organize components into subfolders?" with the naming rule and the flat recommendation. Also: "What happens if two components have the same name?"                                                                 |
| `docs/content/internals/architecture.md` | Discovery is sorted, so the component list is deterministic                                                                                                                                                               |
| `docs/src/pages/assets/SKILL.md`         | Subfolders allowed, filename determines the tag, duplicates error. **This matters for prompt 57's `bascik add`**, which must check for collisions before copying. Sync `create/assets/SKILL.md`                           |
| `docs/content/compatibility.md`          | **Required by repo policy** if the change is user-visible. It is: a previously-silent condition is now an error                                                                                                           |

## Acceptance criteria

- [ ] All ten tests failed before their fixes and pass after.
- [ ] `deepReadDir` output is byte-wise sorted at every level.
- [ ] Duplicate tag names **error**, naming every colliding path and explaining the rule.
- [ ] The `card.v2.html` case is covered and a legitimate companion file does not false-positive.
- [ ] Organizational subfolders still work.
- [ ] Every ordering that reaches output is deterministic; the audit is recorded.
- [ ] Two builds of the same source remain byte-identical.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` succeeds. If the docs site has a latent collision, that is a real find;
      fix the docs site rather than weakening the check.
- [ ] E2E added; the user has run `yarn e2e:all`.
- [ ] Docs updated including the flat-directory aside; both SKILL.md copies in sync.

## Do not do

- Do not add support for multiple component directories. Explicitly rejected.
- Do not namespace components by folder. Tag names come from the filename.
- Do not downgrade the duplicate error to a warning.
- Do not change instance ID derivation. Prompt 24.
- Do not run Playwright or pre-push scripts.
