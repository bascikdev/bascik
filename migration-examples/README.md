# Local migration example validation

This is an authoring harness, not a framework port, starter catalog, or release.
It is deliberately **not** a Yarn workspace. Projects under `ports/` will be
standalone npm projects with their own dependency declarations and lockfiles.
Independent templates belong in the future top-level `templates/` directory.

## Layout and trust boundaries

- `sources/*.json`: approved repository, immutable commit, selected subdirectory,
  archive SHA-256, license path, and future dependency-lockfile location.
- `.upstream/<id>/`: gitignored pinned input. Fetching verifies the whole archive
  before extracting the selected input and original license. It installs nothing,
  executes no downloaded code, and refuses to replace an existing cache.
- `ports/`: Bascik adaptations (`astro-blog`, `eleventy-blog`).
- `fixtures/`: original tiny test sites only, not upstream sample content.
- `harness/`: Node's built-in test runner and explicit browser-tool reuse.

The Astro cache retains `examples/blog/` and the root MIT license. The Eleventy
cache retains its repository root, including its original license and lockfile.
These inputs are not committed or modified by parity tests. Review code, sample
content, fonts, artwork, and dependency install scripts separately before reuse.
Upstream sample assets remain reference inputs only. Do not copy them into ports.

## Reproduce task 02

From the repository root:

1. `npm --prefix migration-examples ci --ignore-scripts`
2. `npm --prefix migration-examples run test:unit`
3. `npm --prefix migration-examples run test:integration`
4. `yarn pkg:build`
5. `yarn workspace @bascik/bascik pack --out /tmp/bascik-task02.tgz`
6. `BASCIK_TARBALL=/tmp/bascik-task02.tgz npm --prefix migration-examples run test:browser`

Browser validation explicitly loads the existing monorepo `@playwright/test`
tool via `pkg/package.json`. It needs the monorepo dependencies and a Playwright
Chromium installation. It does not download tools through `npx` or silently
install missing browsers. The harness itself has no npm dependencies.

Tested on macOS with Node **24.21.0**, npm **11.19.0**, Yarn **4.18.0**,
`@playwright/test` **1.62.1**, and local-source Bascik **1.0.0-rc.3**. The smoke test asserts the installed version equals
`pkg/package.json`. That catches a tarball from a different version, not one packed earlier from the
same version, so run `yarn pkg:build` and a fresh pack before every run.
Node 24 is the tested harness requirement, not an approved template support floor.
No released-package validation has been performed.

The browser check copies both projects into a temporary directory outside the
repository, installs the local tarball only into the Bascik copy, verifies its
real package path, builds with identifier minification enabled, and serves
production HTTP/1.1. Optional Bascik dependencies are omitted for this tiny
static fixture. Its tarball install generates a temporary lockfile containing
the exact artifact; that machine-local lockfile is removed with the copy.
The authoring Bascik fixture has no committed tarball-dependent lockfile and
must not be treated as a distributable starter. The harness and dependency-free
original fixture have committed npm lockfiles.

## Fetch the approved inputs

- `npm --prefix migration-examples run fetch -- astro-blog`
- `npm --prefix migration-examples run fetch -- eleventy-base-blog`

Fetching requires `curl`, `tar`, and network access to `codeload.github.com`.
Existing cache directories cause a nonzero exit instead of overwriting authored
lockfiles or installs. After reviewing or archiving any local work, remove only
that ignored source cache explicitly to fetch it again. Checksums pin archive
bytes, not just a moving branch name.

Tasks 03 and 04 must capture/review dependency lockfiles beside their manifests
before claiming reproducible upstream builds. Astro has no upstream lockfile.
Use `npm install --ignore-scripts --before=2026-09-25` to capture its dependency
tree for the October 2 record, then retain the generated lockfile as
`sources/astro-blog.package-lock.json`. Later runs copy it into the isolated
upstream project and use `npm ci --ignore-scripts`. For Eleventy, review its
pinned existing lockfile and retain it as `sources/eleventy-base-blog.package-lock.json`.
Do not install dependencies in either authoring input during harness checks.
If esbuild needs its verified platform setup, allow only `npm rebuild esbuild`.
Read and record any other package's lifecycle scripts before authorizing them.

## Add a target-specific check

`runPair({ upstream, bascik, prepare, check, timeoutMs, observe })` copies each
source into distinct temporary project roots. Each spec supplies `source`,
optional `build` command array, `serve` command array, optional `env`, and
optional `readyPath`. Servers receive distinct `PORT` values and loopback `HOST`.
Commands run without a shell; use each framework's explicit host/port options
or an environment-reading wrapper. Binding races fail rather than reusing an
existing listener. No global shared output directory is used.

The optional `prepare(name, site)` callback installs the target's locked
dependencies **only in its isolated copy**. Installation commands are owned by
that callback and must be stopped in `finally`, as demonstrated in the browser
test. `NODE_PATH` and `NODE_OPTIONS` are removed from child environments to avoid
parent resolution hooks. There is no generalized package installation layer.

The `check(sites, signal)` callback receives both URLs and writes explicit
route/content/interaction assertions. Honor its cancellation signal for
long-running requests. A build error, startup error, server exit, check failure,
or deadline fails the run. The runner stops owned POSIX process groups, escalates
to SIGKILL, joins direct child closure, and removes both temporary projects in
`finally`. SIGINT/SIGTERM cancel readiness and checks. Windows process-tree
cleanup is not implemented or tested. A forcibly killed harness cannot run
its own cleanup.

Retained integration controls intentionally change only temporary copies. They
reject wrong content, a missing route, build exit 9, startup exit 7, and a server
that never listens; a corrected fixture passes. Another control proves a
SIGTERM-resistant descendant is stopped after a check failure. Cleanup assertions
check deleted directories, dead process IDs, and unreachable server URLs.

The Chromium smoke checks both sites' home/about routes, keyboard link activation,
a missing route, mobile horizontal overflow, and the Bascik component's computed
color. It uses `data-testid` and `getByTestId`, not compiler-specific class names.
This does not establish accessibility compliance or framework-wide parity.
Dev/SSE, production HTTP/2/TLS, full monorepo suites, and actual Astro/Eleventy
builds are outside this independent task's acceptance checks.

## Task 03: Astro blog port

Port: `ports/astro-blog/` (see its README and NOTICE.md). Behavior checks:
`harness/astro-blog-checks.mjs`, expectations in `harness/astro-blog-expected.mjs`, runner in
`harness/astro-blog.test.mjs`. The dependency lockfile for the pinned upstream is
`sources/astro-blog.package-lock.json`.

1. `npm --prefix migration-examples ci --ignore-scripts`
2. `npm --prefix migration-examples run fetch -- astro-blog` (once; skip if `.upstream/astro-blog` exists)
3. `yarn pkg:build && yarn workspace @bascik/bascik pack --out /tmp/bascik-task03.tgz`
4. `BASCIK_TARBALL=/tmp/bascik-task03.tgz npm --prefix migration-examples run test:astro`

`ASTRO_LANE=production|dev|control` selects one lane. With `BASCIK_TARBALL` set, every lane installs
that locally packed Bascik (required to test unreleased fixes). Without it, lanes use the registry release. Each lane copies the pinned upstream and
the port into separate temporary directories outside the repository, installs the upstream from the
retained lockfile with `npm ci --ignore-scripts` plus `npm rebuild esbuild`, and installs the port
with `npm ci --ignore-scripts` (then installs the packed tarball over the registry release when
`BASCIK_TARBALL` is set). The same checks run against both sites with Chromium. The `control` lane proves the checks
reject a site that is not the blog.
