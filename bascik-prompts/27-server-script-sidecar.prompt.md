# 27: Server script sidecar

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/processing.ts`, `pkg/src/lib/server-scripts.ts`,
`pkg/src/lib/html-minifier.ts`, `pkg/src/lib/mem.ts`, `pkg/src/lib/serve.ts`.

**Decision, do not re-litigate:** there is **no `generate.stripServerScripts` config option**.
A sidecar file replaces it, so the failure mode is designed out rather than made opt-in.

---

## The problem

`<script data-bascik-server>` blocks are executed at request time. `server.ts#L403` reads the
compiled page, checks `page.hasServerScripts`, and calls `executeServerScripts` to replace the
tag before responding.

For that to work, the compiled HTML in `directory.out` must retain **the tag and its full
source**. Nothing removes it: `html-minifier.ts` preserves it verbatim and
`minifyScriptTagsInHtml` skips it.

That is correct for `bascik --server`. It is a problem for a **pure static deploy**, where the
build output is uploaded to a CDN and no Bascik server ever runs:

1. **Source disclosure.** The Node source is readable in page source, including any internal API
   endpoint, query, or secret the author assumed was server-side only.
2. **Console errors.** The tag has no `type` attribute, so browsers treat it as classic
   JavaScript and execute it. Server scripts use Node APIs and top-level `import`, which is a
   **syntax error** in a classic script. Logged browser errors fail Lighthouse best practices.

### What is already correct

Dev and `bascik --server` **already never send the source to the browser**, because
`executeServerScripts` replaces the tag with its stdout before responding.

**The leak is only in the static-build case.** Do not "fix" the two modes that are already fine.

---

## The design

`bascik --build` strips the source from the emitted HTML into a sidecar, leaving an opaque
placeholder. `bascik --server` loads the sidecar at boot.

### The sidecar

`dist/.bascik/server-scripts.json`.

The dot-prefixed directory is deliberate: prompt 10's request guard 404s any dot-segment path,
so the sidecar is never served. Prompt 26 put the manifest in the same place. **Confirm the
guard covers this file too, with a test.**

### The placeholder

Must carry **enough identity to map back to its sidecar entry, and nothing else.** No source, no
snippet, no file path, no hints.

Must be **inert in a browser in every mode**. Give it a non-executable script type such as
`type="text/bascik-server"`, or use an HTML comment marker. Browsers ignore scripts with an
unknown type, so the console errors disappear everywhere, including in the modes that already
did not leak source.

### Compatibility to verify, not assume

- `htmlHasServerScripts` (`mem.ts#L71`) must detect the placeholder form.
- `executeServerScripts` must resolve a placeholder to its sidecar entry.
- `minifyScriptTagsInHtml` must still skip it. It already skips non-`text/javascript` types, so
  **confirm the interaction** rather than assuming the type choice happens to work.
- Prompt 15 fixed the minifier's script-preservation lookahead. Make sure the placeholder is
  covered by whatever that fix produced.

---

## Ordering

The strip must happen **after** all HTML transforms that could touch the script content, and
**before** the page is written and before prompt 26's manifest records it.

Coordinate with prompt 26: the sidecar is itself an emitted file and belongs in the manifest.

---

## Dev mode

In dev, pages are served from memory. Prompt 11 restored asynchronous page writes to the output
directory in dev, so the written HTML now also contains the placeholder.

Decide whether dev writes the sidecar too. It should, for consistency: the output directory
should look the same in both modes, so `bascik --server` against a dev-produced output directory
behaves correctly. Say so explicitly and test it.

The in-memory path must keep working regardless, since that is what dev actually serves from.

---

## TDD steps

Write each failing test first.

1. **The core assertion:** after `bascik --build`, **no substring of any server script's source
   appears anywhere in any HTML file** in the output directory. Use a distinctive marker string
   in the fixture so the assertion cannot pass by accident.
2. The sidecar exists at `dist/.bascik/server-scripts.json` and contains the source.
3. The placeholder contains no source, no path, and no snippet.
4. The placeholder has a non-executable type, so a browser ignores it.
5. `htmlHasServerScripts` detects the placeholder.
6. `executeServerScripts` resolves a placeholder to the right sidecar entry and produces the
   same output as before.
7. `minifyScriptTagsInHtml` skips the placeholder.
8. A page with **multiple** server scripts maps each placeholder to its own entry, in order.
9. Two different pages with server scripts do not cross-map.
10. `bascik --server` loads the sidecar at boot and serves correctly.
11. A missing sidecar under `--server`, when pages contain placeholders, produces a clear error
    rather than silently serving placeholders.
12. `/.bascik/server-scripts.json` returns **404**.
13. The dev decision behaves as documented.
14. **No config option was added.**

## Testing

**Unit:** all of the above.

**E2E:** this is where the two symptoms are actually proven.

- `playwright.config.ts` (static build): **the primary config.** Load a page containing a server
  script from static output and assert (a) the marker string is absent from the page source, and
  (b) **no browser console error is logged**. The console assertion is the one that proves the
  inert-type fix.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: the same page executes
  correctly and returns the script's output, proving the sidecar round-trip. Also assert
  `/.bascik/server-scripts.json` returns 404.
- `playwright.dev.config.ts`: the page executes correctly and logs no console error.

The console-error assertion in the static config is the single most valuable test here, because
it is the Lighthouse-visible symptom and nothing else catches it.

## Documentation

| File                               | Change                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/server.md`           | Server script source **never reaches the browser in any mode**, and how the sidecar achieves that for static builds. Note that the block is inert in a browser by construction |
| `docs/content/deploying.md`        | Static output is safe to upload; the sidecar is not served. If you deploy statically, the script regions render empty, which is expected                                       |
| `docs/content/faq.md`              | Extend "What is `dist/.bascik/`?" from prompt 26 with the sidecar                                                                                                              |
| `docs/content/internals/server.md` | The placeholder format and the boot-time sidecar load                                                                                                                          |
| `docs/src/pages/assets/SKILL.md`   | Server script source is never shipped. Sync `create/assets/SKILL.md`                                                                                                           |

## Acceptance criteria

- [ ] All fourteen tests failed before their fixes and pass after.
- [ ] **No server script source substring appears in any output HTML**, proven with a
      distinctive marker.
- [ ] The placeholder is inert in browsers, proven by a **console-error assertion** in the
      static-build E2E.
- [ ] `htmlHasServerScripts`, `executeServerScripts`, and `minifyScriptTagsInHtml` all work
      against the placeholder, verified rather than assumed.
- [ ] Multiple scripts per page and multiple pages map correctly with no cross-contamination.
- [ ] `bascik --server` loads the sidecar; a missing sidecar produces a clear error.
- [ ] `/.bascik/server-scripts.json` returns 404 in dev and both server modes.
- [ ] The dev-mode sidecar decision is documented and tested.
- [ ] **No config option was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.

## Do not do

- Do not add `generate.stripServerScripts` or any config option for this.
- Do not add a build warning. The failure mode is designed out, so there is nothing to warn about.
- Do not change how server scripts **execute**. Prompts 46 and 47 replace the execution model;
  this prompt only changes where the source lives.
- Do not put the sidecar anywhere that is served.
- Do not run Playwright or pre-push scripts.
