# 05: Config validation

Read `.github/prompts/00-README.md` first.

**Scope:** a new validation module plus `pkg/src/lib/config.ts`. Consumes the shape from
prompt 03 and the environment sources from prompt 04.

---

## The problem

**There is no config validation today.** `initBascikConfig` (`config.ts#L198`) does two
`typeof === "object"` guards and one `exec.phase` enum check. Everything else is merged
verbatim, and unknown keys are silently carried into the frozen object.

The result is that a wrong value surfaces as a confusing runtime failure, far from its cause,
or does not surface at all.

---

## Required checks

Each produces an error naming the **key**, the **received value**, and what was **expected**.

| Check                                                          | Failure mode today                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown top-level keys                                         | A typo such as `directroy:` or `minfy:` is silently merged and ignored                                                                             |
| `directory.pages` exists and is a directory                    | A typo yields a successful empty build; prompt 12 covers the runtime half                                                                          |
| `directory.out` does not escape the project root               | `directory: { out: "../../.." }` is accepted                                                                                                       |
| `directory.public` exists when set                             | Silently copies nothing                                                                                                                            |
| `http.port` is an integer in 1 to 65535                        | `70000` produces `RangeError: No available ports found between 70000 and 65535`; the string `"8080"` makes `p + 1` produce `"80801"` on EADDRINUSE |
| `http.hostname` is a plausible host                            | A URL or a path is accepted                                                                                                                        |
| `scripts.timeout` is a positive number                         | `0` or a negative value kills every script instantly                                                                                               |
| `minify.css` and `minify.js` are boolean or function           | A string is truthy, takes the custom-minifier branch at `processing.ts#L202`, and fails at call time inside the transpile loop                     |
| `onBuildScriptError` and friends are a known value             | A typo such as `"erorr"` degrades silently to `warn`, the opposite of intent on the exact option set to make builds fail loudly                    |
| `http.tls.keyFile` and `certFile` readable when TLS is enabled | A raw Node fs error from `http2.ts#L63-L64`                                                                                                        |
| `pipeline.watchPaths` entries exist                            | A wrong path silently watches nothing (`watch.ts#L133`)                                                                                            |
| `assets.inlineStyles` entries exist                            | Same (`watch.ts#L154`)                                                                                                                             |
| `pipeline.exec[].script` exists                                | Surfaces as a spawn error mid-build (`exec.ts#L25`)                                                                                                |
| `pipeline.exec[].phase` is known                               | Already checked at `config.ts#L152-L167`; fold it into the new pass                                                                                |
| `pipeline.workers` is a boolean or a positive integer          | Undefined behavior                                                                                                                                 |
| `base` is a normalized path, not a URL                         | Undefined behavior; prompt 22 depends on this                                                                                                      |
| `scoping.preserve` entries are plausible tag names             | A malformed entry produces a broken regex                                                                                                          |
| `assets.exclude` entries are valid globs                       | Silently matches nothing                                                                                                                           |
| Site URL is an absolute http(s) URL when required              | Prompt 04 owns this; make sure it runs in the same pass so all errors report together                                                              |

---

## Design requirements

**Aggregate.** Report every validation failure together, not one per run. Fixing one at a time
is a serial debugging loop.

**Separate pure from I/O.** Path-existence and readability checks need the filesystem; type,
range, and enum checks do not. Keep them in separate functions so the pure half unit tests
without any mocking, and inject the filesystem for the other half. Do not use a global "skip
checks in tests" flag.

**Run once**, at config resolution, before anything consumes the config.

**Normalize where sensible.** `base` should be normalized to a leading and trailing slash
rather than rejected for missing one. Reject only what cannot be interpreted.

---

## Error output

Group by key. Show the value. Suggest when you can.

```text
Configuration errors in bascik.config.ts

  http.port                70000
                           expected an integer between 1 and 65535

  minify.js                "esbuild"
                           expected true, false, or a function

  scripts.onBuildScriptErr unknown key
                           did you mean scripts.onBuildScriptError?

  pipeline.exec[0].script  scripts/gen-data.ts
                           file does not exist

4 configuration errors
```

Unknown-key suggestions should use a simple edit-distance check against the known key set.

---

## TDD steps

1. Write one failing test per row of the table, asserting the message names the key and the
   received value. Do this **before** any implementation.
2. Aggregation: a config with four distinct problems reports all four.
3. Unknown-key suggestion fires for a near-miss and does not fire for something unrelated.
4. `base` normalization: `'/sub'`, `'sub'`, `'/sub/'`, and `'/a/b'` all normalize; an absolute
   URL is rejected; `'/'` stays `'/'`.
5. The pure half runs with no filesystem access, proven by asserting no `fs` call occurs.
6. A fully valid config produces zero errors and does not slow the build measurably.

## Testing

**Unit:** all of the above, in a dedicated `config-validation.test.ts`.

**E2E:** none. Validation runs before any server or build output exists, and no E2E config can
observe it. State that reasoning.

**Verification:** deliberately break `docs/bascik.config.ts`, run `yarn docs:build`, confirm
the error is clear, then restore it.

## Documentation

| File                             | Change                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`  | A short section: config is validated at startup and errors are reported together            |
| `docs/content/faq.md`            | "Why did my build fail with a configuration error?" if the existing FAQ has nothing close   |
| `docs/src/pages/assets/SKILL.md` | Config is validated, so a typo is caught rather than ignored. Sync `create/assets/SKILL.md` |

## Acceptance criteria

- [ ] Every row of the table has a failing-first test that now passes.
- [ ] Every message names the key, the received value, and the expectation.
- [ ] Errors are aggregated, not reported one at a time.
- [ ] Unknown keys are rejected with a near-miss suggestion.
- [ ] `base` is normalized rather than rejected for a missing slash.
- [ ] The pure validation half performs no filesystem access.
- [ ] A valid config produces no errors and no measurable slowdown.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] `yarn pkg:build && yarn docs:build` succeed.

## Do not do

- Do not implement behavior for any key you are validating. Validation only.
- Do not add a schema library. Hand-written checks are clearer here and add no dependency.
- Do not use a global flag to skip checks in tests. Inject the filesystem.
- Do not run Playwright or pre-push scripts.
