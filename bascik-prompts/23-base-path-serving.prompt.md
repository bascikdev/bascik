# 23: Serving under `base` and generated artifacts

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts`, `pkg/src/lib/serve.ts`, `pkg/src/lib/sitemap.ts`,
`pkg/src/lib/build-scripts.ts`, `pkg/src/lib/processing.ts`.

**Depends on prompt 22**, which built the output transform. This prompt completes the feature so
a subdirectory deploy is previewable locally and its generated artifacts are correct.

---

## Part 1: serve under `base`

With `base: '/sub/'`, a request for `/sub/about` must serve the page that a request for
`/about` serves when `base` is `'/'`.

Both the dev server and `bascik --server` must do this, so a subdirectory deploy can be
previewed locally without a proxy.

### Where the prefix is stripped

The request pipeline order today (`server.ts#L129-L451`) is: rate limit, method guard, empty
path, `decodeURIComponent`, traversal check, static branch, SSE branch, in-memory page lookup.
Prompt 10 added a dot-segment guard after the traversal check.

Strip the base prefix **after decoding and after the traversal guard**, so a traversal attempt
cannot use the prefix to smuggle anything, and **before** the static branch and the page lookup,
so both see a base-relative path.

Add a test asserting the guards still fire on a prefixed path. `/sub/../../etc/passwd` must be
rejected exactly as `/../../etc/passwd` is.

### Requests without the prefix

Decide and document what `/about` does when `base` is `/sub/`.

A **301 redirect** to `/sub/about` is friendlier and helps someone who forgot the prefix. A
**404** is stricter and matches what a real static host would do.

Pick one, document it in `docs/content/deploying.md`, and test it. Whichever you choose, be
consistent across dev and both server modes.

### Live reload must work under `base`

**This is the easy thing to miss.** The SSE endpoint must be reachable under the prefix, and the
**injected client script must connect to the right path**.

Get this wrong and you get a dev server that looks completely fine but never reloads, which is
a miserable thing to debug. Test it explicitly.

---

## Part 2: generated artifacts

Compose full URLs as `site URL` + `base` + `path`.

| Artifact                            | Change           |
| ----------------------------------- | ---------------- |
| `sitemap.xml` `<loc>` entries       | Include the base |
| The `Sitemap:` line in `robots.txt` | Include the base |
| Any canonical URL helper            | Include the base |

Prompt 04 made the site URL an environment variable. Prompt 09 unified the path-to-URL function.
Provide **one composition helper** that takes a page path and returns the full absolute URL, and
use it everywhere. Do not compose by string concatenation at each call site.

**Prompt 28 owns the sitemap and robots files.** If prompt 28 has already landed, integrate with
its code. If not, wire the helper into the current sitemap code and leave a one-line comment so
prompt 28 finds it.

---

## Part 3: the JavaScript workaround

Bascik does **not** rewrite URLs constructed in JavaScript, and will not. Document the
workaround rather than leaving authors stuck.

Add a `BASCIK_BASE` environment variable alongside the existing `BASCIK_SITE_URL`,
`BASCIK_PAGE_PATH`, and friends in `build-scripts.ts`, so a build script can emit the value.

Then document the recommended pattern, framed as an **illustrative example** rather than a
prescribed API:

```html
<!-- Emit the base once, at build time, into a data attribute. -->
<script data-bascik-build>
  console.log(`data-base="${process.env.BASCIK_BASE ?? "/"}"`);
</script>
```

Client code reads it from the DOM. Explain that this keeps the value build-time and adds no
runtime.

---

## TDD steps

Write each failing test first.

1. With `base: '/sub/'`, a request for `/sub/about` serves the about page, in dev and in both
   server modes.
2. `/sub/index.html` and `/sub/` both resolve correctly.
3. A request for `/about` behaves per the documented decision.
4. `/sub/../../etc/passwd` is rejected exactly as the unprefixed form is.
5. An encoded prefix attempt, `/%73ub/about`, does not bypass anything.
6. A static asset under the prefix is served.
7. The dot-segment guard from prompt 10 still fires under the prefix.
8. The SSE endpoint is reachable under the prefix.
9. **The injected live-reload client script targets the prefixed path.**
10. `base: '/'` leaves every one of the above behaving exactly as today.
11. Sitemap `<loc>` entries compose site URL, base, and path, in that order, with no doubled or
    missing slash.
12. The robots `Sitemap:` line composes the same way.
13. `BASCIK_BASE` reaches a build script, and is `'/'` when unset.

For 11 and 12, test the slash-boundary cases specifically: base ending in `/` plus a path
starting with `/` must not produce `//`.

## Testing

**Unit:** all of the above.

**E2E:** this is where prompt 22's deferred dev and server tests land. Use the `base: '/sub/'`
fixture site prompt 22 created.

- `playwright.dev.config.ts`: navigate the fixture site end to end under the prefix. **Assert
  live reload actually fires**: edit a source file and confirm the page updates. That is the
  test that catches the missed SSE path.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: navigate under the
  prefix; assert the documented behavior for an unprefixed request; assert a static asset
  resolves.
- `playwright.config.ts` (static build): prompt 22 covered output correctness. Add one check
  here that the generated `sitemap.xml` contains the base-prefixed URLs, since that is new in
  this prompt.

Also assert that the `base: '/'` fixture still behaves identically in all four configs.

## Documentation

| File                               | Change                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/deploying.md`        | A **Subdirectory deploys** section. What `base` does, GitHub Pages project sites as the motivating example, a complete working config, the unprefixed-request behavior, and the note that a custom domain avoids the need entirely |
| `docs/content/sitemap.md`          | Generated URLs compose site URL, base, and path                                                                                                                                                                                    |
| `docs/content/build-scripts.md`    | `BASCIK_BASE` is available                                                                                                                                                                                                         |
| `docs/content/faq.md`              | "How do I deploy to `example.com/docs` instead of `example.com`?" and "Why is my `fetch('/api/x')` broken under `base`?" with the workaround                                                                                       |
| `docs/content/internals/server.md` | Where the prefix is stripped in the request pipeline, and why it sits after the traversal guard                                                                                                                                    |
| `docs/src/pages/assets/SKILL.md`   | `base` exists, defaults to `'/'`, rewrites root-relative URLs in output, and does **not** touch URLs built in JavaScript. Gotcha explicit. Sync `create/assets/SKILL.md`                                                           |

## Acceptance criteria

- [ ] All thirteen tests failed before their fixes and pass after.
- [ ] Dev and both server modes serve correctly under `base`.
- [ ] The prefix is stripped after decoding and after the traversal guard; every guard still
      fires on a prefixed path.
- [ ] The unprefixed-request behavior is decided, documented, and consistent across all modes.
- [ ] **Live reload connects and fires under `base`**, proven by a dev E2E that edits a file.
- [ ] Sitemap, robots, and canonical URLs compose correctly with no doubled or missing slash.
- [ ] There is **one** composition helper, used everywhere.
- [ ] `BASCIK_BASE` reaches build scripts and defaults to `'/'`.
- [ ] `base: '/'` behaves identically to before, in all four E2E configs.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] Docs updated; both SKILL.md copies in sync.

## Do not do

- Do not change the output transform. Prompt 22 owns it.
- Do not rewrite URLs constructed in JavaScript, and do not inject a runtime helper. Document
  the workaround instead.
- Do not restructure the request pipeline guard order beyond inserting the strip.
- Do not implement sitemap authored-file precedence or exclusion. Prompt 28.
- Do not run Playwright, bind a port, or `curl` in the sandbox.
