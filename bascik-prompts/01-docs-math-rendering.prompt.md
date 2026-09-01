# 01: Fix literal math rendering in the docs

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/content/**/*.md` only. No package code changes.

---

## The problem

`renderMd` in `docs/src/lib/md-renderer.ts` applies exactly two transformations: fenced code
blocks become `<code-block>` components, and blockquotes become callouts. **There is no KaTeX
in the docs site.**

So every `$...$` written in a content file ships to the reader as literal dollar signs. A
sentence reading "reduces Node child process spawns from $N$ scripts to 1" renders with the
dollar signs visible.

## Known occurrences

Confirmed by inspection. **Audit for more; this list may be incomplete.**

| File                                               | Line | Current                          | Intent                                   |
| -------------------------------------------------- | ---- | -------------------------------- | ---------------------------------------- |
| `docs/content/internals/transpilation-pipeline.md` | 54   | `$N$ scripts`                    | plain prose                              |
| `docs/content/compatibility.md`                    | 50   | `$\to$`                          | an arrow                                 |
| `docs/content/compatibility.md`                    | 76   | `$(0, 0, 1)$`, `$(0, 1, 0)$`     | CSS specificity tuples                   |
| `docs/content/compatibility.md`                    | 220  | `$W/"\text{mtime}-\text{size}"$` | an ETag format string                    |
| `docs/content/internals/architecture.md`           | 131  | `$O(1)$`                         | complexity                               |
| `docs/content/internals/minification.md`           | 57   | `$O(1)$`                         | complexity                               |
| `docs/content/internals/minification.md`           | 163  | `$O(1)$`                         | complexity, **inside a section heading** |
| `docs/content/internals/server.md`                 | 70   | `$O(1)$ exact lookups`           | complexity                               |

## Required fixes

- Prose values such as `$N$` become plain text.
- Complexity notation becomes an inline code span: `` `O(1)` ``.
- Specificity tuples become inline code spans: `` `(0, 0, 1)` ``.
- The ETag format becomes an inline code span containing the literal string it represents.
- An arrow becomes the word "becomes", or a plain `->`. Do not use a Unicode arrow if the rest
  of the docs do not.

Note the minification heading: changing a heading changes its anchor. Grep for links to that
anchor and update them.

## The regression guard

Add a unit test under `docs/` that:

1. Reads every file under `docs/content/`.
2. Strips fenced code blocks and inline code spans.
3. Fails if a `$...$` pair remains, naming the file, the line, and the matched text.

Write this test **first**. It must fail listing all the occurrences above, and that failure
list is your work queue. If it lists fewer than the table above, your stripping logic is wrong.
If it lists more, the table was incomplete and you found the rest.

## Also check

While scanning, look for other rendering artifacts and fix any you find:

- Stray unrendered backslashes such as `\_`.
- Em-dashes, which the repo forbids.
- Unbalanced or orphaned asterisks.

Only fix what is genuinely wrong. Do not reflow prose.

## Testing

**Unit:** the guard test described above.

**E2E:** none. This changes rendered text only and no E2E config exercises docs prose. State
that reasoning rather than skipping silently.

**Verification:** run `yarn docs:build` and read the changed pages in the built output.
Confirm the affected sentences read correctly and the minification heading still links.

## Documentation

This prompt _is_ documentation work. No SKILL.md change.

## Acceptance criteria

- [ ] The guard test existed before any fix and failed, listing every occurrence.
- [ ] No `$...$` remains outside fenced code blocks or inline code spans in `docs/content/`.
- [ ] The changed minification heading's anchor links still resolve.
- [ ] `yarn docs:build` succeeds and the changed pages render correctly.
- [ ] `yarn check:spelling` passes.
- [ ] No package source was modified.

## Do not do

- Do not add KaTeX to the docs site.
- Do not restructure navigation, rename sections, or change any page h1. Those are prompts 53
  and 54.
- Do not reflow or rewrite prose beyond the specific fixes.
- Do not run pre-push scripts.
