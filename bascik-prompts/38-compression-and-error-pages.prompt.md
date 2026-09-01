# 38: Compression regression and the 500 page

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/mem.ts`, `pkg/src/lib/server.ts`, `pkg/src/lib/processing.ts`.

Two unrelated items, grouped because the first is a one-line fix with an outsized payoff.

---

## Part 1: the brotli regression

`pkg/src/lib/mem.ts#L108-L110`:

```ts
const quality = BascikConfig.isBuild
  ? zlib.constants.BROTLI_MAX_QUALITY
  : zlib.constants.BROTLI_MIN_QUALITY;
```

Under `bascik --server`, `isBuild` is `false` and `isProdServer` is `true`.

So **the production server compresses every page at `BROTLI_MIN_QUALITY` (0)**, typically 20 to
35 percent worse than quality 11, **on exactly the path where compression ratio matters most**.

The condition needs `isBuild || isProdServer`.

This is one line and the largest performance win per byte of diff in the entire prompt sequence.

### Test it properly

A test asserting "output is compressed" would already pass today and prove nothing.

**Assert the quality constant selected in each of the three modes.** Extract the selection into a
testable function if it is not already one.

Also assert that dev still uses the minimum quality, since compressing at 11 on every keystroke
rebuild would be a different regression.

---

## Part 2: custom 500 page

**Decision, do not re-litigate:** convention only. **No config key.** Do not add `errorPages`.

### Today

500 responses send **no body at all**. `onError` (`server.ts#L104-L126`) calls
`res.respond(500, …)` then `res.end()` with nothing.

404 already works by path convention: `is404Page` compares `getHttpPath(page.relativePagePath)`
to `/404`, and `mem.getPage()` falls back to `/404` (`mem.ts#L126-L132`).

### Required

- `src/pages/500.html` is detected by the **same path convention** and served on internal errors.
- If it does not exist, serve a **built-in minimal fallback** with a `content-type`. Not a blank
  body.
- The 500 page must be **transpiled and in memory before the server accepts requests**, because
  you cannot transpile during an error.
- **Guard against recursion.** If the 500 page itself throws, for example because it contains a
  server script that fails, do not loop. Fall back to the built-in body.
- The response must carry the security headers and a `content-type`.

### Preserve what is already correct

The current pipeline **does not leak** any source, environment variable, stack trace, or absolute
path to the client. Paths and traces go to stderr only.

**Preserve that property exactly while adding a body.** The 500 page is rendered from a page the
author wrote; it must not interpolate the error.

Add a test asserting no stack frame, file path, or error message appears in a 500 response body,
using a distinctive marker in the thrown error.

### Interaction with prompt 02

Prompt 02 added SKILL.md guidance saying a 500 page is meaningless in a static build and marked
the `--server` case **not yet implemented**. **Remove that marker** here; this is the prompt that
implements it.

Note the guidance remains true for static builds: a static host serves its own 500. Keep that
half.

---

## TDD steps

Write each failing test first.

1. Brotli quality is `BROTLI_MAX_QUALITY` under `--build`.
2. Brotli quality is `BROTLI_MAX_QUALITY` under `--server`. **It must fail.**
3. Brotli quality is `BROTLI_MIN_QUALITY` in dev.
4. `src/pages/500.html` is detected by path convention.
5. It is served on an internal error, with status 500.
6. Without it, the built-in fallback is served, with a `content-type` and a non-empty body.
7. **No stack frame, path, or error message appears in the body**, proven with a marker.
8. Security headers are present on the 500 response.
9. A 500 page that itself throws does **not** recurse, and falls back to the built-in body.
10. The 500 page is available immediately at boot, before the first request.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  A fixture route that reliably throws. Assert the custom 500 page renders with status 500, and
  that the thrown error's marker string is **absent** from the response body.
- `playwright.dev.config.ts`: the same, since a developer hitting a 500 should see the page too.
- `playwright.config.ts` (static build): assert that `500.html` is **present in the output** as a
  normal page, since a static host can be configured to use it. No error-triggering test, since
  there is no Bascik process. State that reasoning.

For compression, add an assertion in the server configs that a page response carries
`content-encoding: br` and that the body decompresses correctly. Comparing compressed sizes
across quality levels in an E2E is brittle; leave the quality assertion at the unit level.

## Documentation

| File                               | Change                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/server.md`           | Custom 404 and 500 by convention. No config key. The recursion guard. What the client sees versus what is logged                                                                         |
| `docs/content/internals/server.md` | Compression quality per mode. The 500 path and its fallback                                                                                                                              |
| `docs/content/performance.md`      | Pages are served at maximum brotli quality under `--server`. Only state a number if you measured one                                                                                     |
| `docs/content/faq.md`              | "How do I add a custom error page?"                                                                                                                                                      |
| `docs/src/pages/assets/SKILL.md`   | **Remove prompt 02's "not yet implemented" marker.** `src/pages/500.html` works under `--server`. Keep the guidance that a static build does not need one. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] All ten tests failed before their fixes and pass after.
- [ ] **`--server` compresses at maximum brotli quality**, asserted on the constant, not on
      output size.
- [ ] Dev still uses minimum quality.
- [ ] `src/pages/500.html` is served by convention, with a built-in fallback when absent.
- [ ] **No stack trace, path, or error message reaches the client**, proven with a marker.
- [ ] Security headers and a `content-type` are present on 500 responses.
- [ ] A throwing 500 page does not recurse.
- [ ] The 500 page is in memory before the first request.
- [ ] **No `errorPages` config key was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to dev and both server configs, plus the static presence check; the user has run
      `yarn e2e:all`.
- [ ] Prompt 02's "not yet implemented" marker is removed from both SKILL.md copies.

## Do not do

- Do not add `errorPages` or any config key for error pages.
- Do not interpolate the error into the 500 page.
- Do not change caching, ETags, or cache-control. **Prompt 39.**
- Do not add static asset compression. **Prompt 39.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
