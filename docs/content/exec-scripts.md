# Exec Scripts

Lifecycle scripts allow you to execute arbitrary Node.js tasks at defined phases of the compilation pipeline. Use them to generate sitemaps, search indexes, RSS feeds, optimize assets, or bundle client-side npm libraries.

## pipeline.exec

Configure lifecycle scripts in `bascik.config.ts` under the `pipeline.exec` array. Each entry specifies a script path and optional execution settings:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'scripts/generate-search-index.ts',
        phase: 'post',
        watch: ['content/'],
      },
    ],
  },
});
```

You can also pass strings as shorthand for `{ script: '...' }` with default settings:

```ts
// Shorthand syntax
pipeline: {
  exec: [
    'scripts/generate-sitemap.ts',
    'scripts/generate-search-index.ts',
  ],
}
```

## Lifecycle Execution Phases

The `phase` property controls when your script runs relative to HTML page transpilation:

| Phase | Description | Common Use Cases |
| :--- | :--- | :--- |
| `'pre'` (default) | Awaited before any page or component is transpiled. | Fetching external CMS data, preparing JSON catalogs, asset downloading |
| `'parallel'` | Started before transpilation and runs concurrently with page compilation. In dev the server binds and pages compile while it runs; its output is published through the exec publication coordinator when it completes. In build it is joined before `dist/` is finalized. | Independent background artifact generation |
| `'post'` | Executed after all pages and assets are compiled and written to `dist/`. | Search indexing, XML sitemap generation, post-processing bundles |

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    exec: [
      { script: 'scripts/sync-cms.ts', phase: 'pre' },
      { script: 'scripts/generate-index.ts', phase: 'post' },
    ],
  },
});
```

## Configuration Options

Each exec entry in `pipeline.exec` accepts:

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `script` (required) | `string` | none | Path to the script file, relative to the project root |
| `phase` | `'pre' \| 'post' \| 'parallel'` | `'pre'` | When the script executes relative to page transpilation |
| `watch` | `string \| string[]` | `[]` | File or directory globs that trigger script re-execution during dev mode |
| `cwd` | `string` | `process.cwd()` | Working directory for the script execution |
| `env` | `Record<string, string>` | `{}` | Custom environment variables merged with `process.env` |
| `args` | `string[]` | `[]` | Command-line arguments passed as `process.argv` |
| `timeout` | `number` | `60000` | Maximum execution time in milliseconds before terminating |

```ts
// Full exec entry configuration
{
  script: 'scripts/bundle-vendor.ts',
  phase: 'pre',
  cwd: '.',
  args: ['--minify', '--target=es2022'],
  env: { NODE_ENV: 'production' },
  timeout: 30000,
  watch: ['vendor/src/**'],
}
```

## The Output Rule: Write to `dist/`, Not `src/`

> **The Lifecycle Output Rule:** Scripts executed by `pipeline.exec` must write generated files directly to the output directory (`dist/`), never into source directories (`src/`). Writing generated artifacts into source directories pollutes source control and triggers infinite file watcher loops in dev mode.

## File Watching in Dev Mode

When running `bascik` in development mode:

1. Scripts with a `watch` pattern re-execute automatically whenever matching files change.
2. Bascik coordinates exec script execution with page compilation and Server-Sent Events (SSE) live reload, ensuring that edits to watched paths trigger the script and issue a single coordinated browser reload.

### Start-of-session behavior

A watched exec script still runs once at startup as part of its `phase`. A `pre` script is awaited before any page compiles; a `parallel` script starts alongside the server and page compilation and publishes its output when it finishes; a `post` script runs after the initial transpile. Registering the dev watcher does **not** re-run that startup work: each session runs an exec script exactly once for its phase plus once per later matching edit.

### Parallel scripts in dev

A `parallel` script never blocks dev startup. The dev server binds and the first transpile begins while the script is still running, so a page that reads the script's output sees whatever is on disk at compile time (or handles a missing file) until the script completes. When it completes, Bascik re-transpiles the pages that read its output and issues one coordinated reload. If it fails, the failure surfaces as a build-error overlay and no success reload is sent. Pages that must have the generated data before their first compile belong in `pre`.

### The overlap contract

Listing a path in both `pipeline.watchPaths` and an `exec[].watch` config means an edit to that path has two consumers: the exec producer that regenerates an output and the watch-path handler that re-transpiles pages. Bascik coordinates these into one owner:

1. When a watched path changes, any matching exec producer runs first.
2. Only after the producer completes are the affected consumer pages re-transpiled, so a page never compiles against a not-yet-produced output.
3. The browser receives exactly one reload for the completed generation.

A producer that fails surfaces an honest build-error overlay and never issues a success reload. Pages keep serving their last-known-good representation until the next valid producer run.

## Example: Generating a Search Index

A common pattern is reading content files and writing a lightweight JSON search index:

```ts
// scripts/generate-search-index.ts
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function generateIndex() {
  const files = await readdir('./content');
  const index = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join('./content', file), 'utf8');
    const title = text.match(/^#\s+(.+)$/m)?.[1] ?? file;
    index.push({ file, title, length: text.length });
  }

  await writeFile('dist/search-index.json', JSON.stringify(index, null, 2));
  console.log(`[search-index] Generated index for ${index.length} documents.`);
}

await generateIndex();
```

Register it in `bascik.config.ts`:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'scripts/generate-search-index.ts',
        phase: 'post',
        watch: ['content/**'],
      },
    ],
  },
});
```

## Example: Bundling npm Packages for the Browser

Bascik does not rewrite bare specifiers in client scripts. Use an exec script with esbuild to bundle client-side npm libraries into `dist/assets/`:

```ts
// scripts/bundle-client.ts
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['scripts/client-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/assets/bundle.js',
  minify: process.env.NODE_ENV === 'production',
});
```

```html
<!-- src/pages/index.html -->
<script type="module" src="/assets/bundle.js"></script>
```

> **Testing Exec Scripts:** Read the [Exec Scripts Testing Guide](/testing/exec-scripts) to learn how to structure lifecycle scripts for unit testing with Vitest.
