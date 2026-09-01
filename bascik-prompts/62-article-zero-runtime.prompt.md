# 62: Article, what zero-runtime actually costs

Read `.github/prompts/00-README.md` first.

**Scope:** one new article at `docs/content/articles/zero-runtime.md` and its page shell.

**Depends on prompt 58.** This is the **final prompt** in the sequence.

**No package code changes.**

---

## The subject

"Zero runtime" is a marketing phrase almost everywhere it appears. This article takes it
literally and asks what it **actually costs to mean it**.

The answer is that the cost is real and it is paid by **the author**, at build time, in
constraints. That is a defensible trade, and the article's job is to make the trade legible
rather than to sell it.

---

## The honest framing

This is the article most likely to become promotional. Resist it.

The thesis is **not** "zero runtime is better". The thesis is **"here is what it costs, here is
what you get, decide for yourself"**.

Concretely, name the costs:

| Cost                                | Detail                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **No client-side state management** | Anything stateful is yours to write, in vanilla JavaScript                                                            |
| **No component re-rendering**       | The DOM you ship is the DOM you have. Updates are manual                                                              |
| **Build-time-only data**            | Data is fixed at build. Dynamic data means client fetching, which means client JavaScript                             |
| **Templating is yours**             | Prompt 55 covers this. Bascik deliberately provides nothing                                                           |
| **Scoping constraints**             | Prompt 61 covers the `querySelector` trap and `innerHTML` limits. These are direct consequences of build-time scoping |
| **Rebuilds**                        | Content changes require a build. Prompt 44 improved the watcher; it is still a build                                  |
| **A smaller ecosystem**             | No component libraries, no plugin marketplace. Prompt 57's `bascik add` is a copy-in model, not an ecosystem          |

Then what you get: no bundle, no hydration, no dependency tree, output you can read, and a site
that does not break when a transitive dependency publishes a bad version.

---

## The interesting argument

**Most "zero runtime" tools are not.** They ship a hydration runtime, an island loader, a router,
or a small framework core. Often for good reasons.

The argument worth making is that **partial zero-runtime is a different product** from actual
zero-runtime, and conflating them makes it impossible to reason about the trade.

**Do not name and criticize specific tools.** Describe the pattern. A reader who uses one of those
tools should finish the article understanding their own tradeoff better, not feeling attacked.

---

## Grounding

**Verify before claiming.**

- Does a Bascik build genuinely emit **no framework JavaScript**? Check `docs/dist/` and confirm.
  If any runtime code ships, from live reload in dev or anything else, **say so and say when**.
- Live reload injects a client script **in dev**. That is not shipped in a production build.
  **Confirm that** and state it, since it is exactly the kind of caveat that makes an article
  trustworthy.
- Any performance claim must be traceable to something in this repo, such as the Lighthouse
  configuration under `docs/lighthouse/`. **No invented numbers.**

---

## Structure

Suggested.

1. **The phrase.** What "zero runtime" is usually taken to mean versus what it can mean.
2. **What Bascik ships.** Verified, including the dev-only caveat.
3. **What it costs the author.** The table above, unhedged.
4. **What you get.** Concrete, not adjectives.
5. **When the trade is wrong.** The section that makes the rest credible.
6. **The honest conclusion.** A category judgment, not a recommendation.

---

## Position in the sequence

This is the **last** prompt. It is a reasonable place to reflect the changes the whole sequence
made.

Where a claim in this article rests on something an earlier prompt fixed, such as deterministic
output from prompt 24 or build honesty from prompt 12, **it is now true because the work was
done**. Do not narrate the sequence, but do make sure the article describes the **current**
system rather than the one that existed before it.

---

## Code examples

Few. This is the most argumentative of the four articles.

Anything shown must be **extracted from real fixtures** via `extractDemoBlock`. A comparison of
authored source to emitted output is likely the only example needed, and prompt 61's fixtures may
already cover it. Reuse rather than duplicate.

---

## Steps

1. Read the other three articles so the set reads as a coherent whole with no overlap.
2. **Verify what a production build actually emits.** This is the factual spine.
3. Draft the cost table. Be harder on Bascik than feels comfortable.
4. Write it.
5. Register in nav and the index or sidebar; h1 equals label per prompt 53.
6. **Read all four articles in the chosen order** and confirm the ordering is right.

## Testing

**Unit:**

- The page renders from its Markdown.
- Every marker resolves.
- Prompt 53's naming test and prompt 54's link test cover the page.
- **If the article claims a production build emits no framework JavaScript, add a test that
  asserts it.** That converts the central claim from prose into something enforced.

That last test is the most valuable thing in this prompt. A claim in an article decays; a test
does not.

**E2E:** the **static build config** is the right place for the no-framework-JavaScript
assertion if it is better expressed against real output than in a unit test. Decide which, and
**state the reasoning**.

The other three configs do not apply. State that too.

**Verification:**

```sh
yarn docs:build
```

Then inspect `docs/dist/` yourself and confirm the article's claims about emitted output are
true.

## Documentation

| File                                                | Change                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `docs/content/articles/zero-runtime.md`             | The article                                                                                     |
| `docs/content/articles/index.md`                    | Entry and summary. **This completes the section**, so confirm the reading order across all four |
| `docs/content/why-bascik.md` and `vs-frameworks.md` | Link, without duplicating                                                                       |
| `docs/content/performance.md`                       | Link, if the article supports a claim made there                                                |

**Not** SKILL.md, per prompt 58's reasoning.

## Final sequence check

This being the last prompt, verify the whole body of work holds together:

- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn pkg:build` and `yarn docs:build` succeed.
- [ ] `bascik --check` passes against the docs site.
- [ ] The user has run `yarn e2e:all` across all four configs.
- [ ] **`docs/content/compatibility.md` reflects every scoping change** made across the sequence,
      per repo policy.
- [ ] **`docs/src/pages/assets/SKILL.md` and `create/assets/SKILL.md` are identical** and reflect
      the current system.
- [ ] `docs/dist/llms.txt` is current and includes every new page.
- [ ] No `$...$` anywhere in `docs/content/`, per prompt 01.
- [ ] Every h1 matches its sidebar label, per prompt 53.
- [ ] Coverage files updated.

Report anything that fails. **Do not fix unrelated failures inside this prompt**; report them.

## Acceptance criteria

- [ ] The article exists, renders with content, and is registered.
- [ ] **The cost section is unhedged** and names every real constraint.
- [ ] **What a production build emits was verified**, including the dev-only live-reload caveat.
- [ ] The no-framework-JavaScript claim is **backed by a test**.
- [ ] **No specific tool is named and criticized.**
- [ ] **No invented performance numbers.**
- [ ] There is a clear "when this trade is wrong" section.
- [ ] The four articles read as a coherent set with no overlap, in a deliberate order.
- [ ] The final sequence check above was run and reported.
- [ ] No package source was modified.

## Do not do

- Do not write marketing.
- Do not name and criticize specific tools.
- Do not invent numbers.
- Do not claim zero runtime without verifying it.
- Do not duplicate the other three articles.
- Do not fix unrelated failures found in the final check. Report them.
- Do not use `$...$`.
- Do not run pre-push scripts.
