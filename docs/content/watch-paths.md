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
| `scripts.importRoot` (`src` or custom) | Yes | Watches shared `@/` helper scripts and invalidates dependent page caches. |
| `pipeline.watchPaths` | User-defined | Extra content directories, JSON fixtures, external assets. |
| `pipeline.exec[].watch` | User-defined | Specific globs that trigger individual lifecycle scripts. |

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

### Overlapping Paths & Deduplication

Listing a directory in both `pipeline.watchPaths` and an `exec[].watch` configuration is fully supported. When a matching file changes, the exec producer runs first. Only after the producer completes are the affected pages re-transpiled, so a page never compiles against a previous generation of a produced output. Every changed path in a batch is retained (not just the last filename), and the browser receives exactly one coordinated SSE reload for the finished generation.

## How It Works in Development

When you run `bascik` or `npm run dev`:

1. **Watcher Initialization:** Bascik initializes Chokidar file watchers across pages, components, the import root, and all configured `watchPaths`.
2. **Change Detection:** When an external file changes, Bascik determines whether any build script or template depends on it.
3. **Producer First:** If the path is covered by an exec producer's `watch` globs, the producer executes and completes before any page re-transpiles.
4. **Cache Invalidation:** Build scripts importing or reading the modified path (or a producer's regenerated output) have their script cache invalidated.
5. **Selective Re-Transpile:** Only affected pages are re-rendered, against the freshly produced output.
6. **Instant Live Reload:** An SSE generation signal is pushed to the browser client once, refreshing the tab seamlessly without full server restarts.

> **Testing and Verifying:** To test watch paths locally, start `npx bascik`, edit a watched Markdown or JSON file in another terminal, and observe the re-transpile log in the server console.
