# Releasing

## Release

Update package versions and dependent ranges, pass CI, and merge into `main`.
Then, with Node 24, Git, and an authenticated GitHub CLI:

```sh
yarn release                       # Publish all five artifacts
yarn release pkg lsp               # Publish only selected packages
yarn release create cloudflare
yarn release extension             # Marketplace stable
yarn release extension --extension-pre
yarn release --dry-run             # Print tag-push commands without publishing
```

Versions come from fetched `origin/main`, not your working tree. One pinned
commit ships in stages:

1. Language server + Bascik.
2. Scaffold + Cloudflare adapter.
3. VS Code extension.

The script waits for successful Actions runs and npm availability between stages.
Failures stop later stages. `--dry-run` fetches `main` and prints commands without
pushing. CI independently rejects off-main tags with `.github/scripts/release-on-main.mjs`.

Existing tags are never replaced. Select only unreleased packages; their
dependencies must already be published or selected in an earlier stage.

npm prereleases publish under their prerelease channel (`rc`, `beta`, etc.);
stable versions publish under `latest`. The script does not promote RCs to
`latest`. Extension versions must be plain `x.y.z`; `--extension-pre` uses
`ext-pre-v<version>`. Use distinct versions for stable and pre-release uploads.

## One-time authentication

### npm

On npmjs.com, open **Settings > Trusted Publisher** for each of
`@bascik/bascik`, `@bascik/language-server`, `create-bascik`, and
`@bascik/adapter-cloudflare`. Select **GitHub Actions**:

| Field                | Value               |
| -------------------- | ------------------- |
| Organization or user | `bascikdev`         |
| Repository           | `bascik`            |
| Workflow filename    | `release.yml`       |
| Environment name     | Leave blank         |
| Allowed actions      | Allow `npm publish` |

No npm token is needed. After a successful OIDC publish, delete the unused
`NPM_TOKEN` GitHub secret and revoke old npm publish tokens.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### VS Code Marketplace

Use the `bascik` publisher with an Entra managed identity:

1. Create a user-assigned managed identity with subscription **Reader** access.
2. Look up its Azure DevOps profile ID through a managed-identity pipeline and add it as a Marketplace publisher **Contributor** (see the guide below).
3. Add a GitHub federated credential for environment `marketplace`, keeping the exact generated subject.
4. Create the GitHub environment `marketplace`, allow `ext-*` tags, and add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` secrets.

See the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing).

## Failed releases

Inspect the failed run before retrying. Rerunning a job uses the workflow from
its original tagged commit, not current `main`. A failed tag can be deleted and
recreated on updated `main` **only if its version was never published**.
Published versions are immutable: bump the version instead.

For npm authentication failures, check the trusted-publisher fields and the
`npm publish` permission. Don't restore an expired token.
