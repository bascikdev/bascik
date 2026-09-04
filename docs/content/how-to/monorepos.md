# Monorepos

A Bascik project is one directory of pages, one or more directories of components, and one import root for script helpers, and each of the three is an independent config path. Nothing in Bascik assumes they share a parent. A company maintaining several sites can therefore keep one repository, one shared components directory, and one shared scripts directory, and point every site at them while each site keeps its own private components beside its pages. This falls out of how the configuration is built; there is no monorepo mode to enable.

This page covers a single repository whose sites read the same directories directly, with no copying. If your projects live in separate repositories and you want to copy components between them (via `bascik add`, npm, or git submodules), see [Sharing Components](/how-to/sharing-components) instead.

## Layout

```text
repo/
  shared/
    components/     site-nav.html, site-nav.css, site-footer.html
    scripts/        canonical.ts, md-renderer.ts
  sites/
    marketing/      bascik.config.ts, src/pages/, src/components/pricing-table.html
    docs/           bascik.config.ts, src/pages/, src/components/api-signature.html
    support/        bascik.config.ts, src/pages/
```

Each site is an ordinary Bascik project with its own `bascik.config.ts`, its own `src/pages/`, and optionally its own `src/components/` for components no other site needs. The shared directories sit beside the sites, outside any one project.

## Per-site configuration

List the shared components directory alongside the site's own in `directory.components`, and point `scripts.importRoot` at the shared scripts folder. `directory.pages` stays at its default because pages are always site-specific:

```ts
// sites/marketing/bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    components: ['../../shared/components', 'src/components'],
  },
  scripts: {
    importRoot: '../../shared/scripts',
  },
});
```

All of these values are relative to the site's own project root and are accepted even though some resolve outside it. Components roots and the import root are read-only, so nothing stops them living anywhere on disk. (Only `directory.out` is restricted to the project, because Bascik deletes and writes there.)

A site with no private components lists just the shared root: `components: '../../shared/components'`. A single string and a one-element array mean the same thing.

Each site is built and served independently:

```sh
cd sites/marketing && bascik --build
cd sites/docs && bascik
```

The dev watcher follows every root in `directory.components` wherever it points, so editing a shared component live-reloads whichever site is currently running, and editing a site-local component only affects that site.

## Scripts: shared and site-local at once

With `scripts.importRoot` pointing at the shared scripts directory, `@/` reaches shared helpers from any page or component. Relative paths still resolve against the file that contains the script, so site-local helpers sit next to the page and are imported with `./`:

```html
<!-- sites/marketing/src/pages/pricing.html -->
<script data-bascik-build>
  import { renderMd } from '@/md-renderer.ts';        // shared/scripts/md-renderer.ts
  import { pricingTable } from './helpers/pricing.ts'; // sites/marketing/src/pages/helpers/pricing.ts

  console.log(await renderMd('./content/pricing.md'));
  console.log(pricingTable());
</script>
```

One alias root for shared code, relative paths for local code. The aliases are rewritten only inside script blocks: a helper file that imports another helper uses `./` or `../`, because Node loads helper files from disk as-is. See [Build Scripts](/build-scripts#import-root-aliases) for the full alias rules.

> **Watching shared helpers.** Bascik tracks which pages depend on each alias-imported helper and watches `scripts.importRoot` automatically, even when it points outside the project root, so an edit rebuilds only the pages that use it.

## Components: shared and site-local at once

With two roots listed, `<site-nav>` from `shared/components` and `<pricing-table>` from `sites/marketing/src/components` are both available to the marketing site's pages, and neither the docs nor the support site can see `<pricing-table>` because it is not in any of their roots.

Component discovery is recursive within each root and a component's tag name comes from its filename, not its folder or its root. Two consequences follow:

- **Names must be unique across all roots together.** A `hero.html` in the shared directory and another in a site's own `src/components` is a build error listing both paths, exactly like two subfolders defining the same tag. Name them `site-hero.html` and `marketing-hero.html`.
- **Roots cannot be nested.** `['src/components', 'src/components/shared']` is rejected at startup, because the parent already covers the child. If you want a subset of shared components in one site, put them in a separate sibling directory and list that.

Order in the array does not decide which component wins, since duplicates are errors. It only decides where `bascik add` copies into (the first root) and how paths appear in error messages.

> **Shared root as a symlink?** If a site's `src/components/shared` is a symlink into `shared/components`, Bascik follows it: components behind the link are discovered and edits behind it trigger rebuilds. Listing both the link and its target as separate roots is rejected as a duplicate. Prefer the two-root config above; symlinks are awkward in git on Windows.

## Workspace tooling

Yarn or npm workspaces at the repository root are optional and orthogonal to Bascik. Bascik resolves bare specifiers such as `marked` or `@bascik/bascik` by climbing `node_modules` from the project directory, so a hoisted root `node_modules` works with no extra configuration.

> **Separate repositories?** If each site is its own repository, the shared-directory approach does not apply. See [Sharing Components](/how-to/sharing-components) for copying components between projects with `bascik add`.
