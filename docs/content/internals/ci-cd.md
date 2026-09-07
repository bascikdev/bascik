# CI / CD

Bascik uses two GitHub Actions workflows: one for continuous integration on every push and pull request, and one for publishing releases to npm when a version tag is pushed.

## Continuous Integration

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request targeting `main`.

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

It executes across three structured stages on Node 24:

### Stage 1: Static Analysis, Typechecks, Standards & Unit Tests (Parallel)

- **Jelly Static Analysis (`jelly`)**: Object spread and control flow analysis via `@cs-au-dk/jelly` on `pkg/src/index.ts`.
- **Workspace Typechecks (`typecheck`)**: Runs `yarn typecheck:all` across `pkg/`, `create/`, `docs/`, and `extensions/vscode-bascik/`.
- **Spelling & Web Standards (`standards`)**: Runs `yarn check:spelling` (codespell) and `yarn check:standards` (webhint).
- **Unit Test Matrix**: Parallel test execution with coverage across `@bascik/bascik` (`yarn pkg:test:ci`), `create-bascik` (`yarn create:test:ci`), `bascik-docs` (`yarn docs:test`), and `extensions/vscode-bascik` (`xvfb-run -a yarn ext:test`).

### Stage 2: End-to-End Test Matrix (Parallel)

Runs after all Stage 1 jobs pass. Installs Chromium via `playwright install chromium` and executes:

- **Framework E2E (Static)**: `yarn pkg:e2e`
- **Framework E2E (Dev Server & Dev Exec Lifecycle)**: `yarn pkg:e2e:dev` and `yarn pkg:e2e:dev:exec`
- **Framework E2E (Production HTTP/1.1 Server)**: `yarn pkg:e2e:prod:http1`
- **Framework E2E (Production HTTP/2 TLS Server)**: `yarn pkg:e2e:prod:http2`
- **Docs Site E2E**: `yarn docs:e2e`
- **Create Scaffold E2E**: `yarn create:test-site`

### Stage 3: Semgrep Static Analysis

Runs comprehensive security and vulnerability rulesets via `semgrep-action` (`p/default`) after all E2E test suites pass.

All jobs enforce least-privilege with `permissions: contents: read`.

## Release Workflow

The release workflow (`.github/workflows/release.yml`) triggers on version tags. The two packages are **independently versioned and released**; pushing a tag only publishes the package that tag belongs to.

| Package | Tag format | Example |
| --- | --- | --- |
| `@bascik/bascik` | `v<semver>` | `v1.2.0` |
| `create-bascik` | `create-v<semver>` | `create-v1.0.3` |

Each job uses an `if:` guard so only the relevant package is built and published:

```yaml
jobs:
  release:
    if: startsWith(github.ref_name, 'v')
    # publishes @bascik/bascik

  release-create:
    if: startsWith(github.ref_name, 'create-v')
    # publishes create-bascik
```

Both jobs follow the same steps: install dependencies, run tests, build, then publish.

## Publishing to npm

Both packages publish to the public npm registry using a granular access token stored as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).

```yaml
- name: Publish to npm
  run: npm publish --provenance --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Two flags are always passed:

- `--access public`: required for scoped packages (`@bascik/bascik`) and explicit for `create-bascik`. Both `package.json` files also declare `"publishConfig": { "access": "public" }` as a belt-and-suspenders default.
- `--provenance`: generates a signed attestation on npmjs.com that links the published package to the exact GitHub Actions run that built it. This requires `id-token: write` permission on the job.

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

The release workflow picks up the tag, runs tests, builds `dist/` (which is not committed to git), and publishes to npm.

> **Prerequisite.** The `NPM_TOKEN` secret must be set in the repository before pushing a release tag, or the publish step will fail.
