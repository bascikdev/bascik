# 15: HTML minifier ordering and gating

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/html-minifier.ts`, `pkg/src/lib/components.ts`,
`pkg/src/lib/processing.ts`, `pkg/src/lib/javascript.ts`.

Five defects in one area. The first can delete most of a document.

---

## Bug 1: comments are stripped before raw-text elements are shielded

`html-minifier.ts#L99-L110`:

```js
let html = htmlString.replace(/<!--[\s\S]*?-->/g, ""); // step 1: strip comments
const scriptTags = extractScriptTags(html); // step 2
html = html.replace(pattern, "").trim(); // step 3: remove them in place
// step 4: only NOW are <pre|textarea|script> preserved
```

Consequences:

- A `<script>` whose body contains `<!--`, which is common in JavaScript that builds HTML
  strings and in JSON-LD, has **everything up to the next `-->` anywhere in the document
  deleted**.
- `<pre><script>…</script></pre>` becomes `<pre></pre> … <script>…</script>` at the end of the
  component. **Scripts nested inside any container are relocated out of it.**
- Comments inside `<pre>` and `<textarea>` are destroyed.

**Fix:** shield first, strip comments second.

`html-minifier.test.ts` has four `extractScriptTags` cases and **no** comment-versus-script
case. That is why this survived.

---

## Bug 2: it runs regardless of `minify.html`

`components.ts#L261` calls `minifyHtml(cleanedContent)` on **every component**, unconditionally.

So `minify.html: false` does **not** stop component whitespace collapsing or the script
relocation above. That is a silent config contract violation, and it makes bug 1 unavoidable
even for someone who turned minification off specifically to debug it.

**Fix:** gate it on the config.

---

## Bug 3: the script-preservation lookahead is incomplete

`html-minifier.ts#L10-L22` lists `data-bascik-build` and `data-bascik-server` in its negative
lookahead but **not `data-bascik-routes`**, so a routes script inside a component is extracted
and relocated.

The lookahead also requires the exact literal `type="`, so `type = "module"` with spaces around
the equals sign **slips past the filter entirely**.

**Fix:** add `data-bascik-routes`, and make the attribute match whitespace-tolerant.

---

## Bug 4: `type="module"` scripts are never minified

`processing.ts#L235`:

```js
if (typeMatch && typeMatch[1].toLowerCase() !== "text/javascript") continue;
```

This excludes `module`, `application/javascript`, and `text/ecmascript`.

Meanwhile `javascript.ts#L840-L846` treats **all five** as JavaScript types for `sourceURL`
purposes. The two modules disagree about what counts as JavaScript.

**Fix:** one shared list, used by both. Decide whether module scripts should be minified; they
should, so make it so.

---

## Bug 5: external scripts get a junk IIFE

`javascript.ts#L846-L870`: `shouldWrap` does not check for a `src` attribute. So:

```html
<script src="x.js"></script>
```

becomes:

```html
<script src="x.js">
  (function() {

  })();
  //# sourceURL=…
</script>
```

Harmless per specification, since a `src` script's inline content is ignored, but it adds bytes
to every external script in every component and pollutes DevTools.

**Fix:** skip wrapping when `src` is present.

---

## While you are here

`processing.ts#L935-L940` builds `` `${head}${globalStyles}\n<style>\n${css}\n</style>` `` with
**no emptiness check**, shipping `<style></style>` plus stray whitespace on every page that has
no component CSS. Skip the block when the CSS is empty.

---

## TDD steps

Write each failing test first.

1. A `<script>` containing `<!--` does not delete anything after it. Use a document with
   content **after** the script so the deletion is visible.
2. `<pre><script>…</script></pre>` keeps the script inside the `<pre>`.
3. A comment inside `<pre>` survives.
4. `minify.html: false` leaves component whitespace and structure alone.
5. A `data-bascik-routes` script inside a component is not relocated.
6. `type = "module"` with spaces is recognized by the lookahead.
7. A `type="module"` script is minified when `minify.js` is on.
8. `<script src="x.js"></script>` gets no IIFE and no `sourceURL`.
9. A page with no component CSS emits no empty `<style>` block.

Order the fixes: shielding first, then the gate, then the lookahead, then the type list, then
the `src` check. The shielding fix changes what every other test observes, so doing it first
avoids rework.

## Testing

**Unit:** all of the above, in `html-minifier.test.ts` and `processing.test.ts`.

**E2E:** add a fixture component containing a JSON-LD `<script type="application/ld+json">`
whose content includes `<!--`, plus a `<pre>` block containing a script sample, plus a
`<script src>` reference.

- `playwright.config.ts` (static build): the content after the JSON-LD script is still present,
  the `<pre>` renders its sample intact, and the external script has no inline body. Minified
  output is the risky path, so this is the primary config.
- `playwright.dev.config.ts`: same, with minification off, proving the config gate works and
  that both modes produce structurally equivalent markup.
- The two server configs: assert the JSON-LD survives, since a broken JSON-LD block is an SEO
  regression that only shows in served output. Cheap to add.

## Documentation

| File                                     | Change                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/compatibility.md`          | **Required by repo policy.** Comments inside raw-text elements, scripts inside containers, and which script types are minified         |
| `docs/content/configuration.md`          | `minify.html: false` now genuinely disables component minification                                                                     |
| `docs/content/internals/minification.md` | The corrected order of operations. Note that prompt 01 converted the `$O(1)$` notation here to inline code spans; keep that formatting |
| `docs/content/faq.md`                    | "Why did part of my page disappear?" if it is worth a searchable entry                                                                 |
| `docs/src/pages/assets/SKILL.md`         | Only if authoring guidance changed. If not, say so rather than making a token edit                                                     |

## Acceptance criteria

- [ ] All nine tests failed before their fixes and pass after.
- [ ] Raw-text elements are shielded **before** comments are stripped.
- [ ] A `<!--` inside a script does not delete the document tail.
- [ ] Scripts are not relocated out of `<pre>` or any other container.
- [ ] `minify.html: false` disables component minification.
- [ ] `data-bascik-routes` is excluded from hoisting; spaced `type = "module"` is handled.
- [ ] One shared JavaScript-type list, used by both modules.
- [ ] `<script src>` gets no IIFE wrapper.
- [ ] No empty `<style></style>` is emitted.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` succeeds; the docs site uses JSON-LD and code samples heavily.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.

## Do not do

- Do not consolidate the shielding implementations. Prompt 18 owns that, and it depends on this
  ordering fix landing first.
- Do not change `mergeAttributesOntoRoot` or body reassembly. Prompt 16.
- Do not optimize the minifier. Prompt 34.
- Do not run Playwright or pre-push scripts.
