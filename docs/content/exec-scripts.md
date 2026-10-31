# Exec Scripts

Lifecycle scripts allow you to execute arbitrary Node.js tasks at defined phases of the compilation pipeline. Use them to generate sitemaps, search indexes, RSS feeds, optimize assets, or bundle client-side npm libraries.

## pipeline.exec

Configure lifecycle scripts in `bascik.config.ts` under the `pipeline.exec` array. Each entry specifies a script path and optional execution settings:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: "scripts/generate-search-index.ts",
        phase: "post",
        watch: ["content/"],
      },
    ],
  },
});
```

Every entry is an object with at least a `script` key. A bare string such as `exec: ['scripts/generate-sitemap.ts']` is rejected at startup, and the error shows the object form to write instead: `{ script: 'scripts/generate-sitemap.ts' }`.

## Lifecycle Execution Phases

The `phase` property controls when your script runs relative to HTML page transpilation:

| Phase             | Description                                                                                                                                                         | Common Use Cases                                                       |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------- |
| `'pre'` (default) | Awaited before any page or component is transpiled.                                                                                                                 | Fetching external CMS data, preparing JSON catalogs, asset downloading |
| `'parallel'`      | Starts alongside page compilation in dev and build. Dev does not wait; a build joins every parallel task before reporting success. Completion never compiles pages. | Independent background artifact generation                             |
| `'post'`          | Executed after all pages and assets are compiled and written to `dist/`.                                                                                            | Search indexing, XML sitemap generation, post-processing bundles       |

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    exec: [
      { script: "scripts/sync-cms.ts", phase: "pre" },
      { script: "scripts/generate-index.ts", phase: "post" },
    ],
  },
});
```

## Configuration Options

Each exec entry in `pipeline.exec` accepts:

| Property            | Type                            | Default         | Description                                                                                                                                                                                                             |
| :------------------ | :------------------------------ | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script` (required) | `string`                        | none            | Path to the script file, relative to the project root                                                                                                                                                                   |
| `phase`             | `'pre' \| 'post' \| 'parallel'` | `'pre'`         | When the script executes relative to page transpilation                                                                                                                                                                 |
| `watch`             | `string \| string[]`            | `[]`            | File or directory globs that trigger script re-execution during dev mode                                                                                                                                                |
| `cwd`               | `string`                        | `process.cwd()` | Working directory the script starts in; `script` still resolves from the project root. A missing folder is a startup warning (none inside `directory.out`, which the build creates) and an error when the script starts |
| `env`               | `Record<string, string>`        | `{}`            | Custom environment variables merged with `process.env`                                                                                                                                                                  |
| `args`              | `string[]`                      | `[]`            | Command-line arguments passed as `process.argv`                                                                                                                                                                         |
| `timeout`           | `number`                        | `60000`         | Maximum run time in milliseconds, in every phase including `parallel`; `0` means no limit. See [Timeouts and stopping](#timeouts-and-stopping)                                                                          |

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

### Timeouts and stopping

`timeout` applies to every phase, `parallel` included, so a script that keeps running (a CSS or content watcher started as a `parallel` entry) is stopped after 60 seconds unless it sets `timeout: 0`. A build still waits for every `parallel` script, so a script that never exits keeps `bascik --build` from finishing; start a long-running watcher only in dev, for example from a mode export.

When a script times out, Bascik sends `SIGTERM` to the script and to every process it started (a wrapper's `tailwindcss --watch`, a shell), then `SIGKILL` 500 ms later to whatever is still running, even a process that outlived the script itself (each one is first checked to be the same process, by its start time, so a reused process ID is left alone; where `ps` reports no start times, as BusyBox `ps` on Alpine does, only a process whose chain of parents up to the still-running script is unchanged gets `SIGKILL`, and Bascik prints one warning naming the process IDs it left running), and reports `exec "<script>" timed out after <timeout>ms` once the script has exited. The rest of that phase does not run. On Windows the whole process tree is ended with `taskkill /T /F`; if `taskkill` cannot run, Bascik still stops the script itself and prints one warning that the processes it started may still be running. Bascik stops running scripts and their processes the same way whenever it exits: Ctrl+C, a failed build or dev boot, or an exec failure under `pipeline.onExecError: 'error'`. A process that detaches itself into its own session is outside that tree, so have the script keep its children attached.

### Watching source inputs

`pipeline.exec[].watch` selects which scripts rerun after a matching source edit. That edit owns one phase-ordered rebuild cycle: matching pre scripts finish, parallel scripts start alongside associated page compilation, then matching post scripts run after compilation and its disk writes finish. Completion itself never queues a second compilation. Do not configure `pipeline.watchPaths` for generated outputs.

List every source the script reads in its `watch`, including the local modules it imports (a page list in `src/lib/nav.ts`, for example). `pipeline.watchPaths` re-renders pages but never reruns a script, so an input missing from `watch` leaves the script's output stale until the dev server restarts.

This illustrative configuration generates a catalog before compilation and observes its source inputs for subsequent updates:

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    exec: [
      {
        script: "scripts/generate-catalog.ts",
        phase: "pre",
        watch: ["content/"],
      },
    ],
  },
});
```

```html
<!-- src/pages/catalog.html -->
<script data-bascik-build>
  import { readFileSync } from "node:fs";
  import { html } from "@bascik/bascik/html";

  export default function () {
    const catalog = JSON.parse(readFileSync("dist/catalog.json", "utf8"));
    return html`${catalog.items.map((item) => html`<li>${item.title}</li>`)}`;
  }
</script>
```

Known source dependents rebuild once per cycle. If an external source input or watched script has no known dependents, all pages rebuild conservatively, but unmatched exec scripts do not rerun. For selective rebuilding, page build scripts should read their source inputs so the dependency graph can associate them with pages. Generated dependency bytes are rechecked after pre finishes; result caching remains enabled.

## The Output Rule: Write to `dist/`, Not `src/`

> **The Lifecycle Output Rule:** Scripts executed by `pipeline.exec` must write generated artifacts directly to the output directory (`dist/`), never into source files or any watched files or directories. This includes pre, post, and parallel scripts. Do not add generated outputs to `pipeline.watchPaths` or `pipeline.exec[].watch`. There is no `outputs` option.

The coordinated watcher excludes the output directory, including when a broad source pattern would otherwise cover it. Bascik cannot safely distinguish a child process writing a source file from a user editing that same file. It does not suppress edits using time windows, rewrite counts, or script-path exclusions. Accidental writes to watched sources can therefore loop; fix the script's destination rather than relying on loop detection.

## File Watching in Dev Mode

When running `bascik` in development mode:

1. A single source observer combines pages, components, `pipeline.watchPaths`, and exec source patterns when watched exec entries exist.
2. Matching scripts run in their configured phases around one associated compilation batch. Pre and post scripts run sequentially in configuration order.
3. A page edit does not rerun scripts whose watch patterns do not match. An exec-only source edit still rebuilds its associated pages; duplicating that source in `pipeline.watchPaths` is unnecessary.
4. Edits arriving during pre, compilation, or post are retained for a following cycle. Failed-cycle paths are retained for retry when another source edit arrives, not retried endlessly without an edit.
5. Successful compilation reloads are held until post succeeds. Pre, compilation, or post failure reports a build-error without a success reload for that cycle.

This recording runs the dev server with a `post` script that watches `content/` and writes `dist/search-index.json`. Saving `content/notes.md` rebuilds only the page that reads it, then reruns the script:

![A terminal running bascik. The server address stays pinned to the top row. Five pages transpile, then the search-index exec script runs once and logs indexed: Release notes. After content/notes.md is saved, only pages/notes.html is rebuilt and the script runs again, logging indexed: Release notes for 1.0](/assets/demos/exec-watch@2x.webp)

## When a script fails

`pipeline.onExecError` decides what a failing script does. It applies to every phase (`pre`, `parallel`, and `post`), at startup and on later edits.

| `onExecError` | `bascik` (dev)                                                                                                        | `bascik --build`                                                             |
| :------------ | :-------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| `'warn'`      | Reports a build-error in the terminal and in open browsers, keeps serving, and retries on the next edit. **Default.** | Logs the failure and keeps building. The build can still exit 0.             |
| `'error'`     | Reports the failure and exits 1.                                                                                      | Stops the build and exits 1, without printing "Build complete". **Default.** |

The defaults are opposite on purpose. While you write a script, a typo should not take down the dev server every time. In a build, a script failure must never produce output that looks successful. Set the option to flip either one:

```ts
// bascik.config.ts
export default defineConfig({
  pipeline: {
    onExecError: "error", // dev also stops on a failing script
    exec: [{ script: "scripts/generate-feed.ts", phase: "post" }],
  },
});
```

To change only one mode, use the [mode exports](/configuration#mode-overrides-dev-build-server), like any other option. This makes dev stop on a failing script and leaves builds on their default:

```ts
export const dev = defineConfig({
  pipeline: { onExecError: "error" },
});
```

Setting it in the default export changes both modes. It does not change how page compile errors are handled: a page that fails to compile is reported in dev and fails a build either way.

A `pre` failure under `'warn'` does not skip anything: pages still compile, so a page that reads the missing output may fail on its own. When a `post` script reads content that is still being written, wait for the "Server running" line before editing.

### Start-of-session behavior

A watched exec script still runs once at startup as part of its `phase`. A `pre` script is awaited before any page compiles; a `parallel` script starts alongside the server and page compilation; a `post` script runs after the initial transpile. Registering the dev watcher does **not** re-run that startup work: each session runs an exec script exactly once for its phase plus debounced reruns for later matching edits.

A failing script follows [When a script fails](#when-a-script-fails) the same way at startup as in a later edit cycle.

### Parallel scripts in dev

A `parallel` script never blocks dev startup or later page compilation. Pages must not depend on its output being ready; use `pre` for required dependencies. Every parallel promise is observed, including failures after other tasks fail. A parallel failure reports a build-error and its completion never sends a reload. It cannot retract a page reload already delivered before that asynchronous failure, and it never fails a later edit's cycle: a script started by one edit that fails while a later edit's pages compile is reported on its own, and the later edit still reloads. Repeated runs of the same watched parallel entry are serialized without blocking page edits or independent scripts.

In a one-shot build, parallel scripts genuinely run alongside compilation. Post starts after compilation, without waiting for parallel. The build waits for both branches to settle before finalizing metadata or declaring success, and under the default `onExecError: 'error'` reports any failure with a nonzero exit status.

Because metadata is finalized after post settles, a post script cannot read the private build folder's files (`.bascik/dist/`) such as `csp-hashes.json`, `server-scripts.json`, or the asset manifest: they are not on disk yet. A post script that needs CSP hashes, for example to write host headers, computes them from the emitted HTML in `dist/` it already sees. With `generate.cspHashes` on, the build takes `csp-hashes.json` from the pages as `post` and `parallel` scripts left them, so a script that edits inline code ships with matching hashes. A script must keep each server-script placeholder (`<script type="text/bascik-server" data-bascik-server-id="…">`) it finds: one that removes a placeholder fails the build, with a message that names the page and the tag to paste back.

### Overlapping watches share one cycle

Listing a source in both `pipeline.watchPaths` and `pipeline.exec[].watch`, or watching a page source with exec, does not create independent rebuilds. The same edit selects matching scripts and affected pages once, preserving pre and post ordering. No generated output watcher or completion-driven second pass is needed.

## Example: Generating a Search Index

A common pattern is reading content files and writing a lightweight JSON search index:

```ts
// scripts/generate-search-index.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function generateIndex() {
  const files = await readdir("./content");
  const index = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(join("./content", file), "utf8");
    const title = text.match(/^#\s+(.+)$/m)?.[1] ?? file;
    index.push({ file, title, length: text.length });
  }

  await writeFile("dist/search-index.json", JSON.stringify(index, null, 2));
  console.log(`[search-index] Generated index for ${index.length} documents.`);
}

await generateIndex();
```

Register it in `bascik.config.ts`:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: "scripts/generate-search-index.ts",
        phase: "post",
        watch: ["content/**"],
      },
    ],
  },
});
```

## Example: Bundling npm Packages for the Browser

Bascik does not rewrite bare specifiers in client scripts. Use an exec script with esbuild to bundle client-side npm libraries into `dist/assets/`:

```ts
// scripts/bundle-client.ts
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["scripts/client-entry.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/assets/bundle.js",
  minify: process.env.NODE_ENV === "production",
});
```

```html
<!-- src/pages/index.html -->
<script type="module" src="/assets/bundle.js"></script>
```

> **Testing Exec Scripts:** Read the [Exec Scripts Testing Guide](/testing/exec-scripts) to learn how to structure lifecycle scripts for unit testing with Vitest.
