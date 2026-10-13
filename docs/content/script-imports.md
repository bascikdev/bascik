# Script Imports

Every Bascik script tag is a standard Node.js ESM module: `data-bascik-build`, `data-bascik-server`, `data-bascik-stream`, and `data-bascik-routes`, plus the `src="…"` attribute on each of them. This page covers how those scripts import shared helpers and npm packages. The rules are the same for all four.

## Shared Modules

Write utility functions in your project and import them from any script. No special Bascik API is required:

```js
// src/lib/render-cards.ts
import { readFile } from 'node:fs/promises';

export async function renderCards(jsonPath: string) {
  const items = JSON.parse(await readFile(jsonPath, 'utf8'));
  return items.map(item => `
    <div class="card">
      <h3>${item.title}</h3>
      <p>${item.description}</p>
    </div>
  `).join('\n');
}
```

Static imports, bare imports, `export ... from`, and dynamic `import()` all work. Bascik rewrites genuine `./` and `../` specifiers relative to the containing page, component, or external script file.

## Import Root Aliases (`@/`)

Relative paths change shape with the depth of the file that contains them (`../lib/x.ts` at one level, `../../lib/x.ts` at the next), so the same helper import cannot be pasted into every page. For shared helpers, import from the **import root** instead. The default recommendation is `@/`:

```html
<script data-bascik-build>
  import { renderCards } from '@/lib/render-cards.ts';
  export default async () => await renderCards('./content/cards.json');
</script>
```

`@/` resolves against `scripts.importRoot` (default `src`), so `@/lib/render-cards.ts` is `src/lib/render-cards.ts` from any page or component, at any nesting depth. The alias works in `<script data-bascik-build>`, `<script data-bascik-server>`, `<script data-bascik-stream>`, `<script data-bascik-routes>`, and in the `src="…"` attribute on those tags.

- **Helper resolution:** Helper `.ts` and `.js` files loaded from disk are executed by Node as-is, so a helper that imports another helper must use standard `./` or `../`. The alias is rewritten only inside script blocks.
- **Data paths:** Quoted data paths passed to functions (`readFile('./content/x.md')`) are not module specifiers and keep their standard `process.cwd()` semantics.
- **Bare leading `/` is an error:** `import x from '/lib/x.ts'` (or `src="/lib/x.ts"`) inside a Bascik script is rejected because a leading slash is ambiguous between the filesystem root and site root. The error names both valid rewrites: `@/lib/x.ts` for the import root or `./lib/x.ts` for a path relative to the file. Plain client `<script>` tags are unaffected.
- **Type-only imports:** Node strips types without checking them, so a type-only import must be written `import type`. tsconfig `paths` do not apply inside scripts.

Set `scripts.importRoot` in `bascik.config.ts` to point the alias at a different directory. See [Configuration](/configuration#scripts) for the option and [Monorepos](/how-to/monorepos) for pointing it at a shared directory.

### Editing Helpers

How an edit to an alias-imported helper takes effect depends on the script kind:

- **Build scripts:** A helper rebuilds the pages that depend on it only when its path is covered by `directory.*` or `pipeline.watchPaths`. The import-root watcher invalidates request-time modules but does not trigger compilation, so add build helper directories such as `src/lib/` to `pipeline.watchPaths`. See [Watch Paths](/watch-paths).
- **Server scripts and API routes:** A helper imported at request time by a `src=` script or API route is reloaded on the next request, together with every module that imports it. See [Server Scripts](/server-scripts#shared-helper-modules) for the inline-script exception.

## npm Packages

A Bascik project is a standard Node.js project, so any npm package can be installed and imported in a script. Install it once and import it anywhere:

```sh
npm install gray-matter
```

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import matter from 'gray-matter';

  export default async function () {
    const raw = await readFile('./content/post.md', 'utf8');
    const { data, content } = matter(raw);
    return `
      <article>
        <h1>${data.title}</h1>
        <p class="date">${data.date}</p>
      </article>
    `;
  }
</script>
```

Packages run on the server, at build time or request time. To ship a package to the browser, see [Bundling npm Packages](/how-to/bundling-npm-packages).

> **Next:** [Build Scripts](/build-scripts), [Server Scripts](/server-scripts), [Stream Scripts](/stream-scripts), and [Dynamic Routes](/dynamic-routes) each describe what their script returns and when it runs.
