# Releasing

## Release checklist

Every release, 1.0.0 included, goes through one pull request and then `yarn release`:

1. **Changelog.** Move the bullets under `## [Unreleased]` in `CHANGELOG.md` to a new
   `## [<version>] - <YYYY-MM-DD>` section and add the comparison link at the bottom
   (`[<version>]: https://github.com/bascikdev/bascik/compare/v<previous>...v<version>`;
   the first release links its tag). The `/releases` docs page renders this file, so an
   empty or missing section shows on bascik.dev. Packages that did not change get no
   section of their own; their bullets name the package.
2. **Versions and ranges.** Bump `version` in each package that changed: `pkg/`,
   `create/`, `adapters/cloudflare/`, `adapters/netlify/`, `lsp/`,
   `extensions/vscode-bascik/`. Then the ranges that must include the new versions:
   `pkg/package.json` peer `@bascik/language-server`, both adapters' peer and dev
   `@bascik/bascik`, `BASCIK_VERSION` and the dependency ranges in
   `create/src/scaffold.ts`, and `examples/starter-site/package.json`.
   `pkg/e2e/scripts/release-manifests.test.ts` fails when a range excludes a version.
   Extension versions are plain `x.y.z`: an even minor publishes to the stable
   Marketplace channel (`ext-v`), an odd minor to pre-release (`ext-pre-v`).
3. **Docs sweep.** `grep -rn '<old version>' docs/content skills README.md pkg/README.md
create/README.md adapters/*/README.md` and fix what the bump left behind (install
   commands, example ranges, the `#v<tag>` the skills install from).
4. **Validate.** `yarn check:format`, `yarn check:spelling`, `yarn typecheck:all`,
   `yarn test:all`, and the `pre-push` skill (`.github/skills/pre-push/SKILL.md`), which
   regenerates the coverage JSON files.
5. **Merge into `main`** through a pull request. CI must be green on the branch; the
   merge deploys the docs and the demo Worker, so the site already shows the new version
   and release notes before the packages exist on npm. Keep that window short.
6. **Publish** with `yarn release` (below).
7. **After publishing**, see "After publishing".

## Release

Update package versions and dependent ranges, pass CI, and merge into `main`.
Then, with Node 24, Git, and an authenticated GitHub CLI:

```sh
yarn release                       # Publish all six artifacts
yarn release pkg lsp               # Publish only selected packages
yarn release create cloudflare netlify
yarn release extension             # Marketplace stable
yarn release extension --extension-pre
yarn release --latest               # Print npm dist-tag commands; does not release
yarn release pkg create --latest    # Print commands for selected npm packages
yarn release --dry-run             # Print tag-push commands without publishing
```

Versions come from fetched `origin/main`, not your working tree. One pinned
commit ships in stages:

1. Language server + Bascik.
2. Scaffold + Cloudflare and Netlify adapters.
3. VS Code extension.

The script waits for successful Actions runs and npm availability between stages.
Failures stop later stages. `--dry-run` fetches `main` and prints commands without
pushing. CI independently rejects off-main tags with `.github/scripts/release-on-main.mjs`.

Existing tags are never replaced. Select only unreleased packages; their
dependencies must already be published or selected in an earlier stage.

npm prereleases publish under their prerelease channel (`rc`, `beta`, etc.);
stable versions publish under `latest`. `--latest` is a command-generation
mode: it prints `npm dist-tag add <package>@<version> latest` commands for the
selected npm packages using versions from `origin/main`, and does not create
release tags or run npm. With no package selection, it prints commands for all
five npm packages and skips the Marketplace extension. Run the printed commands
locally to update the tags; this lets npm handle any interactive 2FA prompt.
Pointing `latest` at an RC means a plain `npm install` can install a prerelease.
Extension versions must be plain `x.y.z`; `--extension-pre` uses
`ext-pre-v<version>`. Use distinct versions for stable and pre-release uploads.

## After publishing

1. **GitHub Release.** The release workflow pushes tags but creates no GitHub Release,
   and the repository's Releases panel is what evaluators look at. Create one for the
   `@bascik/bascik` tag from the changelog section:

   ```sh
   gh release create v1.0.0 --title "Bascik 1.0.0" --notes-file <(sed -n '/^## \[1.0.0\]/,/^## \[/p' CHANGELOG.md | sed '$d')
   ```

2. **Prerelease dist-tags.** When a stable version follows a prerelease channel, point
   that channel at the stable version so old install commands keep working. For 1.0.0,
   `npm create bascik@rc` and `@bascik/bascik@rc` were the documented commands for weeks:

   ```sh
   for p in @bascik/bascik create-bascik @bascik/adapter-cloudflare @bascik/adapter-netlify @bascik/language-server; do
     npm dist-tag add "$p@1.0.0" rc
   done
   ```

3. **Verify as a user.** In an empty directory on the floor Node version
   (`nvm use 24.11.0`): `npm create bascik my-site -y -- --no-dev`, then `npm run lint`,
   `npm run build` with `BASCIK_SITE_URL` set, and `npm run e2e`. Check
   `npm view @bascik/bascik dist-tags` shows `latest` at the new version, and that the
   Marketplace stable channel lists the extension version (the pre-release toggle in VS
   Code must not be needed).
4. **Site.** The merge already deployed `/releases`; confirm it shows the new section and
   that the home page badge reads the new version.
5. **Stale artifacts.** `npm deprecate <pkg>@<version> "<reason>"` for any accidental
   publish, for example the `@bascik/adapter-netlify@0.0.0-stage` test publish, which
   should be deprecated once 1.0.0 is out.

## One-time authentication

### npm

On npmjs.com, open **Settings > Trusted Publisher** for each of
`@bascik/bascik`, `@bascik/language-server`, `create-bascik`,
`@bascik/adapter-cloudflare`, and `@bascik/adapter-netlify`. Select **GitHub Actions**:

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

A package that has never been published (such as `@bascik/adapter-netlify`
before `1.0.0-rc.1`) has no settings page yet, so its first version is
published locally after its dependencies are on npm, then its trusted
publisher is configured. Later versions use `yarn release`:

```sh
git switch main && git pull && yarn install --immutable
yarn pkg:build && yarn adapter:nf:build
(cd adapters/netlify && npm publish --access public --tag rc)
git tag adapter-netlify-v1.0.0-rc.1 origin/main
git push origin adapter-netlify-v1.0.0-rc.1
```

Pushing that tag still runs the Release job, which builds and tests the package,
then skips publishing: `publish-npm.sh` exits successfully when the version is
already on npm.

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
