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

It runs two parallel jobs across Node 24:

**`test`**: unit tests with coverage:

```sh
yarn pkg:test:ci
```

**`e2e`**: end-to-end Playwright tests against the built fixture site:

```sh
yarn pkg:build && yarn pkg:e2e
```

The `e2e` job installs only the Chromium browser via `playwright install chromium` before running. Both jobs have `permissions: contents: read` to enforce least privilege.

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
