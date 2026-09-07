# Watch Paths

Watch paths allow you to register extra files and directories outside `src/pages/` and `src/components/` that trigger automatic page re-transpilation and live browser reload during development.

## pipeline.watchPaths

Configure additional watch paths in `bascik.config.ts` using the `pipeline.watchPaths` array:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    watchPaths: [
      'content/**/*.md',
      'data/**/*.json',
      'scripts/helpers/**/*.ts',
    ],
  },
});
```

Bascik watches these paths in the dev server alongside your pages and components directories. Whenever a file matching any pattern changes, Bascik detects the edit, re-evaluates dependent pages and build scripts, and triggers live reload via Server-Sent Events (SSE).

## Automatic Watching vs Custom Watch Paths

Bascik automatically monitors standard project locations without requiring configuration:

| Location | Monitored by Default? | Details |
| :--- | :--- | :--- |
| `directory.pages` (`src/pages`) | Yes | Detects page additions, removals, and edits. |
| `directory.components` (`src/components` or array) | Yes | Re-transpiles all pages consuming updated components. |
| `scripts.importRoot` (`src` or custom) | Runtime only | Invalidates request-time modules. Build-time helpers need an explicit compilation watch. |
| `pipeline.watchPaths` | User-defined | Extra content directories, JSON fixtures, external assets. |
| `pipeline.exec[].watch` | Source inputs | Selects matching lifecycle scripts and rebuilds associated pages in one phase-ordered cycle. |

Add shared build helpers and inlined stylesheets outside the source directories to `watchPaths`, unless an exec source watch already covers them. `scripts.importRoot` and `assets.inlineStyles` do not implicitly opt them into compilation watching. A dependency graph entry selects affected pages after an observed source change, but does not create a watcher.

## Glob Patterns & Path Syntax

Watch paths accept standard glob patterns relative to your project root:

```ts
// Example watch path patterns
pipeline: {
  watchPaths: [
    'content/',              // Watch all files in the content/ directory
    'data/*.json',           // Match top-level JSON files in data/
    'docs/content/**/*.md',  // Match Markdown files at any nesting depth
    'shared/**/*.css',       // Match shared stylesheets
  ],
}
```

### Overlapping Paths

Listing a source in both `pipeline.watchPaths` and `exec.watch` creates one phase-ordered rebuild, not independent actions. Matching pre scripts finish before compilation; parallel starts alongside compilation; post starts after compilation and disk writes complete. Only matching scripts rerun. Exec-only source edits can rebuild associated pages without duplicate `watchPaths` entries. See [Exec Scripts](/exec-scripts#watching-source-inputs).

Never watch generated outputs, including individual files such as `dist/catalog.json`. Exec scripts must write artifacts only to the output directory, not sources or watched paths. Completion and output writes do not trigger compilation. Bascik does not hide legitimate edits using self-write or loop-suppression heuristics.

## How It Works in Development

When you run `bascik` or `npm run dev`:

1. **Watcher Initialization:** With watched exec entries, one source observer covers pages, components, `watchPaths`, and exec input patterns. Runtime-module invalidation remains separate.
2. **Change Detection:** On an observed add, change, or deletion, Bascik identifies dependent pages.
3. **Phase Ordering:** Matching pre scripts finish before dependency-content memoization is invalidated. Result caching stays enabled and rechecks dependency bytes. Parallel starts alongside compilation.
4. **Selective Re-Transpile:** Known dependents rebuild. An extra watch path with no known dependents falls back to all pages.
5. **Live Reload:** After successful compilation and post scripts, the cycle publishes its buffered page reloads. Failures publish errors instead. Exec completion alone emits none; later source edits retry failed paths.

> **Testing and Verifying:** To test watch paths locally, start `npx bascik`, edit a watched Markdown or JSON file in another terminal, and observe the re-transpile log in the server console.
