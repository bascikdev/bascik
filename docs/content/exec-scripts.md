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
| `'parallel'` | Starts alongside page compilation in dev and build. Dev does not wait; a build joins every parallel task before reporting success. Completion never compiles pages. | Independent background artifact generation |
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

### Watching source inputs

`exec.watch` selects which scripts rerun after a matching source edit. That edit owns one phase-ordered rebuild cycle: matching pre scripts finish, parallel scripts start alongside associated page compilation, then matching post scripts run after compilation and its disk writes finish. Completion itself never queues a second compilation. Do not configure `watchPaths` for generated outputs.

This illustrative configuration generates a catalog before compilation and observes its source inputs for subsequent updates:

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'scripts/generate-catalog.ts',
        phase: 'pre',
        watch: ['content/'],
      },
    ],
  },
});
```

```html
<!-- src/pages/catalog.html -->
<script data-bascik-build>
  import { readFileSync } from 'node:fs';
  const catalog = JSON.parse(readFileSync('dist/catalog.json', 'utf8'));
  console.log(catalog.items.map((item) => `<li>${item.title}</li>`).join(''));
</script>
```

Known source dependents rebuild once per cycle. If an external source input or watched script has no known dependents, all pages rebuild conservatively, but unmatched exec scripts do not rerun. For selective rebuilding, page build scripts should read their source inputs so the dependency graph can associate them with pages. Generated dependency bytes are rechecked after pre finishes; result caching remains enabled.

## The Output Rule: Write to `dist/`, Not `src/`

> **The Lifecycle Output Rule:** Scripts executed by `pipeline.exec` must write generated artifacts directly to the output directory (`dist/`), never into source files or any watched files or directories. This includes pre, post, and parallel scripts. Do not add generated outputs to `watchPaths` or `exec.watch`. There is no `outputs` option.

The coordinated watcher excludes the output directory, including when a broad source pattern would otherwise cover it. Bascik cannot safely distinguish a child process writing a source file from a user editing that same file. It does not suppress edits using time windows, rewrite counts, or script-path exclusions. Accidental writes to watched sources can therefore loop; fix the script's destination rather than relying on loop detection.

## File Watching in Dev Mode

When running `bascik` in development mode:

1. A single source observer combines pages, components, `watchPaths`, and exec source patterns when watched exec entries exist.
2. Matching scripts run in their configured phases around one associated compilation batch. Pre and post scripts run sequentially in configuration order.
3. A page edit does not rerun scripts whose watch patterns do not match. An exec-only source edit still rebuilds its associated pages; duplicating that source in `watchPaths` is unnecessary.
4. Edits arriving during pre, compilation, or post are retained for a following cycle. Failed-cycle paths are retained for retry when another source edit arrives, not retried endlessly without an edit.
5. Successful compilation reloads are held until post succeeds. Pre, compilation, or post failure reports a build-error without a success reload for that cycle.

### Start-of-session behavior

A watched exec script still runs once at startup as part of its `phase`. A `pre` script is awaited before any page compiles; a `parallel` script starts alongside the server and page compilation; a `post` script runs after the initial transpile. Registering the dev watcher does **not** re-run that startup work: each session runs an exec script exactly once for its phase plus debounced reruns for later matching edits.

### Parallel scripts in dev

A `parallel` script never blocks dev startup or later page compilation. Pages must not depend on its output being ready; use `pre` for required dependencies. Every parallel promise is observed, including failures after other tasks fail. A parallel failure reports a build-error and its completion never sends a reload. It cannot retract a page reload already delivered before that asynchronous failure. Repeated runs of the same watched parallel entry are serialized without blocking page edits or independent scripts.

In a one-shot build, parallel scripts genuinely run alongside compilation. Post starts after compilation, without waiting for parallel. The build waits for both branches to settle before finalizing metadata or declaring success, and reports any failure with a nonzero exit status.

### Overlapping watches share one cycle

Listing a source in both `pipeline.watchPaths` and `exec.watch`, or watching a page source with exec, does not create independent rebuilds. The same edit selects matching scripts and affected pages once, preserving pre and post ordering. No generated output watcher or completion-driven second pass is needed.

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
