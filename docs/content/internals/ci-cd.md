# CI / CD

Bascik uses three GitHub Actions workflows: one for continuous integration on every push and pull request, one for CodeQL code scanning (`.github/workflows/codeql.yml`, `actions` and `javascript-typescript`, also run weekly), and one for publishing releases to npm when a version tag is pushed.

## Continuous Integration

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request targeting `main`.

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

It runs four gated stages on Node 24 and Ubuntu, with a Windows job and a Node 22.22 job inside them. Every job in a stage waits for every job in the stage before it, so CI fails fast: a type error or a spelling mistake stops the run before any test starts, a failing unit test stops it before the slower integration tests, and an integration failure stops it before the end-to-end matrix.

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

Runs after every Stage 3 job passes. Installs Chromium via `playwright install chromium` and executes:

- **Framework E2E (Static)**: `yarn pkg:e2e`
- **Framework E2E (Dev Server)**: `yarn pkg:e2e:dev`, `yarn pkg:e2e:dev:exec` (dev exec lifecycle), `yarn pkg:e2e:exec:policy` (exec failure policy), and `yarn pkg:e2e:exec:build` (build exec lifecycle)
- **Framework E2E (Production HTTP/1.1 Server)**: `yarn pkg:e2e:prod:http1`
- **Framework E2E (Production HTTP/2 TLS Server)**: `yarn pkg:e2e:prod:http2`
- **Cloudflare Adapter E2E (local workerd)**: `yarn adapter:cf:e2e`
- **Docs Site E2E**: `yarn docs:e2e`
- **Create Scaffold E2E**: `yarn create:test-site`

Each `pkg` lane runs as its own job, so CI does not use the local `yarn pkg:e2e:all` runner, which starts the same four lanes in parallel on one machine. Each lane uses its own ports and its own output directory (`BASCIK_E2E_OUT`, such as `pkg/e2e/dist-dev`), so the two setups behave the same. `pkg/e2e/scripts/run-lanes.test.ts` fails when a Playwright config in `pkg/e2e/` has no package script that a CI job runs, or when a published workspace's unit tests leave the Linux jobs that the end-to-end stage waits on.

All jobs enforce least-privilege with `permissions: contents: read`.

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

All jobs follow the same steps: install dependencies, build, run tests, then publish.

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

```sh
# 1. Bump version in pkg/package.json
# 2. Update CHANGELOG.md
git add pkg/package.json CHANGELOG.md
git commit -m "chore: release v1.2.0"
git tag v1.2.0
git push origin main --tags
```

### `create-bascik`

```sh
# 1. Bump version in create/package.json
git add create/package.json
git commit -m "chore: release create-bascik v1.0.3"
git tag create-v1.0.3
git push origin main --tags
```

### `@bascik/adapter-cloudflare` and `@bascik/language-server`

```sh
# Bump version in adapters/cloudflare/package.json, then:
git tag adapter-cloudflare-v1.0.0
# Bump version in lsp/package.json, then:
git tag lsp-v0.1.0
git push origin main --tags
```

### Release candidates

Use a prerelease version and the matching tag, for example `1.0.0-rc.1` with `v1.0.0-rc.1`. Publish `@bascik/language-server` and `@bascik/bascik` first, then the packages that depend on them (`create-bascik` and `@bascik/adapter-cloudflare`). Install with `npm install @bascik/bascik@rc`. Dependents pin a range that includes the prerelease (for example `^1.0.0-rc.1`), which also accepts the final `1.0.0`.

The release workflow picks up the tag, runs tests, builds `dist/` (which is not committed to git), and publishes to npm.

> **Prerequisite.** The `NPM_TOKEN` secret must be set in the repository before pushing a release tag, or the publish step will fail.
