# JavaScript Libraries and Progressive Enhancement

Bascik adds no JavaScript, and it does not stop you from adding libraries. The patterns below show how to combine Bascik with common runtime libraries. Do not add a library unless the project already uses it or the user asks for it.

## Loading a library

Put a CDN `<script src>` in the page `<head>` or in a shared head component. External script tags pass through unchanged.

```html
<head>
  <script src="https://unpkg.com/petite-vue" defer init></script>
</head>
```

### npm packages in the browser

Bare specifiers do not work in client scripts. Bascik does not rewrite `import x from 'some-package'` in a `<script type="module">`, so the browser fails with `Failed to resolve module specifier`. Bare imports work only in Node-side scripts (`data-bascik-build`, `data-bascik-server`, `data-bascik-stream`, `data-bascik-routes`).

For a package without a CDN build:

1. Write a small entry file that imports only what is genuinely shared (the library, or shared runtime state).
2. Bundle it with esbuild from a `pipeline.exec` script with `phase: 'pre'`, writing to `BASCIK_OUT_DIR` (for example `dist/assets/js/vendor.js`). Never write the bundle into `src/`.
3. Load it with a root-relative URL: `<script type="module" src="/assets/js/vendor.js"></script>`.

Keep page and component behavior in their own scripts. Do not move all UI logic into one bundle just to import an npm dependency.

## petite-vue

About 5 KB, Vue-compatible. `v-scope` gives an element isolated reactive state:

```html
<!-- src/components/my-counter.html -->
<div v-cloak v-scope="{ count: 0 }">
  {{ count }}
  <button @click="count++">+</button>
</div>
```

Load once in the page `<head>` with `defer init` to mount every `v-scope` element.

## Alpine.js

```html
<div x-data="{ open: false }">
  <button @click="open = !open">Toggle</button>
  <p x-show="open">Hidden content.</p>
</div>
<script src="https://unpkg.com/alpinejs" defer></script>
```

## Tailwind CSS

Tailwind utility classes are global by design. Turn class scoping off so Bascik never renames them (otherwise `class="flex gap-4"` can become `class="bascik__my-comp__flex ..."`, which Tailwind's CSS never matches):

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  scoping: {
    attributes: {
      class: false, // Tailwind utility classes pass through unchanged
    },
  },
});
```

```html
<!-- src/components/feature-card.html -->
<div class="rounded-xl border border-gray-200 p-6 shadow-sm">
  <h3 class="mb-2 text-lg font-semibold" data-bascik-prop-title></h3>
  <p class="text-sm text-gray-600" data-bascik-prop-body></p>
</div>
```

Trade-off: with `class: false`, component class names are no longer isolated. IDs and `name` attributes stay scoped.

For production, run the Tailwind CLI or PostCSS from a `pipeline.exec` `pre` script into `BASCIK_OUT_DIR`, with Tailwind's `content` covering `src/**/*.html` and any helpers that print markup (`src/lib/**/*.ts`). `@apply` inside component CSS is not processed; keep it in the global Tailwind input file. A `dark` class toggled on `<html>` works when the component's own CSS does not define `dark`.

## HTMX, Stimulus, and others

- **HTMX:** `hx-get` and `hx-post` attributes pass through. Pair with API routes or server scripts under `bascik --server`.
- **Stimulus:** `data-controller` attributes pass through.
- **Chart.js, D3, Leaflet:** mount to an element found with `getElementById`; Bascik rewrites the ID string and the element's `id` together, so they stay in sync.
