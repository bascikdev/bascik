# Bundling npm Packages

Many npm packages ship no CDN build. This guide shows how to use any npm package in client-side JavaScript by bundling it with esbuild as a build step, writing the bundle into the output directory, and referencing it from the page.

## What Bascik does with bare specifiers

Bascik does **not** rewrite bare specifiers in client-side scripts. A line like `import x from 'some-package'` in a `<script type="module">` passes through to the browser verbatim, and the browser fails with `Failed to resolve module specifier`. Bare specifiers work in `data-bascik-build` and `data-bascik-server` scripts because those run in Node.js, which resolves them against `node_modules`. Client scripts run in the browser, where no such resolution exists.

<!-- demo:bare-specifier -->
```html
<script type="module">
  // DOES NOT WORK: Bascik does not rewrite bare specifiers in client
  // scripts. The browser receives this line verbatim and fails with
  // "Failed to resolve module specifier".
  import { confetti } from 'canvas-confetti';
  confetti();
</script>
```

The fix is to bundle the package yourself at build time and import the bundle with a root-relative URL the browser can resolve.

## The recipe: esbuild as an exec step

Install esbuild and the package you want to use as development dependencies:

```sh
npm install --save-dev esbuild canvas-confetti
```

Write a small bundler script at the project root. It bundles a browser entry point, resolves the bare specifier, and writes the output into `dist/assets/js/`:

<!-- demo:bundle-script -->
```js
// build-bundle.mjs: bundles client dependencies into dist/assets/js/.
// Run as a pipeline.exec step with phase: 'pre' so the bundle exists
// before pages are transpiled and referenced.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/confetti-entry.mjs'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: 'dist/assets/js/confetti-bundle.mjs',
});
```

The entry point is where the bare specifier lives. esbuild resolves it against `node_modules` and inlines the package into the bundle:

<!-- demo:bundle-entry -->
```js
// src/client/confetti-entry.mjs: the browser entry point.
// Bare specifiers are fine here because esbuild resolves and bundles them.
import confetti from 'canvas-confetti';

export const celebrate = () => confetti();
```

Register the bundler as a `pipeline.exec` step in `bascik.config.ts`:

<!-- demo:bundle-config -->
```ts
// bascik.config.ts: run the bundler as a pre-transpile exec step.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'build-bundle.mjs',
        phase: 'pre',
        watch: ['src/client/'],
      },
    ],
  },
});
```

`phase: 'pre'` guarantees the bundle exists before page transpilation begins, so pages can reference it on the very first build. The `watch` entry re-runs the bundler in dev mode when the entry point changes, then triggers a coordinated browser reload.

Finally, reference the bundle from the page with a root-relative URL:

<!-- demo:bundle-page -->
```html
<script type="module">
  // Root-relative URL to the bundle esbuild wrote into dist/assets/js/.
  import { celebrate } from '/assets/js/confetti-bundle.mjs';

  document.getElementById('celebrate-btn').addEventListener('click', celebrate);
</script>
```

## Why direct output is the escape hatch

Bascik copies page assets from the pages tree, but generated files that live outside the pages tree, like bundles, need a deliberate destination. Writing directly into `directory.out` (`dist/` by default) is the explicit escape hatch for generated files: the bundler owns `dist/assets/js/`, Bascik owns the rest, and neither fights the other. Because the exec step runs on every build, the bundle in `dist/` is never stale.

## What happens on watch

In dev mode, editing a file listed in `exec[].watch` re-runs the bundler, re-transpiles affected pages, and issues exactly one coordinated browser reload. Editing the page itself re-transpiles the page but does not re-run the bundler, which is correct: the bundle depends on the entry point, not on the page.
