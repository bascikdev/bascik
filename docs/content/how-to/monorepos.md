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

  export default async function () {
    const md = await renderMd('./content/pricing.md');
    const table = pricingTable();
    return `${md}\n${table}`;
  }
</script>
```

One alias root for shared code, relative paths for local code. The aliases are rewritten only inside script blocks: a helper file that imports another helper uses `./` or `../`, because Node loads helper files from disk as-is. See [Script Imports](/script-imports#import-root-aliases) for the full alias rules.

> **Watching shared helpers.** Bascik tracks which pages depend on each alias-imported helper. Add the shared helper directory to `pipeline.watchPaths` to rebuild dependent pages on edits. `scripts.importRoot` controls resolution and request-time module invalidation, not compilation triggers, even when it points outside the project root.

## Components: shared and site-local at once

With two roots listed, `<site-nav>` from `shared/components` and `<pricing-table>` from `sites/marketing/src/components` are both available to the marketing site's pages, and neither the docs nor the support site can see `<pricing-table>` because it is not in any of their roots.

Component discovery is recursive within each root and a component's tag name comes from its filename, not its folder or its root. Two consequences follow:

- **Names must be unique across all roots together.** A `hero.html` in the shared directory and another in a site's own `src/components` is a build error listing both paths, exactly like two subfolders defining the same tag. Name them `site-hero.html` and `marketing-hero.html`.
- **Roots cannot be nested.** `['src/components', 'src/components/shared']` is rejected at startup, because the parent already covers the child. If you want a subset of shared components in one site, put them in a separate sibling directory and list that.

Order in the array does not decide which component wins, since duplicates are errors. It only decides where `bascik add` copies into (the first root) and how paths appear in error messages. List the site's own folder first unless new components should land in the shared folder.

## Imports inside shared components

A build script in a shared component runs as part of whichever site uses it, so `@/` resolves against **that site's** `scripts.importRoot`. When every site points `scripts.importRoot` at the same shared folder, `@/` works everywhere. When the sites differ, import shared helpers with a relative path, which resolves against the component file and works in every site:

```html
<!-- shared/components/site-nav/site-nav.html -->
<script data-bascik-build>
  import { links } from '../../scripts/links.ts';
  export default () => links();
</script>
```

A component build script runs when the component is registered, even if no page in the site uses that component. An import that does not resolve for one site therefore fails that site's build, not only the sites that use the component.

## Shared design tokens

Keep design tokens in one stylesheet, such as `shared/styles/tokens.css`, and inline it into every page of each site. Components then read the tokens with `var()`; see [Theming](/how-to/theming).

```ts
// sites/marketing/bascik.config.ts
export default defineConfig({
  directory: { components: ['src/components', '../../shared/components'] },
  assets: { inlineStyles: ['../../shared/styles/tokens.css'] },
  pipeline: { watchPaths: ['../../shared/scripts/', '../../shared/styles/'] },
});
```

## Checking every site

Run the checks from each site, because each one compiles the shared components with its own configuration:

```sh
cd sites/marketing
BASCIK_SITE_URL=https://example.com npx bascik --check
npx @bascik/language-server --check
npx @bascik/language-server --check ../../shared/components
```

The [linter](/tools/linter) only scans below the directory you give it, so a shared component folder outside the site needs its own run; from the site, it is checked with the site's configuration. Keep every site on the same `@bascik/bascik` version, by hoisting it to the repository root or pinning it in each site, so a shared component compiles the same way everywhere.

> **Shared root as a symlink?** If a site's `src/components/shared` is a symlink into `shared/components`, Bascik follows it: components behind the link are discovered and edits behind it trigger rebuilds. Listing both the link and its target as separate roots is rejected as a duplicate. Prefer the two-root config above; symlinks are awkward in git on Windows.

## Workspace tooling

Yarn, npm, or pnpm workspaces at the repository root are optional and orthogonal to Bascik. Bascik resolves bare specifiers such as `marked` or `@bascik/bascik` by climbing `node_modules` from the project directory, so a hoisted root `node_modules` works with no extra configuration. Give each site its own `package.json` with `"type": "module"` and `dev`, `build`, and `check` scripts:

| Tool | Build every site | Run one site |
|---|---|---|
| npm | `npm run build --workspaces` | `npm run dev -w marketing` |
| Yarn | `yarn workspaces foreach -A run build` | `yarn workspace marketing dev` |
| pnpm | `pnpm -r run build` | `pnpm --filter marketing dev` |

Run one dev server per site, each on its own port (`npx bascik --port 3001`). Editing a shared component live-reloads every running site that uses it.

### Task runners

Turborepo and Nx cache a task by the files inside its package. A site that reads `../../shared` must list those files as inputs, or a change to a shared component serves a stale cached build. `BASCIK_SITE_URL` changes the output (canonical URLs and the sitemap), so it belongs in the cache key too:

```json
{
  "tasks": {
    "build": {
      "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/shared/**", ".env*"],
      "outputs": ["dist/**"],
      "env": ["BASCIK_SITE_URL"]
    },
    "dev": { "cache": false, "persistent": true }
  }
}
```

In Nx, add `{workspaceRoot}/shared/**/*` to the build target's `inputs`. When CI builds only what changed, count a change under `shared/` as a change to every site.

### Deploying several sites

- **One domain, several paths:** give each site a [`base`](/configuration) such as `'/docs/'`, build each with the same `BASCIK_SITE_URL` origin, and upload each `dist/` to its path. Shared components keep writing root-relative links; Bascik adds each site's base.
- **Separate domains:** one hosting project per site, with the site folder as its root directory, `npx bascik --build` as the build command, and `dist` as the output.
- **Sites with API routes or server scripts** deploy with `bascik --server` or a [serverless adapter](/deployment/cloudflare); the others stay static.

## A site inside an application repository

A marketing or docs site often lives next to a backend or a mobile app. Give it its own folder (`site/` or `apps/web/`) with its own `package.json` and `bascik.config.ts`, never a config at the root of another application. The backend's tooling can then ignore it, and Bascik never scans the backend's files. If the backend serves the site, build it and copy `site/dist/` into the backend's static folder in CI; `directory.out` must stay inside the site.

> **Separate repositories?** If each site is its own repository, the shared-directory approach does not apply. See [Sharing Components](/how-to/sharing-components) for copying components between projects with `bascik add`.
