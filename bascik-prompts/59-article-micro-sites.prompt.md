# 59: Article, micro sites

Read `.github/prompts/00-README.md` first.

**Scope:** one new article at `docs/content/articles/micro-sites.md` and its page shell.

**Depends on prompt 58** for the section and **prompt 56** for the how-to guide this article
sits beside.

**No package code changes.**

---

## The argument

**Most small sites are built with tools designed for large applications**, and they pay for it in
bundle size, build complexity, dependency churn, and time.

A landing page does not need a hydration strategy. A conference site does not need a router. An
internal dashboard for eleven people does not need a virtual DOM.

The article makes the case that **there is a category of site where a build-time-only tool is
strictly better**, and describes what that category looks like.

---

## Keep it honest

The fastest way to make this article worthless is to overclaim.

- **Name what Bascik is not good for.** A site with genuine client-side application state, real
  interactivity across many views, or a large team wanting typed component contracts is better
  served elsewhere. Saying so is what makes the rest credible.
- **Do not disparage other tools.** They solve problems Bascik does not, and readers of this
  article use them daily. The argument is about **fit**, not superiority.
- **Do not invent benchmark numbers.** If you cite a measurement, it must come from something in
  this repo, such as the Lighthouse configuration under `docs/lighthouse/`, and be described
  accurately. **A fabricated number is the fastest way to lose a reader who checks.**
- The repo's docs make performance claims carefully. Match that discipline.

---

## Structure

Suggested, not mandatory. Rearrange if a better shape emerges.

1. **The observation.** The tooling most people reach for was designed for a different problem.
2. **What a micro site actually is.** Concrete examples, and where the line falls.
3. **What you stop paying for.** No runtime, no hydration, no bundle, no dependency tree to
   maintain. Be specific about each.
4. **What you give up.** The honest section. Put it in the middle, not buried at the end.
5. **What it looks like in practice.** A real, small, complete example.
6. **Where the line is.** How to tell when a project has outgrown this, and what to do then.

Section 6 matters most. An article that cannot say when its own advice stops applying is
marketing.

---

## Distinct from the how-to guide

Prompt 56 guide D covers **how** to build a micro site with Bascik.

This article covers **why** and **when**. It should **link** to the guide rather than repeat it.

If you find yourself writing installation steps or configuration snippets, you are writing the
guide again. Stop and link.

---

## Code examples

Fewer than a docs page would have. This is an argument, not a tutorial.

Whatever code appears **must be extracted from a real fixture** via `extractDemoBlock`, per the
repo conventions. An article with a broken example is worse than an article with none.

Reuse prompt 56's guide D fixtures where possible rather than creating parallel ones that can
drift.

---

## Steps

1. Read prompt 56's guide D so the two pieces are complementary rather than overlapping.
2. Read `docs/content/why-bascik.md` and `docs/content/vs-frameworks.md`. **Both already make
   adjacent arguments.** This article must not duplicate them; find the angle they do not cover,
   which is the **size and category of project** rather than the technology comparison.
3. Draft the argument, including the honest section, before writing prose.
4. Identify which fixtures the examples come from.
5. Write it. Follow prompt 58's conventions exactly.
6. Register in nav and the index or sidebar; h1 equals label per prompt 53.

## Testing

**Unit:**

- The page renders from its Markdown, guarding the silent empty-page failure.
- Every `extractDemoBlock` marker resolves.
- Prompt 53's naming test and prompt 54's link test cover the page.

**E2E:** **none.** Prompt 58 added the section navigation check; a second article needs no new
E2E. **State that reasoning.**

**Verification:**

```sh
yarn docs:build
```

The article renders with content, appears in the search index and `llms.txt`, and every
cross-link resolves.

**Then read it as a skeptical reader.** If the honest section is thin, or the "where the line is"
section is vague, revise. That judgment is the deliverable here; a rendering test cannot make it.

## Documentation

| File                                   | Change                                                      |
| -------------------------------------- | ----------------------------------------------------------- |
| `docs/content/articles/micro-sites.md` | The article                                                 |
| `docs/content/articles/index.md`       | The entry and one-line summary, if prompt 58 chose an index |
| `docs/content/how-to/micro-sites.md`   | Link back to the article                                    |
| `docs/content/why-bascik.md`           | Link, if the argument genuinely extends that page           |

**Not** SKILL.md, per prompt 58's reasoning.

## Acceptance criteria

- [ ] The article exists, renders with content, and is registered.
- [ ] The argument is about **fit**, and **names what Bascik is not good for**.
- [ ] There is a clear "where the line is" section.
- [ ] **No fabricated benchmarks.** Any number is traceable to something in this repo.
- [ ] **No disparagement of other tools.**
- [ ] It does not duplicate `why-bascik.md`, `vs-frameworks.md`, or prompt 56's guide.
- [ ] Code examples come from **real fixtures**, reusing guide D's where possible.
- [ ] Every marker resolves, with a test.
- [ ] Naming and link tests cover the page.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] No package source was modified.

## Do not do

- Do not invent performance numbers.
- Do not criticize other frameworks.
- Do not repeat the how-to guide.
- Do not use `$...$`.
- Do not modify package source.
- Do not run pre-push scripts.
