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
| `'parallel'` | Started before transpilation and joined before writing to `dist/`. | Independent background artifact generation |
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
| `script` (required) | `string` | — | Path to the script file, relative to the project root |
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
3. Listing a path in both `pipeline.watchPaths` and an `exec[].watch` configuration is fully supported and cleanly deduplicated.

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
