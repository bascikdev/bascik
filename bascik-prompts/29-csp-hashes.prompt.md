# 29: CSP hash manifest

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/processing.ts`, plus a small hashing module. Implements
`generate.cspHashes`, which prompt 03 declared without behavior.

**Depends on prompt 24.** Inline scripts contain instance IDs, so hashes are only stable once
builds are deterministic. Do not attempt this before that lands.

---

## The problem

Bascik's whole model is inlining: component `<style>` blocks are hoisted into the page `<head>`
(`processing.ts#L945`) and component `<script>` blocks are inlined and IIFE-wrapped.

That is excellent for performance and hostile to a strict Content Security Policy, because a
strict CSP must either allow `'unsafe-inline'`, defeating the point, or list a `sha256-` hash
for **every** inline block.

Nothing in Bascik emits the information needed to construct one.

---

## The artifact

Write `dist/.bascik/csp-hashes.json` when `generate.cspHashes` is on. Default off.

The dot-prefixed directory is deliberate: prompt 10's guard 404s any dot-segment path. Prompts
26 and 27 put their artifacts in the same place. Confirm the guard covers this one, with a test.

```json
{
  "/index": {
    "scripts": ["sha256-abc123…"],
    "styles": ["sha256-def456…"]
  },
  "/who-we-are/contact-us": {
    "scripts": ["sha256-…"],
    "styles": ["sha256-…"]
  }
}
```

---

## Rules

**Hash the exact bytes as emitted, after all minification.**

This is the single most important rule. Hashing pre-minified content produces hashes that do
**not** match what the browser sees, which is a silent and maddening failure: the CSP looks
correct, the manifest looks correct, and every script is blocked.

Take the hash at the last possible point, from the same buffer that gets written.

**Format:** base64-encoded SHA-256, prefixed `sha256-`, matching the CSP specification exactly
so values can be pasted directly into a header.

**Deduplicate within a page.** Bascik emits one script block per component instance by design,
so a component used five times produces five identical blocks and one hash.

**Exclude external references.** `<script src>` and `<link rel="stylesheet">` are covered by
source directives, not hashes.

**Page keys** use the same path form as the rest of the system. Prompt 09 unified the
path-to-URL function; use it rather than inventing a third convention.

---

## What Bascik does not do

**Bascik does not generate the CSP header.** That belongs to the host platform, and Bascik stays
static-first.

Document that division clearly. The manifest is a build artifact for the deploy layer to
consume, for example to generate a Cloudflare Pages `_headers` file from it in a
`phase: 'post'` exec script.

**Do not add a `content-security-policy` header to the server.** Prompt 45 covers security
headers and is explicitly told not to add a CSP either, for the same reason: a meaningful
default would need `'unsafe-inline'`, which is worse than nothing.

**Do not add nonces.** Nonces require per-request rendering; Bascik's output is static and
CDN-cached. Hashes are the correct mechanism for this architecture.

---

## Interaction with prompt 27

Prompt 27 replaced server script source with an inert placeholder. A placeholder is not
executable JavaScript, so it must **not** get a hash. Confirm and test.

## Interaction with prompt 26

The hash file is itself an emitted file and belongs in the manifest.

---

## TDD steps

Write each failing test first.

1. `generate.cspHashes: false` writes no file. This is the default; assert it explicitly.
2. `generate.cspHashes: true` writes `dist/.bascik/csp-hashes.json`.
3. **The critical test:** the hash matches a SHA-256 of the exact bytes in the emitted file.
   Compute it independently in the test from the written HTML, not from an intermediate value.
4. With `minify.js` and `minify.css` **on**, the hash still matches the emitted bytes. This is
   the case that breaks if hashing happens too early.
5. With minification **off**, likewise.
6. The format is `sha256-<base64>`, verified against a known value.
7. Duplicates within a page are removed: a component used five times yields one hash.
8. External `<script src>` and `<link rel="stylesheet">` are excluded.
9. A page with no inline script has an empty `scripts` array, not a missing key. Decide and be
   consistent.
10. Page keys match the unified path form.
11. **Hashes are stable across two builds**, which is only true after prompt 24.
12. Prompt 27's server-script placeholder gets no hash.
13. `/.bascik/csp-hashes.json` returns 404.
14. The file appears in prompt 26's manifest when both are enabled.

## Testing

**Unit:** all of the above.

**E2E:** the real proof is that a CSP built from the manifest actually works.

- `playwright.config.ts` (static build): **the primary config.** Build a fixture with
  `generate.cspHashes: true`, read the manifest, construct a `Content-Security-Policy` header
  from it, serve the page **with that header**, and assert (a) the page renders, (b) the
  component scripts run, and (c) **no CSP violation is logged to the console**.

  If the static harness cannot inject a response header, do this in one of the server configs
  instead and say so. Getting this test in **some** config matters more than which one, because
  it is the only thing that proves the hashes are correct rather than merely present.

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: assert
  `/.bascik/csp-hashes.json` returns 404.
- `playwright.dev.config.ts`: assert the same 404.

## Documentation

| File                             | Change                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/deploying.md`      | Consuming `dist/.bascik/csp-hashes.json` to build a `_headers` file, with an illustrative `phase: 'post'` exec example. **State plainly that Bascik emits hashes but not the header, and why** |
| `docs/content/configuration.md`  | `generate.cspHashes`, default off                                                                                                                                                              |
| `docs/content/performance.md`    | If it discusses inlining tradeoffs, note that a strict CSP is achievable via hashes                                                                                                            |
| `docs/content/faq.md`            | "How do I use a strict Content Security Policy with Bascik?" Extend "What is `dist/.bascik/`?" from prompt 26                                                                                  |
| `docs/content/compatibility.md`  | **Required by repo policy.** A row noting hashes are emitted, nonces are not, and why                                                                                                          |
| `docs/src/pages/assets/SKILL.md` | Enable `generate.cspHashes` when the deploy target sets a strict CSP. Gotcha: hashes cover inline blocks only. Sync `create/assets/SKILL.md`                                                   |

## Acceptance criteria

- [ ] All fourteen tests failed before their fixes and pass after.
- [ ] `generate.cspHashes` defaults off.
- [ ] **Hashes match the post-minification emitted bytes exactly**, verified by independent
      computation from the written file, with minification both on and off.
- [ ] Format is `sha256-<base64>`, pasteable into a header.
- [ ] Duplicates removed within a page; external references excluded.
- [ ] Page keys use the unified path form.
- [ ] **Hashes are stable across two builds.**
- [ ] Prompt 27's placeholder gets no hash.
- [ ] `/.bascik/csp-hashes.json` returns 404 in dev and both server modes.
- [ ] The file appears in the build manifest.
- [ ] **An E2E serves a page under a CSP built from the manifest with zero violations logged.**
- [ ] **No CSP header and no nonce support was added to the server.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The user has run `yarn e2e:all`.

## Do not do

- Do not generate a CSP header.
- Do not add nonce support.
- Do not hash pre-minification content.
- Do not hash external `src` or `href` references.
- Do not run Playwright or pre-push scripts.
