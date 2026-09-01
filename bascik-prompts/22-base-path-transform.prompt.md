# 22: Base path transform

Read `.github/prompts/00-README.md` first.

**Scope:** a new base-path module, plus `pkg/src/lib/processing.ts` and `pkg/src/lib/styles.ts`.
Consumes the `base` config key that prompt 03 declared and prompt 05 validated.

**Serving under `base` is prompt 23.** This prompt is the output transform only.

---

## The problem

Deploy to a **domain root**, `https://bascik.dev/`, and `<a href="/docs">` resolves to
`https://bascik.dev/docs`. Correct.

Deploy to a **subdirectory**, `https://acme.github.io/my-site/`, and that same `<a href="/docs">`
resolves to `https://acme.github.io/docs`. The prefix is gone and the link 404s. Same for
`<img src="/logo.png">`, `<link href="/styles.css">`, and CSS `url(/fonts/x.woff2)`.

Who hits this: GitHub Pages project sites, a site reverse-proxied at `/app`, pull-request
preview URLs such as `/pr-123/`, and docs mounted under `/docs` on a marketing domain.

## The chosen approach

**Build-time rewriting of root-relative URLs.** Same model as Vite `base`, Astro `base`, and
Next `basePath`. Authors keep writing `/about` and it works in both deploy shapes.

**Decision, do not re-litigate.** Two alternatives were rejected:

- **Injecting `<base href="/my-site/">`.** Native HTML and zero transform, but it only affects
  _relative_ URLs (`about`, `./about`), **not root-relative ones** (`/about`). Authors would
  have to write `../../assets/logo.png` from a nested page, and it does nothing for CSS `url()`.
- **Applying `base` only to generated artifacts.** A user would set it, see the sitemap update,
  deploy, and find every page 404s. A partial implementation is worse than none.

---

## Requirement 1: `base: '/'` is a complete no-op

The default must produce **byte-identical output** to a build with no base handling at all.

**Write this test first**, before implementing anything. It will trivially pass at the start.
**Keep it passing through every subsequent step.** It is your safety rail for the whole prompt,
because most Bascik users deploy to a domain root and must pay nothing for a feature they do not
use.

---

## Requirement 2: what gets rewritten

| Location                                  | Notes                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `href`                                    | `<a>`, `<link>`, `<area>`, and any element carrying one                                                                                    |
| `src`                                     | `<img>`, `<script>`, `<iframe>`, `<source>`, `<video>`, `<audio>`, `<embed>`                                                               |
| `srcset`                                  | Comma-separated, each entry optionally followed by a width or density descriptor. **Parse it properly**; a `data:` URL can contain a comma |
| `imagesrcset`                             | Same syntax, on `<link rel="preload" as="image">`                                                                                          |
| `poster`                                  | `<video>`                                                                                                                                  |
| `data`                                    | `<object>`                                                                                                                                 |
| `formaction`                              | `<button>`, `<input>`                                                                                                                      |
| `action`                                  | `<form>`                                                                                                                                   |
| `content`                                 | **Only** on known URL-bearing meta properties: `og:image`, `og:url`, `twitter:image`. Do **not** rewrite arbitrary `content` attributes    |
| `href` on `<link rel>`                    | `preload`, `preconnect`, `prefetch`, `modulepreload`, `manifest`, `icon`, `apple-touch-icon`                                               |
| `url()` in a hoisted `<style>` block      |                                                                                                                                            |
| `url()` in an inline `style=""` attribute |                                                                                                                                            |
| `url()` in a copied stylesheet            |                                                                                                                                            |
| `@import` in CSS                          |                                                                                                                                            |
| `image-set()` in CSS                      |                                                                                                                                            |
| The web app manifest JSON                 | `start_url`, `scope`, and each `icons[].src`                                                                                               |

## Requirement 3: what must never be rewritten

Byte-identical:

- Absolute URLs: `https://…`, `http://…`
- Protocol-relative: `//cdn.example.com/x.js`
- Any other scheme: `data:`, `blob:`, `mailto:`, `tel:`, `sms:`, `javascript:`
- Fragment-only: `#section`
- Already-relative: `about`, `./about`, `../about`
- An empty value
- Anything already starting with the configured base, so the transform is **idempotent**

---

## Requirement 4: interaction with prompts 20 and 21

**`href="#id"` is an ID reference, not a path. Prompt 20 owns it. This prompt must not claim
it.**

**`url(#id)` in CSS is an ID reference. Prompt 21 owns it. This prompt must not claim it.**

Both are covered by the fragment-only exclusion above, but state the ordering explicitly in the
implementation, and add a test proving a component containing **both** `<a href="#local-id">`
and `<a href="/about">` gets exactly one correct transform applied to each.

ID-reference rewriting should run **first**. After it runs, fragment values are final and this
transform's "skip anything starting with `#`" rule is unambiguous.

---

## Requirement 5: normalization

Prompt 05 validated `base`. Confirm the normalization holds:

| Input                       | Normalized                                              |
| --------------------------- | ------------------------------------------------------- |
| `'/'`                       | `'/'` (no-op)                                           |
| `'/sub'`                    | `'/sub/'`                                               |
| `'sub'`                     | `'/sub/'`                                               |
| `'/sub/'`                   | `'/sub/'`                                               |
| `'/a/b'`                    | `'/a/b/'`                                               |
| `'https://example.com/sub'` | rejected                                                |
| `''`                        | rejected, or treated as `'/'`. Pick one and document it |

---

## Requirement 6: function replacements

Every rewrite must use a **function replacement**, never a string replacement. URL values can
contain `$&`, `$1`, and `` $` ``, which have caused infinite loops and out-of-memory crashes in
this repo.

---

## Explicit non-goals

- **Rewriting URLs constructed in JavaScript.** Bascik cannot know `fetch('/api/' + id)` is a
  path. Prompt 23 documents the workaround.
- **A runtime `base` helper injected into the page.** That is a client-side runtime, which
  contradicts the zero-runtime premise.
- **Guessing at custom attributes.** If a third-party library reads a URL from `data-src`, that
  is the author's concern.

---

## TDD steps

1. **The no-op guarantee**, per requirement 1. First, and kept green throughout.
2. **Normalization**, table-driven over requirement 5 including the rejections.
3. **The URL classifier, pure.** A function answering "should this value be rewritten?" for
   every row of requirements 2 and 3. **This is the highest-value unit in the prompt**; get it
   right in isolation before wiring it anywhere. Include `//cdn.example.com`,
   `data:image/svg+xml;base64,…` containing a comma and a slash, `#top`, `./x`, `../x`, `/x`,
   `x`, an empty string, `mailto:a@b.c`, and a value already prefixed with the base.
4. **`srcset` parsing, pure.** Its own step, because naive comma splitting breaks on `data:`
   URLs. Cases: one entry with no descriptor; multiple with `w` descriptors; multiple with `x`
   descriptors; mixed absolute and root-relative; an entry that is a `data:` URL containing a
   comma; extra whitespace around commas; a trailing comma.
5. **HTML rewriting**, every attribute in requirement 2. Then the requirement 4 interaction test.
6. **CSS rewriting**: hoisted `<style>`, inline `style=""`, a copied stylesheet, `@import`, and
   `image-set()`. Then the requirement 3 negatives inside CSS.
7. **Idempotence**: applying the transform twice equals applying it once.
8. **Regex-token safety**: a URL containing `$&` and `$1` survives verbatim; a path segment
   containing `%24` survives.
9. **The web app manifest**: `start_url`, `scope`, and `icons[].src`.

## Testing

**Unit:** all of the above.

**E2E:** add a fixture site built with `base: '/sub/'`, containing a nested page, an image, a
`srcset` with mixed entries, a CSS background image, a `mailto:` link, an absolute CDN script,
and a fragment link.

- `playwright.config.ts` (static build): **the primary config.** Every root-relative URL carries
  the prefix; every excluded category is untouched; the `srcset` rewrites only its
  root-relative entries; the CSS background resolves.
- `playwright.dev.config.ts`: prompt 23 owns dev serving. If dev serving under `base` is not
  yet implemented, state that and defer the dev E2E to prompt 23 rather than writing a test that
  cannot pass.
- The two server configs: same, deferred to prompt 23.

Also add a **`base: '/'` fixture** asserting byte-identical output to a no-base build. That is
the regression guard for the no-op guarantee at the E2E level.

## Documentation

| File                                               | Change                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/configuration.md`                    | The `base` key, normalization rules, and the `'/'` no-op guarantee                                                                                                       |
| `docs/content/compatibility.md`                    | **Required by repo policy.** A table of what `base` rewrites and what it deliberately leaves alone, including the JavaScript non-goal marked unsupported with its reason |
| `docs/content/internals/transpilation-pipeline.md` | Where the base transform sits: **after** ID-reference rewriting, before minification                                                                                     |

`docs/content/deploying.md` and the FAQ entries are prompt 23, which completes the feature.

## Acceptance criteria

- [ ] `base: '/'` produces byte-identical output, proven by a test that runs on every change.
- [ ] Every location in requirement 2 is rewritten.
- [ ] Every category in requirement 3 is byte-identical.
- [ ] The transform is idempotent.
- [ ] `srcset` and `imagesrcset` parse correctly, including a `data:` URL containing a comma.
- [ ] The web app manifest is rewritten.
- [ ] A component with both `href="#local-id"` and `href="/about"` gets exactly one correct
      transform applied to each, and **the ordering is documented**.
- [ ] Function replacements throughout; a URL containing `$&` survives.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn docs:build` output is **unchanged** by this prompt, since the docs use `base: '/'`.
- [ ] Static-build E2E added for both `base: '/sub/'` and `base: '/'`; the user has run
      `yarn e2e:all`.

## Do not do

- Do not claim `href="#id"` or CSS `url(#id)`. Prompts 20 and 21.
- Do not implement serving under `base`, sitemap composition, or the FAQ. **Prompt 23.**
- Do not rewrite URLs constructed in JavaScript, and do not inject a runtime helper.
- Do not run Playwright or pre-push scripts.
