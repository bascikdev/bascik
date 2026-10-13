# Build Scripts Reference

`<script data-bascik-build>` runs as a Node.js ESM module while a page compiles, in dev and in `--build`. Its default export returns an HTML string that replaces the tag.

## Execution model

- CWD is the project root. Quoted data paths (`readFile('./content/x.md')`) resolve from there.
- Each uncached script runs in a fresh child process with its own module registry, so detached async work in one script can never leak into another. Concurrency is bounded by a memory-aware semaphore.
- Child processes share only Node's on-disk compile cache (`node_modules/.cache/bascik/compile-cache/`). A user-set `NODE_COMPILE_CACHE` is kept; `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
- Scripts run before component resolution, so returned markup can contain component tags.
- Output is transpiled again: components expand and client `<script>` tags run in the browser, but any printed `data-bascik-build`, `-server`, `-stream`, or `-routes` script is removed with a warning. This is not a sanitizer; HTML from a CMS or API still needs an allowlist sanitizer before printing.
- Build scripts work in `<head>` too, which is how pages get canonical URLs, Open Graph tags, and JSON-LD.

## Environment variables

| Variable | Value |
|---|---|
| `BASCIK_PAGE_PATH` | Normalized route of the current page: `/`, `/getting-started`, `/switch/from-vue` |
| `BASCIK_SOURCE_FILE` | Absolute path of the file being transpiled (page or component template) |
| `BASCIK_PAGE_FILE` | Absolute path of the current page file |
| `BASCIK_PAGES_DIR` | Absolute path of `directory.pages` |
| `BASCIK_OUT_DIR` | Absolute path of `directory.out` (exec scripts) |
| `BASCIK_BUILD` | `"1"` during `bascik --build`, `"0"` in dev |
| `BASCIK_SITE_URL` | Site URL from `--site-url`, the environment, or `.env`. Absent when unset, never empty |
| `BASCIK_BASE` | Normalized deployment base, always present, default `/` |
| `BASCIK_ROUTE` | JSON `{ params, data }` inside dynamic route templates (any size; large payloads arrive through a temp file transparently) |

A script that references `BASCIK_SOURCE_FILE`, `BASCIK_PAGE_FILE`, or `BASCIK_PAGE_PATH` gets a separate cache entry per page automatically.

## Output cache

Location: `node_modules/.cache/bascik/script-cache/<sha256>.json`.

The key is a SHA-256 of: the script source, dev or build mode, the source file path, the site URL, the base, route params, the content of local files referenced as quoted path literals in the script, the content of the source and page files when the script or a local helper names `BASCIK_SOURCE_FILE` or `BASCIK_PAGE_FILE`, and the resolved identity of every installed package imported (manifest, entry, and a bounded transitive hash). Upgrading a dependency invalidates affected entries.

Invisible to the key: network responses, `readdir` listings, computed file paths, and `process.env` reads. A script with a dynamic non-literal import (`import(name)`, `` import(`../${x}`) ``) is never cached.

```ts
// bascik.config.ts (illustrative)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  scripts: {
    cache: {
      exclude: ['src/pages/live-feed/**', 'src/components/api-cards/**'],
      environment: ['MY_FEATURE_FLAG', 'API_BASE_URL'],
    },
  },
});
```

- `exclude` / `include` globs match project-root-relative script source paths.
- `environment` lists exact variable names whose values join the key (hashed, never stored). Missing and empty produce different keys. Bascik warns about statically visible `process.env.NAME` reads that are not declared.
- Bust everything: `rm -rf node_modules/.cache/bascik/script-cache`.
- With `pipeline.workers: true`, workers share the cache; a cold first build may run a script twice (harmless).

## Errors

`scripts.onBuildScriptError` and `scripts.onRoutesScriptError` accept `'error'` (default), `'warn'`, or `'ignore'`. Under `'warn'` the tag is replaced with an empty string and the error is logged.

Errors print once with the file and the script tag position, and stack frames point at the line in the file where the script was written (including components):

```text
[bascik] build script error in "src/pages/about.html" at (line 9, column 5):
TypeError: Cannot read properties of undefined (reading 'title')
    at default (src/components/team-card/team-card.html:9:11)
```

Syntax errors show the failing line with a caret. Node internals and Bascik runner frames are removed; set `BASCIK_KEEP_INTERNAL_FRAMES=1` to keep Bascik frames. Cmd+Click the location in VS Code to jump to it.

## Markdown

```html
<script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  import { marked } from 'marked';

  export default async function () {
    const md = await readFile('./content/article.md', 'utf8');
    return `<markdown-content>${marked(md)}</markdown-content>`;
  }
</script>
```

Give `markdown-content` a default slot and style the generated elements with the wrapper class plus `:is()`:

```css
.markdown-content :is(h2) { margin-block: 2.5rem 0.75rem; }
.markdown-content :is(blockquote) { border-left: 4px solid currentColor; }
```

Slotted elements do not receive scoped element classes, so `.markdown-content h2 {}` never matches. Alternatively style Markdown from a global stylesheet. Syntax highlighting and front matter (`gray-matter`) are your own build step.

## Page-aware scripts

Shared helpers can derive per-page output from the environment. Canonical URL:

```ts
// src/lib/canonical.ts (illustrative)
export async function canonical(): Promise<string> {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  const pagePath = process.env.BASCIK_PAGE_PATH ?? '';
  if (!siteUrl || !pagePath) return '';
  return `<link rel="canonical" href="${siteUrl}${pagePath}" />`;
}
```

```html
<head>
  <script data-bascik-build>
    import { canonical } from '@/lib/canonical.ts';
    export default async () => await canonical();
  </script>
</head>
```

A helper can also read the page's own source through `BASCIK_SOURCE_FILE` (an absolute path) to extract `<title>` or `<meta name="description">` for Open Graph or JSON-LD. It sees the source as written, before other build scripts run. Include `BASCIK_BASE` when building URLs for subdirectory deployments.

## Content collections

There is no built-in collection API. Write a helper such as `src/lib/posts.ts` that reads `content/` with `fs`, parses front matter (`gray-matter`), validates (`zod`), and sorts by the parsed date rather than the file name. Skip drafts when `process.env.BASCIK_BUILD === '1'`. Exclude scripts that read `content/` with `readdir` from the cache, and add `content/` to `pipeline.watchPaths`. Keep helpers light: every build script is its own Node process, so heavy imports cost time on every page.

## `data-bascik-dev`

A browser script tagged `data-bascik-dev` runs in dev and is removed entirely from `bascik --build` output. Use it for debug logging and overlays.

```html
<script data-bascik-dev>
  console.log('dev only');
</script>
```
