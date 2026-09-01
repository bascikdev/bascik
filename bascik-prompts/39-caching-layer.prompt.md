# 39: Caching layer

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts`, `pkg/src/lib/names.ts`, `pkg/src/lib/mem.ts`. Implements
`http.cacheControl` and `http.compression`, which prompt 03 declared without behavior.

**Decision, do not re-litigate:** fix the caching layer only. **Do not add asset URL
fingerprinting.** That is a documented recipe in prompt 56, not a feature.

**Do not justify this work with the Lighthouse score.** `uses-long-cache-ttl` is an **unweighted
diagnostic** in Lighthouse 10 and later. The justification is correctness.

---

## Context that shapes this prompt

Bascik **inlines** component CSS and JavaScript, and `assets.inlineStyles` inlines global
stylesheets. The docs site has **zero** external stylesheet or script requests.

So the assets this prompt affects are **images, fonts, favicons, the webmanifest,
`directory.public` contents, and author-written `<script src>`**. That is a smaller surface than
it first appears, and it is why fingerprinting was rejected as a feature.

Pages already get a **strong SHA-256 content ETag** (`names.ts#L54-L55`). That half is correct.

---

## Bug 1: mtime ETags are wrong, not merely suboptimal

`server.ts#L41-L42`:

```ts
export const makeStatEtag = (mtimeMs: number, size: number): string =>
  `W/"${mtimeMs.toString(36)}-${fileStatSizeToString(size)}"`;
```

mtime differs across CI checkouts and across replicas.

**Two servers behind a load balancer serve different ETags for identical bytes**, so a client
thrashes revalidation and may flip-flop between them. Every deploy invalidates every asset even
when nothing changed.

### Fix

Replace with a **content-hash ETag**. Pages already use one; reuse that approach rather than
inventing a second.

**Compute it once at store or first-serve time, not per request.** Hashing a large font on every
request would trade one problem for a worse one. Cache the hash alongside the file metadata.

### The test that proves it

**Identical bytes produce identical ETags across two separate server instances.** That is the
replica problem, stated directly. A test that only checks the ETag is stable within one process
does not prove anything.

---

## Bug 2: cache-control is hardcoded

`server.ts#L241` sends `public, max-age=3600` for every static asset.

One hour is **simultaneously too long and too short**:

- **Too long:** after a deploy, a client can serve a stale logo for an hour with no way to bust
  it.
- **Too short:** a font that never changes is revalidated 24 times a day, each one a round trip
  even when it 304s.

### Fix

Implement `http.cacheControl` as a **per-extension mapping** with an `immutable` option.

Keep today's `public, max-age=3600` as the **default**, so nothing changes for someone who does
not configure it.

Document the pairing: `immutable` is only safe on a URL whose content cannot change, which in
practice means a fingerprinted filename. Prompt 56's recipe produces exactly that, so cross-link
them.

### Consistency

The `httpCache: false` branch produces `no-store` for static (`#L243`) but does **not** disable
ETag emission consistently with the page branch. Make the two branches agree.

---

## Bug 3: 304 responses omit headers they must carry

`server.ts#L429-L433` and `#L232-L237`.

RFC 9110 requires that a 304 carry the headers that would have been sent on a 200 **where they
affect caching**. A shared cache can mis-key without them.

Add `vary` and `cache-control` to 304 responses.

---

## Bug 4: the same ETag for two representations

`server.ts#L428` computes `makeEtag(page.content)` on the **uncompressed** buffer, then serves it
unchanged with `content-encoding: br` (`#L441-L446`).

`vary: Accept-Encoding` is present on 200s so most caches cope, but per specification the encoded
representation needs a **distinct ETag**.

Derive one, for example by suffixing the encoding. Keep it deterministic so prompt 24's
reproducibility is not undermined.

---

## Bug 5: static assets are never compressed

The static branch (`server.ts#L203-L276`) streams raw bytes. There is **no gzip or brotli
negotiation, no precompressed sidecar lookup, and no `vary: Accept-Encoding`** on static
responses.

CSS and JavaScript ship uncompressed from `--server`. So does SVG, JSON, and the webmanifest.

### Fix

Implement `http.compression`:

- **Negotiate on `Accept-Encoding`.**
- **Prefer a precompressed sidecar** if one exists next to the file, so a build step can do the
  expensive compression once.
- Otherwise compress on the fly, with a **size threshold** below which compression is skipped,
  since compressing a 200-byte SVG costs more than it saves.
- **Do not compress already-compressed formats:** images, video, audio, archives, and fonts in
  `woff2`, which is already compressed.
- Add `vary: Accept-Encoding`.

Pages currently support **brotli only, with no gzip fallback**. Add gzip for clients that do not
accept brotli.

### Interaction with prompt 49

Prompt 49 specifies that API responses must **not** be compressed automatically, because
compressing responses that mix attacker-influenced input with secrets is the BREACH attack class.

**Make sure this negotiation does not accidentally catch that path.** If prompt 49 has not landed
yet, leave a comment marking where the exclusion will go.

---

## TDD steps

Write each failing test first.

1. **Identical bytes produce identical ETags across two separate server instances.**
2. The ETag is a content hash, not mtime-derived.
3. The hash is computed once, not per request. Assert by instrumenting.
4. `http.cacheControl` maps per extension, with the documented default preserved.
5. `immutable` is emitted when configured.
6. `httpCache: false` disables ETags consistently on both branches.
7. A 304 carries `vary` and `cache-control`.
8. The brotli representation has a distinct ETag from the identity representation.
9. Compression negotiates: brotli when accepted, gzip when only gzip is accepted, identity when
   neither.
10. A precompressed sidecar is preferred over on-the-fly compression.
11. A file below the size threshold is not compressed.
12. An already-compressed format is not compressed.
13. `vary: Accept-Encoding` is present on compressed static responses.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  Assert a CSS or SVG asset is served compressed with the right encoding and `vary`; assert a
  conditional request with `If-None-Match` returns 304 **carrying `cache-control` and `vary`**;
  assert an image is not compressed.
- `playwright.dev.config.ts`: assert caching headers do not interfere with live reload. A dev
  server that caches pages aggressively is its own bug, so confirm dev's behavior is the intended
  one.
- `playwright.config.ts` (static build): no new tests. There is no Bascik process serving. State
  that reasoning.

The two-instance ETag test is hard to express in Playwright. Keep it at the unit level and say
so.

## Documentation

| File                               | Change                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`    | `http.cacheControl` per-extension mapping with `immutable`; `http.compression`                                                                                                          |
| `docs/content/deploying.md`        | Tuning cache-control. **Pair `immutable` with fingerprinted filenames, cross-linking prompt 56's recipe.** Note that Bascik inlines CSS and JS, so this mainly affects images and fonts |
| `docs/content/internals/server.md` | Content-hash ETags and why mtime was wrong. The compression negotiation and its exclusions                                                                                              |
| `docs/content/compatibility.md`    | **Required by repo policy.** Update the ETag row, which currently documents the mtime format                                                                                            |
| `docs/content/faq.md`              | "Why are my assets re-downloading after every deploy?" Now fixed, but searchable                                                                                                        |
| `docs/src/pages/assets/SKILL.md`   | ETags are content-based; `http.cacheControl` exists. Sync `create/assets/SKILL.md`                                                                                                      |

## Acceptance criteria

- [ ] All thirteen tests failed before their fixes and pass after.
- [ ] **Identical bytes produce identical ETags across two separate server instances.**
- [ ] ETags are content hashes computed once, not per request.
- [ ] `http.cacheControl` works per extension with `immutable`, defaulting to today's value.
- [ ] `httpCache: false` is consistent across both branches.
- [ ] 304s carry `vary` and `cache-control`.
- [ ] The brotli representation has a distinct, deterministic ETag.
- [ ] Compression negotiates brotli, gzip, and identity; prefers a sidecar; honors a threshold;
      skips already-compressed formats; adds `vary`.
- [ ] A comment or exclusion marks where API responses stay uncompressed for prompt 49.
- [ ] **No asset URL fingerprinting was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to dev and both server configs; the user has run `yarn e2e:all`.
- [ ] `compatibility.md` ETag row updated; both SKILL.md copies in sync.

## Do not do

- Do not add asset URL fingerprinting.
- Do not justify anything with the Lighthouse score.
- Do not compress API responses. Prompt 49 owns that boundary.
- Do not change security headers. **Prompt 45.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
