# 04: Site URL, environment variables, and precedence

Read `.github/prompts/00-README.md` first. It carries the **precedence chain** and its
citations, which are decisions, not suggestions.

**Scope:** `pkg/src/lib/config.ts`, `userConfig.ts`, `cli.ts`, `sitemap.ts`,
`build-scripts.ts`, plus a new environment module.

---

## The decision

`siteUrl` is **removed from the config file entirely**. It is a per-deployment value, and
putting it in a checked-in file forces CI to mutate source in order to build for staging.

Three sources, in precedence order:

```
--site-url flag  >  BASCIK_SITE_URL env var  >  .env file
```

---

## `.env` loading

Node 24 has `process.loadEnvFile()` built in. **Add no dependency.** Do not add `dotenv`.

Three behaviors that are easy to get wrong:

### 1. A real environment variable must win over the `.env` file

The Node documentation specifies this for the `--env-file` **flag** but says **nothing** about
the `process.loadEnvFile()` **function**. Do not rely on unspecified behavior.

Snapshot which keys already exist in `process.env` before loading, and restore them afterward.
Write a test proving a real env var beats a `.env` file value.

### 2. A missing default `./.env` must be silent

Zero-config users must never see an error for not having a `.env` file.

But an **explicitly passed** `--env-file=<path>` that does not exist **must error**. This
mirrors Node's own `--env-file` versus `--env-file-if-exists` distinction.

### 3. `--env-file` is repeatable

Later files override earlier files, matching Node.

---

## Hard failure when required and missing

When a feature that needs the site URL is enabled and none of the three sources supply a value,
the build **fails**. It does not warn.

Today `sitemap.ts#L112` warns on **every build for every zero-config user**, because the
default is `generate.sitemap: true` with `siteUrl: undefined`. That trains people to ignore
Bascik warnings, which is worse than no warning at all.

The message must teach:

```text
error: BASCIK_SITE_URL is not set, but generate.sitemap is enabled.
  Set it one of these ways:
    BASCIK_SITE_URL=https://example.com bascik --build
    echo 'BASCIK_SITE_URL=https://example.com' >> .env
    bascik --build --site-url https://example.com
  Or disable the feature with generate.sitemap: false
```

Enumerate which features require it: sitemap generation, robots generation (for the `Sitemap:`
line), and any canonical URL helper. Check for others.

---

## Validation

The value must be an **absolute `http` or `https` URL**. Today `example.com` with no scheme
produces a sitemap full of invalid URLs, and the only handling is a trailing-slash trim at
`sitemap.ts#L120`. Reject it with a message showing what was received and what was expected.

---

## Direction matters

`BASCIK_SITE_URL` is **already written out** to build-script child processes
(`build-scripts.ts#L478`), where an unset `siteUrl` becomes an empty string, so scripts cannot
distinguish "unset" from "empty".

Making it also an **input** is consistent. Do not treat them as two different variables.
Document both directions, and fix the empty-string ambiguity while you are there.

---

## Document the general rule

This prompt establishes precedence for one value, but the rule applies to everything. Add a
**Configuration precedence** section to `docs/content/configuration.md` reproducing the chain
and its citations from `00-README.md`. That section becomes the page every other page links to.

---

## TDD steps

1. **Write the precedence tests first.** Real env beats `.env`. `--site-url` beats both. Each
   must fail before the implementation exists.
2. Missing default `./.env` is silent. Explicit `--env-file=missing` errors.
3. Multiple `--env-file` flags: the later file wins.
4. A key already in `process.env` is not overwritten by `loadEnvFile`, proven directly.
5. An invalid URL is rejected with a message naming the value.
6. Required-and-missing produces the exact teaching message, for each feature that requires it.
7. A build with the value set produces a correct sitemap and robots file.
8. `siteUrl` in a config file is either a type error or a validation error. Decide which and
   test it, so an upgrading user gets told rather than silently ignored.

## Testing

**Unit:** all of the above.

**E2E:**

- `playwright.config.ts` (static build): a build with `BASCIK_SITE_URL` set produces a sitemap
  containing absolute URLs with that origin.
- The other three configs: no new tests needed, since this is a build-time concern. State that
  reasoning.

Set the variable through the E2E harness rather than a checked-in `.env`, so the test proves
the env path works.

## Documentation

| File                             | Change                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`  | The **Configuration precedence** section with citations. `siteUrl` is not a key                                             |
| `docs/content/cli.md`            | `--site-url` and `--env-file`                                                                                               |
| `docs/content/sitemap.md`        | The site URL is an env var; missing is now a hard error, not a warning                                                      |
| `docs/content/deploying.md`      | Per-environment deploys without mutating source. Fix the stale `serve.port` reference at line 153 while you are in the file |
| `docs/content/build-scripts.md`  | `BASCIK_SITE_URL` is both an input and an output; unset is distinguishable from empty                                       |
| `docs/content/faq.md`            | "Why is `siteUrl` an environment variable and not a config option?"                                                         |
| `docs/src/pages/assets/SKILL.md` | Not a config key; three sources; precedence. Sync `create/assets/SKILL.md`                                                  |

## Acceptance criteria

- [ ] The precedence tests failed before and pass after.
- [ ] `siteUrl` is not a config key anywhere, and setting it is reported rather than ignored.
- [ ] `--site-url`, `BASCIK_SITE_URL`, and `.env` all work, in that precedence order.
- [ ] `--env-file` is repeatable, later wins, and a missing explicit path errors.
- [ ] A missing default `./.env` is silent.
- [ ] A real env var is provably not overwritten by `loadEnvFile`.
- [ ] An invalid URL is rejected with an actionable message.
- [ ] Required-and-missing fails the build with the teaching message.
- [ ] The zero-config sitemap warning no longer fires on every build.
- [ ] Build scripts can distinguish unset from empty.
- [ ] **No npm dependency was added.**
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The static-build E2E asserts absolute sitemap URLs; the user has run `yarn e2e:all`.
- [ ] Docs updated, both SKILL.md copies in sync.

## Do not do

- Do not add `dotenv` or any other dependency.
- Do not add a general `BASCIK_*` override for every config scalar. That is a large surface for
  little gain; if it is ever wanted it can be added later.
- Do not implement sitemap or robots generation changes beyond the URL source. Prompt 28 owns
  that file.
- Do not run Playwright or pre-push scripts.
