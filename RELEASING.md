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
   (`nvm use 24.21.0`): `npm create bascik my-site -y -- --no-dev` (with `@rc` while
   the release candidate is current), then `npm run lint`,
   `npm run build` with `BASCIK_SITE_URL` set, and `npm run e2e`. Check
   `npm view @bascik/bascik dist-tags` shows `latest` at the new version, and that the
   Marketplace stable channel lists the extension version (the pre-release toggle in VS
   Code must not be needed).
4. **Site.** The merge already deployed `/releases`; confirm it shows the new section and
   that the home page badge reads the new version.
5. **Stale artifacts.** `npm deprecate <pkg>@<version> "<reason>"` for any accidental
   publish. The `@bascik/adapter-netlify@0.0.0-stage` test publish must be deprecated
   once 1.0.0 is out (a maintainer with publish rights runs it; deprecating a version
   that is not `latest` leaves installs of newer versions alone):

   ```sh
   npm deprecate @bascik/adapter-netlify@0.0.0-stage "Test publish. Use @bascik/adapter-netlify@1."
   npm view @bascik/adapter-netlify dist-tags deprecated --json
   ```

## Repository settings (by hand, once)

Two GitHub rulesets live outside the repository files, so changes to them are commands a
maintainer runs. Both need an authenticated `gh` with admin rights, and `jq`.

**Protect the Netlify adapter tag.** The "Tag Rules" ruleset (id 24332486) lists every
release tag pattern except `adapter-netlify-v*`, so that tag can still be moved or
deleted. Add it:

```sh
gh api repos/bascikdev/bascik/rulesets/24332486 \
  | jq '.conditions.ref_name.include += ["refs/tags/adapter-netlify-v*"]
        | {name, target, enforcement, conditions, rules, bypass_actors}' \
  | gh api -X PUT repos/bascikdev/bascik/rulesets/24332486 --input -
```

**Require CI on `main`.** The "Protect Main" ruleset (id 20648919) has a required status
checks rule with an empty list, so a red CI run does not block a merge. Name the two gate
jobs. They report one result for all the suites that ran, and a skipped suite does not
fail them. Confirm the names first with
`gh api repos/bascikdev/bascik/commits/main/check-runs --jq '.check_runs[].name'`:

```sh
gh api repos/bascikdev/bascik/rulesets/20648919 \
  | jq '(.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks)
          = [{"context": "Verify Selected Unit and Integration Suites"},
             {"context": "Verify Selected End-to-End Suites"}]
        | {name, target, enforcement, conditions, rules, bypass_actors}' \
  | gh api -X PUT repos/bascikdev/bascik/rulesets/20648919 --input -
```

Read `DEPLOYMENT.md` ("One test run per commit") before adding any other required check:
a skipped job of the same name passes.

## Failed releases

Inspect the failed run before retrying. Rerunning a job uses the workflow from
its original tagged commit, not current `main`. A failed tag can be deleted and
recreated on updated `main` **only if its version was never published**.
Published versions are immutable: bump the version instead.

For npm authentication failures, check the trusted-publisher fields and the
`npm publish` permission. Don't restore an expired token.
