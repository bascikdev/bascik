# Third-Party Web Components

Use a custom element from npm on a Bascik page by publishing its file into the output directory, loading it with a module script, and declaring its tag in `components.external`. Bascik passes the tag through unchanged and the browser does the rest.

## See it in action

Hover over or tab to a heading in the box below. `<heading-anchors>` from [`@zachleat/heading-anchors`](https://github.com/zachleat/heading-anchors) is a custom element that adds a link to every heading that has an `id`. This page loads the same file the recipe below produces.

<!-- demo:heading-anchors-usage -->
```html
<heading-anchors>
  <h3 id="install">Install</h3>
  <p>Add the package with your package manager.</p>
  <h3 id="publish">Publish</h3>
  <p>Copy its file into the output directory.</p>
</heading-anchors>
```

<!-- demo:heading-anchors-head -->
```html
<head>
  <script type="module" src="/assets/vendor/heading-anchors.js"></script>
</head>
```

## Install the package

```sh
npm install --save-dev @zachleat/heading-anchors
```

## Publish the file to the output

This package ships a ready-to-use ES module that registers its own element, so no bundler is needed. For a package that imports other packages, [bundle it](/how-to/bundling-npm-packages) instead. Files in `node_modules` are never copied to the output, and Bascik does not rewrite bare specifiers in client scripts, so copy the file with an exec script:

```ts
// scripts/publish-heading-anchors.ts: copies a ready-to-use npm browser module
// into the output directory. Run it as a pipeline.exec step with phase: 'pre'.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const outDir = process.env.BASCIK_OUT_DIR;
if (!outDir) throw new Error('BASCIK_OUT_DIR is not set; run this as a pipeline.exec step');

// Resolve from the project's node_modules, wherever the package manager put it.
const source = createRequire(import.meta.url).resolve('@zachleat/heading-anchors');

await mkdir(join(outDir, 'assets/vendor'), { recursive: true });
await copyFile(source, join(outDir, 'assets/vendor/heading-anchors.js'));
```

Register it as a `pre` step so the file exists before any page references it. The path is illustrative; use your own script name and destination:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [{ script: 'scripts/publish-heading-anchors.ts', phase: 'pre' }],
  },
});
```

## Load and use the element

Load the file with a module script and wrap the content in the element. Bascik passes external script tags through unchanged.

```html
<head>
  <script type="module" src="/assets/vendor/heading-anchors.js"></script>
</head>
<body>
  <heading-anchors>
    <h2 id="install">Install</h2>
    <p>Add the package with your package manager.</p>
  </heading-anchors>
</body>
```

Module scripts are deferred, so headings render first and gain their links once the module runs. Without JavaScript the page shows plain headings.

## Declare the tag

A hyphenated tag with no component file looks like a typo, so by default every build prints `Unresolved component tag` for it and `bascik --check` lists it. With `--strict`, that listing fails the check. Declare the element so Bascik treats it as intentional:

```ts
export default defineConfig({
  components: {
    external: ['heading-anchors'],
  },
});
```

Entries are exact tag names or `*` wildcards such as `vendor-*`. Real typos stay reported. See [`components.external`](/configuration#componentsexternal) for the full rules.

## What Bascik does and does not do

- A declared tag is emitted exactly as written, and its contents are scoped like any other page markup.
- The published file is copied as is. Bascik does not scope, minify, or fingerprint it. Minify it in your exec script or use [Asset Fingerprinting](/how-to/asset-fingerprinting) if you need that.
- `components.external` only changes diagnostics. To keep ids and classes inside an element literal, add it to [`scoping.preserve`](/preserve#preserve-every-matching-tag) as well. Most elements need only `components.external`.
- For CDN-hosted libraries that need no copy step, see [JavaScript Libraries](/libraries).
