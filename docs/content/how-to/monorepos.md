# Monorepos

A Bascik project is one directory of pages, one directory of components, and one import root for script helpers, and each of the three is an independent config path. Nothing in Bascik assumes they share a parent. A company maintaining several sites can therefore keep one repository, one shared components directory, and one shared scripts directory, and point every site at them. This falls out of how the configuration is built; there is no monorepo mode to enable.

This page covers a single repository whose sites read the same directories directly, with no copying. If your projects live in separate repositories and you want to copy components between them (via `bascik add`, npm, or git submodules), see [Sharing Components](/how-to/sharing-components) instead.

## Layout

```text
repo/
  shared/
    components/     site-nav.html, site-nav.css, site-footer.html
    scripts/        canonical.ts, md-renderer.ts
  sites/
    marketing/      bascik.config.ts, src/pages/
    docs/           bascik.config.ts, src/pages/
    support/        bascik.config.ts, src/pages/
```

Each site is an ordinary Bascik project with its own `bascik.config.ts` and its own `src/pages/`. The shared directories sit beside the sites, outside any one project.

## Per-site configuration

Point `directory.components` and `scripts.importRoot` at the shared folders. `directory.pages` stays at its default because pages are always site-specific:

```ts
// sites/marketing/bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    components: '../../shared/components',
  },
  scripts: {
    importRoot: '../../shared/scripts',
  },
});
```

Both values are relative to the site's own project root and are accepted even though they resolve outside it. `directory.components` has always worked this way; `scripts.importRoot` follows the same rule because it is read-only. (Only `directory.out` is restricted to the project, because Bascik deletes and writes there.)

Each site is built and served independently:

```sh
cd sites/marketing && bascik --build
cd sites/docs && bascik
```

The dev watcher follows `directory.components` wherever it points, so editing a shared component live-reloads whichever site is currently running.

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

> **Watching shared helpers.** Bascik tracks which pages depend on each alias-imported helper, so an edit rebuilds only the pages that use it. The watcher still has to see the edit: add the shared scripts directory to `pipeline.watchPaths` in each site's config (`watchPaths: ['../../shared/scripts/']`).

## Components: the current constraint

`directory.components` accepts one directory. A site whose components live in the shared directory cannot also have a private components directory today.

The working convention is per-site subfolders inside the shared directory:

```text
shared/components/
  site-nav/site-nav.html
  site-footer.html
  marketing/pricing-table.html
  docs/api-signature.html
```

This works because component discovery is recursive and a component's tag name comes from its filename, not its folder. `<pricing-table>` is available to every site, but only the marketing site uses it. The filename-uniqueness rule applies across the whole tree, so two sites cannot each have their own `hero.html`; name them `marketing-hero.html` and `docs-hero.html`.

## Workspace tooling

Yarn or npm workspaces at the repository root are optional and orthogonal to Bascik. Bascik resolves bare specifiers such as `marked` or `@bascik/bascik` by climbing `node_modules` from the project directory, so a hoisted root `node_modules` works with no extra configuration.

> **Separate repositories?** If each site is its own repository, the shared-directory approach does not apply. See [Sharing Components](/how-to/sharing-components) for copying components between projects with `bascik add`.
