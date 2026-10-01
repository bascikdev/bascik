# Releasing

Five artifacts ship from this repo. Each is versioned independently and released by pushing a git tag; `.github/workflows/release.yml` does the rest.

| Artifact | Registry | Tag | Version file |
| --- | --- | --- | --- |
| `@bascik/language-server` | npm | `lsp-v<version>` | `lsp/package.json` |
| `@bascik/bascik` | npm | `v<version>` | `pkg/package.json` |
| `create-bascik` | npm | `create-v<version>` | `create/package.json` |
| `@bascik/adapter-cloudflare` | npm | `adapter-cloudflare-v<version>` | `adapters/cloudflare/package.json` |
| Bascik VS Code extension | Marketplace | `ext-v<version>` or `ext-pre-v<version>` | `extensions/vscode-bascik/package.json` |

The tag must equal the prefix plus the `version` in that package's `package.json`, or the publish script fails before publishing anything.

## One-time setup

1. **npm:** the `bascik` organization must exist and `NPM_TOKEN` (repository secret) must be a granular token with publish rights to the `@bascik` scope and to `create-bascik`.
2. **Provenance:** npm provenance needs a public GitHub repository and a `repository.url` in each `package.json` that matches it. Both are already configured.
3. **Marketplace:** create the `bascik` publisher at https://marketplace.visualstudio.com/manage. Publishing authenticates with Microsoft Entra ID (`vsce publish --azure-credential`), not a personal access token, because Azure DevOps retires global PATs on December 1, 2026. Set up a user-assigned managed identity with a federated credential for GitHub Actions, add it to the publisher as a Contributor, and add a login step (for example `azure/login`, which needs `id-token: write` on the job) before the publish step in `release.yml`. See the "Secure automated publishing" section of the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). `publish-vsce.sh` falls back to a `VSCE_PAT` environment variable when one is set, which is only useful for local publishing before the retirement date.

## Publish order

Packages depend on each other, and `create-bascik` scaffolds projects that install the others from npm, so publish in this order and wait for each job to finish before starting the next group.

1. **`@bascik/language-server` and `@bascik/bascik`.** Neither depends on the other, so either may go first. Both must be on npm before anything in step 2.
2. **`create-bascik` and `@bascik/adapter-cloudflare`.** The scaffold pins `@bascik/bascik` and `@bascik/language-server`, and the adapter has a peer dependency on `@bascik/bascik`. Their order relative to each other does not matter.
3. **VS Code extension.** It does not depend on any npm package, so it can ship at any point, but release it last so it is tested against the published packages.

## Release candidate walkthrough

Release candidates use a semver prerelease version (`1.0.0-rc.1`) and publish under the `rc` dist-tag, so `npm install @bascik/bascik` never picks them up. Install one with `npm install @bascik/bascik@rc`.

1. Confirm the versions in each `package.json` are the intended RC versions, and that `create/src/scaffold.ts` and `adapters/cloudflare/package.json` reference ranges that include them (for example `^1.0.0-rc.1`).
2. Commit and push the version bumps to `main`.
3. Tag and push the first group, then wait for both jobs to succeed in the Actions tab:

   ```sh
   git tag lsp-v0.1.0-rc.1
   git tag v1.0.0-rc.1
   git push origin lsp-v0.1.0-rc.1 v1.0.0-rc.1
   ```

4. Confirm both resolve on the registry:

   ```sh
   npm view @bascik/language-server@rc version
   npm view @bascik/bascik@rc version
   ```

5. Tag and push the second group:

   ```sh
   git tag create-v1.0.0-rc.1
   git tag adapter-cloudflare-v1.0.0-rc.1
   git push origin create-v1.0.0-rc.1 adapter-cloudflare-v1.0.0-rc.1
   ```

6. Smoke test a clean scaffold from the registry:

   ```sh
   npm create bascik@rc my-site
   ```

Push tags by name rather than `--tags` so only the intended tags trigger jobs.

## Extension releases

The Marketplace rejects semver prerelease identifiers, so extension versions are plain `x.y.z`. Use the tag prefix to choose the channel:

- `ext-pre-v0.1.0` publishes with `vsce publish --pre-release` (opt-in for users).
- `ext-v0.2.0` publishes a stable release.

Pre-release and stable uploads must use different version numbers: if `0.1.0` is uploaded as a pre-release, the next stable release must be a distinct version. VS Code auto-updates every user to the highest version available, including pre-release users, so a stable version higher than the latest pre-release moves them onto stable. The Marketplace convention is to avoid surprises by using an odd minor for pre-releases and an even minor for stable (`0.1.*` pre-release, `0.2.*` stable). A version number can only be published once.

Pre-release support requires `engines.vscode` of at least 1.63.0; the extension currently declares `^1.90.0`. To check packaging locally without publishing:

```sh
cd extensions/vscode-bascik
npx @vscode/vsce@3 package --no-dependencies -o /tmp/bascik-ext.vsix
```

## Promoting a release candidate to stable

1. Bump each package to its stable version (`1.0.0`, `0.1.0`) and update dependent ranges if needed.
2. Tag and push in the same order as above, using the stable tags (`v1.0.0`, and so on). Stable versions publish under the `latest` dist-tag.
3. The `rc` dist-tag keeps pointing at the last candidate. That is harmless, but it can be moved with `npm dist-tag add <package>@<version> rc`.

## CI caveats

- The CI job `yarn create:test-site` installs the scaffolded project from npm, so it fails until the packages the scaffold references (`@bascik/bascik` and `@bascik/language-server`) are published.
- npm versions are immutable. A failed publish before the registry accepts it can be retried by re-running the job; a bad version that was accepted must be superseded with a new version, not republished.
- If a tag was pushed against the wrong commit before the job published, delete the tag locally and remotely, fix the commit, and tag again.
