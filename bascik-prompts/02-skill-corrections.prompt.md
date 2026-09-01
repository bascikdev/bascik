# 02: Fix SKILL.md contradictions and guidance gaps

Read `.github/prompts/00-README.md` first.

**Scope:** `docs/src/pages/assets/SKILL.md`, `create/assets/SKILL.md`, `docs/content/faq.md`,
`docs/content/internals/transpilation-pipeline.md`. No package code changes.

---

## Why this matters

During a real migration of a production site to Bascik, an AI agent working from `SKILL.md`
made three avoidable mistakes:

1. It created a `bascik.config.ts` whose only content restated existing defaults.
2. It found the old site's `sitemap.xml` and `robots.txt`, copied them over, and **disabled**
   Bascik's generation, instead of inspecting them and deleting them.
3. It copied a Next.js 500 error page into a fully static site that cannot serve one.

None of those are model failures. They are gaps in the guidance the model was reading.

---

## Task 1: the dev-mode disk-write contradiction

`SKILL.md` currently says both of these:

- around line 1326: "Both the dev server and `bascik --build` write compiled HTML to `dist/`,
  this is the ground truth of what Bascik produced."
- around line 1331: "no writes to `dist/` happen during dev mode."

**Today's actual behavior**, verified in `pkg/src/lib/processing.ts#L1035`:

```ts
// Only write to disk during build. Dev server serves from memory.
if (BascikConfig.isBuild) {
```

Pages are **not** written in dev. However `copyStaticAssets()` **does** run in dev and
`deleteDistFile` / `deleteDistDir` are watcher-driven, so dev leaves a half-built `dist/`
containing assets but no HTML.

**Describe today's behavior accurately, in exactly one place**, and delete the contradicting
sentence. Do not describe future behavior.

Add a one-line note that this is a known gap being fixed, so prompt 11 has an obvious place to
update.

Do the same audit in `docs/content/internals/transpilation-pipeline.md` lines 19 and 33, which
make the same claim. They are currently correct, so keep the claim but make it precise: pages
are not written, static assets are.

---

## Task 2: do not create a config that restates defaults

SKILL.md already says Bascik is zero-config by default. That was not enough.

Add an explicit **anti-pattern block** showing what not to write:

```ts
// DO NOT write this. Every value here is already the default for `bascik --build`.
export const build = {
  minify: true,
};
```

State the rule directly: create `bascik.config.ts` only when a value differs from the default.
If the file would contain only defaults, **do not create the file**.

---

## Task 3: migrating a site with an existing sitemap or robots file

Add a **procedure**, not a principle. Agents follow procedures.

1. Open the existing `sitemap.xml` and `robots.txt` and read them.
2. Decide whether they contain anything Bascik would not generate: hand-curated URLs,
   `Disallow` rules for paths that still exist, a `Sitemap:` pointer to an external index, or
   crawl directives specific to a single bot.
3. If they contain nothing special: **delete them** and let Bascik generate. Do not copy them
   into `src/pages/`, and do **not** set `generate.sitemap: false` or `generate.robots: false`.
4. If they do contain something special: keep the authored file, turn off the matching
   generator, and note in the config why.

Call out the failure mode explicitly, because it is what actually happened: copying the old
files over **and** disabling generation looks correct and silently freezes the sitemap at the
old site's URL list forever.

---

## Task 4: error pages

Add a short section:

- `src/pages/404.html` is picked up automatically by path convention in dev and under
  `bascik --server`. This works today.
- A 500 page is **meaningless in a fully static build**. Static hosts serve their own. Do not
  port a 500 page from Next.js, Remix, or any server-rendered framework into a static Bascik
  site.
- Note that `src/pages/500.html` becomes meaningful under `bascik --server` once prompt 38
  lands, and that it will also be convention-based with no config key.

Mark the 500 line clearly as **not yet implemented** so an agent does not promise it today.

---

## Task 5: the internal mask versus the preserve option

These two are easy to confuse and are currently undocumented as a pair.

- **Internal, hardcoded, not configurable.** Bascik temporarily blanks the contents of
  `<script>`, `<style>`, `<textarea>`, and HTML comments while scanning with regular
  expressions, so a component tag inside a JavaScript string is not mistaken for real markup.
  The mask is discarded immediately. Authors never interact with this.
- **Authoring choice.** `skipTranspilingElementContents` (default `["code"]`) tells Bascik not
  to apply scoping transforms inside those tags, so a code sample showing `class="card"` is not
  rewritten to `class="bascik__x__card"`.

Note that the config option is renamed to `scoping.preserve` in prompt 03, and mark that line
as **not yet implemented**.

---

## Task 6: FAQ addition

Add one question to `docs/content/faq.md`, matching the existing entry style:

**"What happens if I reference a component that doesn't exist?"**

Answer accurately for current behavior:

- During a build, Bascik emits a warning naming the unresolved tag, and the tag ships to the
  output unchanged. The build does not fail.
- `bascik --check` currently treats an unknown hyphenated tag as an **error** and exits 1.
- Mention that this is why third-party web components such as `<model-viewer>` and `<ion-icon>`
  currently fail `--check`, and that prompt 50 changes it to a warning.

Check whether `docs/src/pages/faq.html` needs its `<title>` or `<meta name="description">`
updated. For one added question it almost certainly does not, but confirm rather than assume.

---

## Task 7: sync the copies

`create/assets/SKILL.md` is a synced copy. After editing `docs/src/pages/assets/SKILL.md`:

```sh
yarn create:prepack
```

If that script does something other than sync the skill file, sync manually and note the
discrepancy. The two files must not diverge.

---

## Skill authoring rules

Follow the guidance in `.github/copilot-instructions.md`: default-first, gotchas explicit, add
what the agent lacks and omit what it already knows, no em-dashes, American English.

---

## Testing

**Unit:** add a test asserting `docs/src/pages/assets/SKILL.md` and `create/assets/SKILL.md`
are byte-identical. This drift has already happened and will happen again.

**E2E:** none. Skill and FAQ content is not exercised by any E2E config. State that reasoning.

**Verification:** `yarn docs:build`, then read the FAQ page in the built output.

---

## Acceptance criteria

- [ ] `SKILL.md` states dev-mode disk behavior exactly once, matching `processing.ts#L1035`.
- [ ] The transpilation-pipeline page distinguishes pages from static assets.
- [ ] An anti-pattern block for defaults-only configs exists.
- [ ] A numbered migration procedure for sitemap and robots exists, including the "copy over
      AND disable" failure mode.
- [ ] The 500 page guidance exists and is marked not yet implemented.
- [ ] The internal mask and the preserve option are documented as a pair.
- [ ] The FAQ answers the missing-component question.
- [ ] A test asserts the two SKILL.md copies match, and they do.
- [ ] `yarn check:spelling` and `yarn docs:build` pass.
- [ ] No package source was modified.

## Do not do

- Do not implement the 500 page, the config rename, or the dev-write fix. Those are prompts 38,
  03, and 11.
- Do not restructure navigation or change any page h1. Prompts 53 and 54.
- Do not run pre-push scripts.
