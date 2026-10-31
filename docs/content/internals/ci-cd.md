# CI / CD

Bascik uses three GitHub Actions workflows: one for continuous integration on every branch push and on pull requests from forks (which also deploys the docs and the Cloudflare adapter demo), one for CodeQL code scanning (`.github/workflows/codeql.yml`, `actions` and `javascript-typescript`, also run weekly), and one for publishing releases to npm when a version tag is pushed.

## Continuous Integration

The CI workflow (`.github/workflows/ci.yml`) runs on every push to any branch, and on pull requests targeting `main`.

```yaml
on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.ref == 'refs/heads/main' && format('ci-main-{0}', github.run_id) || format('ci-{0}', github.ref) }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

- **Tags never run it.** A `push` filter that lists only `branches` skips tag pushes; the release workflow handles tags.
- **Each commit is tested once.** A pull request from a branch of this repository is already tested by that branch's push run. The four Stage 1 jobs skip on such a `pull_request` event (`if: (github.event_name == 'push' && github.ref != 'refs/heads/main') || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)`), and every later job needs them directly or through another stage, so the rest of that run skips as well: a job whose `needs` was skipped is skipped, not failed. The push run's checks are on the branch's head commit, the same commit the pull request points at, so they show on the pull request. Its Checks list also shows the skipped `pull_request` jobs under the same names, and GitHub reports a skipped job as successful, so a required status check should be one the push run reports. A same-repo branch is tested as its own commit, not merged with `main`.
- **A fork's pull request** gets Stages 1 to 4 on the merge commit (`refs/pull/<n>/merge`) and never Stage 5.
- **A push to `main` only deploys.** It is a merged pull request whose branch already passed every stage, so the Stage 1 jobs skip on `main` and every test job after them skips too. The two deploy jobs still run: their `if` starts with GitHub's not-canceled status check, and a job whose `if` has a status check is evaluated even when the jobs it needs were skipped. On any other branch the same condition still requires every Stage 4 job to have succeeded.
- **A newer push to a branch cancels the older run**, its Preview upload included. Runs on `main` each get their own concurrency group, so none is canceled or left pending behind another. No job has a group of its own: a shared group holds only one pending job, so on `main` an older commit's deploy that queued later would cancel the newer commit's pending deploy.

It runs four gated test stages on Node 24 and Ubuntu, with a Windows job and a Node 22.22 job inside them, then a fifth stage that deploys. Every job in a stage waits for every job in the stage before it, so CI fails fast: a type error or a spelling mistake stops the run before any test starts, a failing unit test stops it before the slower integration tests, an integration failure stops it before the end-to-end matrix, and nothing deploys until every test has passed.

### Stage 1: Static Analysis, Typechecks, and Standards

- **Semgrep Static Analysis (`semgrep`)**: Security and vulnerability rulesets via `semgrep-action` (`p/default`).
- **Jelly Static Analysis (`jelly`)**: Object spread and control flow analysis via `@cs-au-dk/jelly` on `pkg/src/index.ts`.
- **Workspace Typechecks (`typecheck`)**: Runs `yarn typecheck:all` across `pkg/`, `create/`, `docs/`, `extensions/vscode-bascik/`, `adapters/cloudflare/`, `lsp/`, and `skills-tests/`.
- **Spelling & Web Standards (`standards`)**: Runs `yarn check:format` (Prettier), `yarn check:spelling` (codespell), and `yarn check:standards` (webhint).

### Stage 2: Unit Tests

Unit tests with coverage across `@bascik/bascik` (`yarn pkg:test:ci`), `create-bascik` (`yarn create:test:ci`), `bascik-docs` (`yarn docs:unit`), `bascik-skills-tests` (`yarn skills:unit`, job `unit-skills`), `extensions/vscode-bascik` (`yarn ext:unit`), `@bascik/adapter-cloudflare` (`yarn adapter:cf:test:ci`), and `@bascik/language-server` (`yarn lsp:test:ci`, job `unit-lsp`). The Windows job (`unit-windows`, `windows-latest`) runs the framework, language server, Cloudflare adapter, and `create-bascik` unit tests in this stage too, because Windows is a supported platform.

### Stage 3: Integration Tests and the Node 22.22 Floor

Integration tests spawn real processes, servers, browsers, and worker threads, so they start only after every unit job passes:

- **Framework Integration Tests (`integration-pkg`)**: `yarn pkg:integration`.
- **Docs Integration Tests (`integration-docs`)**: `yarn docs:integration`.
- **Agent Skills Integration Tests (`integration-skills`)**: `yarn skills:integration`, with Chromium installed for the `bascik-refactor` parity checks.
- **Node 22.22 Floor (`node-floor`)**: Builds every workspace and runs `yarn typecheck:all`, every workspace's unit tests, and the framework integration tests on the published engine floor, to prove the packages still work there.

### Stage 4: End-to-End Test Matrix

Runs after every Stage 3 job passes. The Playwright jobs install Chromium via `playwright install chromium`; the extension job downloads VS Code itself. The jobs execute:

- **Framework E2E (Static)**: `yarn pkg:e2e`
- **Framework E2E (Dev Server)**: `yarn pkg:e2e:dev`, `yarn pkg:e2e:dev:exec` (dev exec lifecycle), `yarn pkg:e2e:exec:policy` (exec failure policy), and `yarn pkg:e2e:exec:build` (build exec lifecycle)
- **Framework E2E (Production HTTP/1.1 Server)**: `yarn pkg:e2e:prod:http1`
- **Framework E2E (Production HTTP/2 TLS Server)**: `yarn pkg:e2e:prod:http2`
- **Cloudflare Adapter E2E (local workerd)**: `yarn adapter:cf:e2e`
- **Docs Site E2E**: `yarn docs:e2e`
- **Create Scaffold E2E**: `yarn create:test-site`
- **VS Code Extension E2E (real editor)** (`e2e-extension`): `xvfb-run -a yarn ext:e2e`, both configurations in `extensions/vscode-bascik/.vscode-test.cjs` in a real VS Code. `@vscode/test-cli` downloads the newest stable VS Code into `extensions/vscode-bascik/.vscode-test/`, which the job caches under a key that changes every ISO week; `xvfb-run` gives the Electron app a virtual display on Linux.

Each `pkg` lane runs as its own job, so CI does not use the local `yarn pkg:e2e:all` runner, which starts the same four lanes in parallel on one machine. Each lane uses its own ports and its own output directory (`BASCIK_E2E_OUT`, such as `pkg/e2e/dist-dev`), so the two setups behave the same. `pkg/e2e/scripts/run-lanes.test.ts` fails when a Playwright config in `pkg/e2e/` has no package script that a CI job runs, or when a published workspace's unit tests leave the Linux jobs that the end-to-end stage waits on, and `pkg/e2e/scripts/ci-deploy.test.ts` fails when a workspace's root `<prefix>:e2e` script (such as `ext:e2e`) is run by no CI job.

### Stage 5: Deploy to Cloudflare

Runs after every Stage 4 job passes, only for a branch push in this repository (never for a `pull_request` event, a tag, or a fork's own copy of the workflow), and deploys the two Cloudflare Workers this repo owns: the docs (`bascik`, served at bascik.dev) and the adapter demo (`cloudflare-adapter`, served at cloudflare-adapter.bascik.dev). `DEPLOYMENT.md` in the repository root is the runbook: credentials, manual deploys, and how to check what is live.

- **Deploy Docs (`deploy-docs`)**: checks out the full git history (`docs/scripts/generate-git-dates.ts` reads it for sitemap `lastmod` and article dates), runs `yarn pkg:build && yarn docs:build`, then runs Wrangler from `docs/`.
- **Deploy Adapter Demo (`deploy-demo`)**: runs `yarn adapter:cf:demo:build`, which builds the fixture in `adapters/cloudflare/e2e/fixture` with `--target cloudflare`, then runs Wrangler with `--config e2e/fixture/dist/.bascik/cloudflare/wrangler.jsonc` from `adapters/cloudflare`.
- **Publish Preview URLs (`preview-comment`)**: on a branch other than `main`, waits for both deploy jobs, writes both Preview URLs to the run's job summary, and, when the branch has an open pull request in this repository, creates or updates one comment on it that lists both URLs and the commit they were built from (`github.sha`, the branch commit the run tested). A branch without a pull request gets the summary only. The job is skipped when a deploy job uploaded nothing because its commit was no longer the newest.

What each event does:

| Event                                   | Stage 5                                                                                                                                                                                                                            |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main`                          | No tests. `wrangler deploy` for both Workers, then a check of `https://bascik.dev/` and `https://cloudflare-adapter.bascik.dev/catalog`. Never a Preview.                                                                          |
| Push to any other branch                | `wrangler versions upload --preview-alias <alias>` for both Workers: a Preview version that does not touch production. The alias comes from the branch name, so each branch keeps the same two URLs. Each Preview is then checked. |
| Pull request from a branch of this repo | Skipped with the rest of the run; the branch's push run deploys its Previews.                                                                                                                                                      |
| Pull request from a fork                | Skipped. Stage 5 runs only on push, and a fork's pull request gets no secrets.                                                                                                                                                     |
| Tag                                     | CI does not run.                                                                                                                                                                                                                   |

The helpers live in `.github/scripts/` and are tested by `pkg/e2e/scripts/ci-deploy.test.ts` in the framework unit tests:

- `preview-alias.mjs` turns the branch name (`github.ref_name`) into the alias. A name that is already a valid alias (lowercase `a-z`, `0-9` and `-`, starting with a letter, short enough) is used as is. Any other name is lowercased, every run of other characters becomes one `-`, a leading digit gets a `b-` prefix, and a hash of the full branch name is appended, so `feature/x` and `feature-x` do not share an alias and overwrite each other's Preview. A name too long for `<alias>-cloudflare-adapter` to fit in one 63-character DNS label is shortened before the hash.
- `newest-commit.mjs` compares the commit a run built with the branch tip from `git ls-remote`, so a deploy job skips Wrangler when the branch has moved on.
- `wrangler-preview-url.mjs` reads the Preview alias URL from Wrangler's machine-readable output (`WRANGLER_OUTPUT_FILE_PATH`, one JSON object per line), so no step parses Wrangler's log text.
- `smoke-test.mjs` requests each path without following redirects and fails the job unless every one answers with the expected status, retrying for about a minute while a new version propagates. The docs check includes the `301` redirects from `_redirects` and the `404` page.
- `preview-comment.mjs` writes the job summary, looks up the branch's open pull requests (`GET /repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open`), finds the comment by a hidden marker, written by `github-actions[bot]` only, and edits it, or creates it the first time.

On a branch a newer push cancels the running upload along with the rest of the older run, so a branch has one upload at a time. On `main` no deploy is canceled or waits for another, because the deploy jobs have no concurrency group of their own (a shared group would let a later-queued older deploy cancel a newer one that was pending). Runs still finish in any order, so when an older commit's tests finish after a newer commit has deployed, `newest-commit.mjs`, run right before Wrangler, skips the older upload or deploy instead of putting older code live. Two `main` deploys could only overlap if a newer commit were pushed, tested and deployed during the minute between an older run's check and the end of its `wrangler deploy`.

On `main`, `wrangler deploy` also attaches the custom domains in each config's `routes`. Wrangler runs without a terminal in CI and then replaces a conflicting custom domain or DNS record without asking, so a hostname goes into `routes` only once it is meant to move to that Worker.

The test also reads `ci.yml` and fails when a job is outside the five stages, when a job does not wait on every job of the stage before it, when an upload, deploy or smoke step is not gated on the newest-commit check, when a job has its own concurrency group, or when the Cloudflare token reaches anything but a Stage 5 Wrangler step. It evaluates the workflow's own `if:` conditions for a push to `main`, a branch push, a tag, a same-repo pull request, a fork's pull request and a push in a fork, and fails when `main` would get only a Preview, a branch push would not preview both Workers, a pull request or a tag would deploy, or a same-repo pull request would be tested twice.

All jobs enforce least-privilege with `permissions: contents: read`. The Preview URL job adds `pull-requests: write`. The Cloudflare credentials (secret `CLOUDFLARE_API_TOKEN`, variable `CLOUDFLARE_ACCOUNT_ID`) are set only on the Wrangler steps, not on the builds.

## Release Workflow

The release workflow (`.github/workflows/release.yml`) triggers on version tags. The four packages it publishes are **independently versioned and released**; pushing a tag only publishes the package that tag belongs to. The VS Code extension is published to the Marketplace by the same workflow. For the step-by-step publish order, see `RELEASING.md` in the repository root.

| Package                                | Tag format                                                | Example                     |
| -------------------------------------- | --------------------------------------------------------- | --------------------------- |
| `@bascik/bascik`                       | `v<semver>`                                               | `v1.2.0`                    |
| `create-bascik`                        | `create-v<semver>`                                        | `create-v1.0.3`             |
| `@bascik/adapter-cloudflare`           | `adapter-cloudflare-v<semver>`                            | `adapter-cloudflare-v1.0.0` |
| `@bascik/language-server`              | `lsp-v<semver>`                                           | `lsp-v0.1.0`                |
| Bascik VS Code extension (Marketplace) | `ext-v<semver>`, or `ext-pre-v<semver>` for a pre-release | `ext-v0.2.0`                |

Each job uses an `if:` guard so only the relevant package is built and published:

```yaml
jobs:
  release:
    if: startsWith(github.ref_name, 'v')
    # publishes @bascik/bascik

  release-create:
    if: startsWith(github.ref_name, 'create-v')
    # publishes create-bascik

  release-adapter-cloudflare:
    if: startsWith(github.ref_name, 'adapter-cloudflare-v')
    # publishes @bascik/adapter-cloudflare

  release-language-server:
    if: startsWith(github.ref_name, 'lsp-v')
    # publishes @bascik/language-server

  release-extension:
    if: startsWith(github.ref_name, 'ext-')
    # publishes the VS Code extension with vsce (Microsoft Entra ID credentials)
```

All jobs follow the same steps: check out the full history, check that the tagged commit is on `main`, install dependencies, build, run tests, then publish.

**Releases come only from `main`.** The step right after checkout runs `node .github/scripts/release-on-main.mjs "$GITHUB_REF_NAME" "$GITHUB_SHA"`. It dereferences the tag to its commit and fails the job, naming the tag and the commit, unless that commit is an ancestor of `origin/main` (`git merge-base --is-ancestor`), so a tag pushed on an unmerged branch publishes nothing. The checkout uses `fetch-depth: 0`, because `actions/checkout` otherwise fetches only the tagged commit and `origin/main` would be missing; the script reports that case as a checkout error, not as "not on main". `pkg/e2e/scripts/release-on-main.test.ts` runs the script against a real throwaway repository and fails when a publish job in `release.yml` lacks the check right after a full-history checkout.

## Publishing to npm

All packages publish to the public npm registry under the `bascik` organization using a granular access token stored as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions). Every job calls `.github/scripts/publish-npm.sh <tag-prefix>` from the package directory:

```yaml
- name: Publish to npm
  working-directory: pkg
  run: ${{ github.workspace }}/.github/scripts/publish-npm.sh v
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The script fails unless the git tag equals the prefix plus the `version` in the package's `package.json`, then runs `npm publish --provenance --access public --tag <dist-tag>`:

- `--access public`: required for scoped packages and explicit for `create-bascik`. Each `package.json` also declares `"publishConfig": { "access": "public" }` as a belt-and-suspenders default.
- `--provenance`: generates a signed attestation on npmjs.com that links the published package to the exact GitHub Actions run that built it. This requires `id-token: write` permission on the job and a `repository.url` in `package.json` that matches the GitHub repository.
- `--tag`: `latest` for stable versions. A prerelease such as `1.0.0-rc.1` publishes under the identifier before the first dot (`rc`), so `npm install <pkg>` never picks it up by default.

## Tagging a Release

### `@bascik/bascik`

Tag the commit on `main`, after the release pull request is merged:

```sh
# 1. On a branch: bump the version in pkg/package.json, update CHANGELOG.md, commit
# 2. Merge the branch into main through a pull request
git fetch origin main
git tag v1.2.0 origin/main
git push origin v1.2.0
```

### `create-bascik`

```sh
# 1. On a branch: bump the version in create/package.json, commit
# 2. Merge the branch into main through a pull request
git fetch origin main
git tag create-v1.0.3 origin/main
git push origin create-v1.0.3
```

### `@bascik/adapter-cloudflare` and `@bascik/language-server`

```sh
# Bump the version in lsp/package.json and merge it into main through a pull request, then:
git fetch origin main
git tag lsp-v0.1.0 origin/main
git push origin lsp-v0.1.0
# After @bascik/bascik is on npm, bump the version in adapters/cloudflare/package.json and merge it, then:
git fetch origin main
git tag adapter-cloudflare-v1.0.0 origin/main
git push origin adapter-cloudflare-v1.0.0
```

Push each tag by name, never with `git push --tags`, which pushes every local tag (stale ones from a dry run included) and can start a publish job out of the order in `RELEASING.md`.

### Release candidates

Use a prerelease version and the matching tag, for example `1.0.0-rc.1` with `v1.0.0-rc.1`. Publish `@bascik/language-server` and `@bascik/bascik` first, then the packages that depend on them (`create-bascik` and `@bascik/adapter-cloudflare`). Install with `npm install @bascik/bascik@rc`. Dependents pin a range that includes the prerelease (for example `^1.0.0-rc.1`), which also accepts the final `1.0.0`.

The release workflow picks up the tag, runs tests, builds `dist/` (which is not committed to git), and publishes to npm.

> **Prerequisite.** The `NPM_TOKEN` secret must be set in the repository before pushing a release tag, or the publish step will fail.
