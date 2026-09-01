# Transpilation Pipeline

Bascik transforms source HTML into deployable HTML by replacing every custom component tag with its resolved, scoped content. The pipeline runs in two nested phases: the page phase and the component phase.

## Overview

Every time a source page or component file changes, `pageProcessing(filePath)` in `processing.ts` is called. This is the top-level entry point for the whole pipeline.

Build scripts (`<script data-bascik-build>`) run **first**, before component resolution, so their output can contain component tags. Body HTML minification runs *after* component resolution so that whitespace-sensitive content from resolved components (e.g. `<pre>` blocks from `<code-block>`) is preserved intact.

## Multi-Page Startup: `processAllPages`

On startup (and whenever a component is added), the watch system calls `processAllPages()` instead of invoking `pageProcessing()` once per file. This avoids redundant I/O:

1. **Hoist shared computation.** `listComponents()` and `resolveInlineStylesHtml()` each run **once**, in parallel, before any page is processed. The results are passed to every page rather than re-computed per page.
2. **Prioritize open pages first.** In dev mode, `partitionByOpenPages()` separates pages into those currently open in active browser tabs and background pages. Active pages are transpiled, committed to `MemoryStore`, and have their `"transpiled"` reload events emitted immediately, so open browser windows update without waiting for the full site to compile.
3. **Transpile each page.** By default, pages are transpiled on the main thread via `processPageBatch()`. If `useWorkers: true` is set in `bascik.config.ts`, a `WorkerPool` is created instead with `Math.min(os.cpus().length, pageCount)` workers, and each worker is initialized with the shared `componentList` and `globalStylesHtml` via `workerData`. The worker pool also processes the prioritized open pages first before dispatching remaining background pages. Worker startup has a fixed cost (each worker loads the transpiler's module graph independently), so this only pays off for larger sites or CPU-heavy per-page work, see the [`useWorkers`](/configuration#useworkers) config option.
4. **Apply side effects on the main thread.** As each page finishes transpilation, the main thread runs `mem.storePage()` and emits the `"transpiled"` event. Brotli compression inside `storePage()` runs in the background and does not block the page from being marked ready or served.
5. **Write HTML without delaying dev serving.** Build mode awaits each write to `dist/`. In dev mode, Bascik first commits the page to `MemoryStore`, then starts the `dist/` write asynchronously. The server can return the updated page while that disk write is still pending.

## Phase 1: Page Phase (`pageProcessing`)

The page phase prepares the source HTML document and orchestrates the component phase:

1. **Execute build scripts.** Any `<script data-bascik-build>` blocks are run as Node.js ESM modules. Their stdout replaces the script tag. The result can contain component tags, these will be resolved in step 4. Output is cached on disk so unchanged scripts skip the child-process spawn on subsequent builds (see [Build Script Output Cache](#build-script-output-cache) below).
2. **Extract body and head.** The inner content of `<body>` and `<head>` are extracted separately so component injection can happen in both zones independently.
3. **Obtain component list.** On the multi-page startup path (`processAllPages`), the list is pre-computed once and passed in. On a single-page re-transpilation, it is loaded from `src/components/` at this point.
4. **Run component phase.** `recursivelyTranspile` is called on both the body and head HTML strings. Each call returns a `TranspileResult` containing the resolved HTML and the list of components that were used.
5. **Collect and deduplicate CSS.** All CSS from used components is gathered. Since multiple instances of the same component share identical scoped class names, `deduplicateCss` emits a single `<style>` block regardless of how many times a component appears on the page. Any global stylesheets configured via `inlineStyles` are also injected into `<head>` at this stage.
6. **Rewrite base paths.** When `base` is not `/`, root-relative HTML and CSS URLs receive the normalized prefix. This runs after component ID-reference rewriting, so `href="#id"` and `url(#id)` are already final and remain untouched, and before minification. With the default `/`, the step returns the original bytes immediately.
7. **Inject live-reload script.** In dev mode only, a small `<script>` that opens a Server-Sent Events connection to `/bascik-live-reload` is appended to the body.
8. **Minify.** HTML comments are stripped and excess whitespace is collapsed via `minifyHtml`. This runs *after* component resolution so that whitespace-sensitive content inside resolved components (e.g. `<pre>` blocks from `<code-block>`) is preserved intact.
9. **Reassemble HTML.** The resolved body and head are placed back into the original HTML document structure.
10. **Store and write output.** In build mode, the finished HTML is written to `dist/` before transpilation completes. In dev mode, the result is stored in the in-memory page store first, then written to `dist/` asynchronously so serving never waits for file I/O. Writes for repeated edits to the same page are serialized.
11. **Emit transpiled event.** `eventEmitter.emit("transpiled")` triggers live-reload for any connected browser.

### Output Directory Lifecycle

Dev and build runs remove `directory.out` before pre-phase lifecycle scripts execute, then repopulate it from the current source tree. This prevents deleted pages, renamed assets, and removed dynamic routes from surviving as stale deployment output. Cleaning happens before pre-phase scripts so files those scripts intentionally generate in `dist/` remain available to the rest of the run. Production server mode (`bascik --server`) reads an existing build and never cleans it.

During a dev session, the active file watcher also removes corresponding output files when it receives deletion events (`unlink` and `unlinkDir`).

## Build Script Output Cache & Batch Execution

Uncached `<script data-bascik-build>` blocks are executed by Node.js, which carries a ~50–150 ms V8 startup cost when spawning individual processes. Bascik optimizes cold builds by batching all uncached scripts on a page into a single harness runner process, and eliminates startup overhead entirely on warm builds via disk caching for scripts whose inputs have not changed.

### Page-Level Batch Execution

When a page contains multiple uncached `<script data-bascik-build>` blocks:
1. Bascik groups all uncached tasks into a single batch.
2. A lightweight ESM runner harness (`runner-<batchId>.mjs`) dynamically imports each script sequentially in one child process.
3. During evaluation, `process.stdout.write` and `process.stderr.write` are intercepted per script block to ensure clean output separation.
4. Outputs are mapped back to their corresponding tags, cached on disk, and spliced into the page simultaneously.

This reduces Node child process spawns from N scripts to 1 per page during cold builds.

### Location

Cache entries live under `node_modules/.cache/bascik/script-cache/` as individual JSON files named by their cache key:

```text
node_modules/.cache/bascik/script-cache/<sha256>.json
```

Each file contains `{ "v": <version>, "output": "<html>" }`. The `v` field is a hard-coded integer in `build-scripts.ts`; bumping it at the source level immediately invalidates every existing entry across all projects.

### Cache key

The key is the SHA-256 hex digest of:

1. The cache version integer.
2. The trimmed script content.
3. `"1"` or `"0"` for build vs. dev mode (`isBuild`), since the same script may produce different output in each mode via the `BASCIK_BUILD` env var.
4. The source file path (`BASCIK_SOURCE_FILE`).
5. The page file path (`BASCIK_PAGE_FILE`).
6. The page route path (`BASCIK_PAGE_PATH`), which guarantees page-aware component scripts derive distinct cache keys per page.
7. The site URL (`BASCIK_SITE_URL`), since it can influence output and changes rarely.
8. The dynamic route payload (`BASCIK_ROUTE`), if applicable.
9. The full content of every local file the script references, concatenated in order.

File references are extracted by `extractScriptDeps()` (exported from `build-scripts.ts`), which scans the script source for quoted path literals matching `content/*.md` or `scripts/*.{mjs,js,ts}` patterns:

```text
'./content/foo.md'          → included in key
'scripts/md-renderer.ts'  → included in key
```

If the script contains no detectable references, only items 1–5 contribute to the key.

### Invalidation

Because the content of every referenced file is hashed into the key, editing a content file produces a new key for any script that references it, giving a cache miss. Scripts on other pages that do not reference that file keep their old keys and continue to hit the cache.

To bust the entire cache manually, for example after upgrading `marked` or another build-time dependency that `scripts/*.{mjs,js,ts}` files import, delete the cache directory:

```sh
rm -rf node_modules/.cache/bascik/script-cache
```

### Interaction with `useWorkers`

When `useWorkers: true` is set, worker threads share the same filesystem and therefore the same cache directory. On the first (cold) build, multiple workers may independently get a cache miss for the same script, spawn child processes, and write the same entry. Because every worker writes the same content for the same key, the last write wins harmlessly. On subsequent builds all workers benefit from the cached entries.

## Phase 2: Component Phase (`recursivelyTranspile`)

The component phase recurses until no custom component tags remain in the HTML string. On each pass it finds the first component tag, fully resolves it, and substitutes it. It then repeats until no more tags are found.

### Fast-path string guards and raw-text masking mechanics

Component tags are valid markup only outside of raw-text elements. Text like `<my-card>` inside a `<script>` (for example, a JSON-LD schema string), a `<style>` comment, or a `<textarea>` is content rather than component usage. Resolving tags inside raw-text elements would inject component markup, including stray `</script>` closing tags, into script or style content and corrupt the document.

To prevent corruption while maintaining high performance, every tag search operates on a masked copy of the HTML generated by `maskRawTextContent`:

1. **Fast-path string existence guards:** Before running regex operations, `maskRawTextContent` performs a fast string check (`!htmlString.includes("<!--") && !/<(?:script|style|textarea)\b/i.test(...)`). Pages that do not contain comments or raw-text tags bypass masking regexes entirely. Similarly, DOM selector script rewrites (`prefixElementAttribute`), CSS custom property/layer/container scoping, prop injection, and slot replacements use `.includes()` guards to skip regex execution when target identifiers or markers are absent.
2. **Space-masking and index alignment:** The mask replaces the inner text of `<script>`, `<style>`, and `<textarea>` elements with an equal number of space characters. Because space characters preserve exact string lengths and byte offsets, character indices found in the masked copy (`getFirstComponent`, `findOpenTag`, self-closing fallbacks, and `findMatchingClose` depth counters) match the original string precisely. The compiler slices and splices the original string at those exact indices without allocating secondary offset maps or corrupting raw-text content.
3. **Unresolved tag scanner:** The unresolved-tag warning scanner uses the same masking approach, stripping raw-text content before checking for leftover hyphenated custom tags.

For each component tag found:

### Step 1: Scoping pipeline

A fresh `instanceId` (a random 8-byte hex string) is generated for this occurrence of the component. An ordered list of transform functions is assembled and applied in a pipeline (each step receives the output of the previous):

1. `prefixElementAttribute(c, "id", instanceId)`: scopes `id` attributes and all corresponding JS DOM selector references.
2. `prefixElementAttribute(c, "name", instanceId)`: scopes `name` attributes and `getElementsByName` calls.
3. `prefixElementAttribute(c, "class", instanceId)`: scopes class names in HTML attributes, CSS, and JS selector calls.
4. `namespaceScriptTags(c)`: wraps every inline `<script>` in an IIFE, preserves line positioning, and appends a `//# sourceURL` comment for browser DevTools source attribution.

Each step is skipped if disabled in `bascik.config.ts`.

### Step 2: Template resolution

1. **Props.** `injectProps` replaces every `data-bascik-prop-*` placeholder in the component template with the corresponding attribute value from the usage tag.
2. **Named slots.** `replaceNamedSlots` fills each `data-bascik-slot="name"` zone in the template with the matching `<div data-bascik-slot="name">` content from the usage site.
3. **Default slot.** The inner content of the usage tag is placed into the element carrying `data-bascik-slot` (no value). If the usage tag has no inner content, the template's fallback content is preserved.
4. **Attribute inheritance.** `mergeAttributesOntoRoot` copies pass-through attributes (`aria-*`, `data-*`, `class`, etc.) from the usage tag onto the component's root element. If the component template contains multiple root elements (or leading comments, `<script>`, or `<style>` blocks), attributes are merged onto the first root HTML element.

### Step 3: Substitution

`replaceTag` replaces the original usage tag in the parent HTML string with the fully resolved component HTML. The outer loop runs again on the updated string. Because component templates can themselves contain other component tags, this naturally handles any depth of nesting.

## Termination

The recursion terminates when `getFirstComponent` no longer finds any custom tag in the HTML string, i.e., when all recognized component names have been replaced with vanilla HTML.

<div class="callout">
<p><strong>Performance note:</strong> Each call to <code>recursivelyTranspile</code> uses the same in-memory <code>ComponentList</code> built once at the start of the pipeline. In the multi-page startup path, this list is pre-computed once and passed to every worker via <code>workerData</code>, components are never re-read from disk per page or per worker.</p>
</div>

## Selective Re-transpilation

When a component file changes during dev, Bascik does not reprocess every page. The memory store maintains a reverse index mapping each component name to the set of pages that use it. `selectivelyProcessPages` uses this index to retranspile only the affected pages.

## Scoped Name Format

All scoped attribute names follow this pattern:

```text
bascik__<componentName>__<instanceId>__<originalName>

# id and name attributes include instanceId for uniqueness:
bascik__my-nav__a1b2c3d4__search-input

# class attributes use component name only (no instanceId):
bascik__my-nav__toggle-btn
```

When `minify.identifiers` is enabled (the default for builds), each full scoped name is hashed to a short alphanumeric string using SHA-256 with Base62 encoding before being written to the output, e.g. `b2Y4G9eD1K8b`. See [Scoping System](/internals/scoping-system) for full details.
