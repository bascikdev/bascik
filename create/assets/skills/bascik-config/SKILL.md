---
name: bascik-config
description: Configure, build, and deploy Bascik sites. Use when deciding whether a bascik.config.ts is needed, editing one (directory, components.external, scoping, minify, assets, generate, pipeline.exec, pipeline.watchPaths, scripts, http, base), setting BASCIK_SITE_URL, deploying to a static host, running bascik --server in production, building a Cloudflare bundle with --target, or placing static assets, 404, and 500 pages. Includes an audit script that flags redundant or invalid config.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Bascik Configuration and Deployment

Bascik is zero-config. Most sites never need `bascik.config.ts`. Requires the `bascik` skill for project basics.

## Decide whether a config is needed

Create `bascik.config.ts` only after naming a concrete requirement that differs from a built-in default. Examples that justify one:

- `components.external` for third-party custom elements
- `pipeline.exec` for an existing lifecycle script (Tailwind, esbuild bundle, feed, search index)
- `pipeline.watchPaths` for helpers or content outside pages and components
- `base` for a subdirectory deployment
- `scoping.attributes.class: false` for Tailwind
- `generate.sitemapLastmod`, `generate.cspHashes`, or a custom `minify.js`

If every value would equal a default, do not create the file. If one exists, keep only the non-default values. Run the audit after every edit:

```sh
node <skill-dir>/scripts/audit-config.mjs
```

It reports values that restate defaults, `siteUrl` in config, exec scripts that do not exist, watched output paths, `minify` values in the default export that silently change production builds, and `build.pipeline.exec` lists that drop default scripts. Exit code 1 means an error; `--strict` also fails on redundant values.

## Shape

```ts
// bascik.config.ts (minimal example)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: { sitemapLastmod: true },
});

// Optional per-mode overrides, deep-merged over the default export:
export const dev = defineConfig({ /* dev server only */ });
export const build = defineConfig({ /* bascik --build only */ });
export const server = defineConfig({ /* bascik --server only */ });
```

- `bascik.config.js` wins when both `.js` and `.ts` exist. `--config <path>` selects a file explicitly.
- `"type": "module"` must be in `package.json`.
- The config is validated at startup: unknown keys fail with a "did you mean" suggestion, and referenced paths must exist. All problems are reported together.
- Objects deep-merge across `default` and the mode export. **Arrays replace.** Defining `build.pipeline.exec` replaces the whole default `exec` list, so include every script that should run in production.
- Config changes need a dev server restart.

## Built-in mode defaults

`bascik --build` and `bascik --server` already turn on `minify.html`, `minify.css`, `minify.js`, and `minify.identifiers`, and treat script and minify errors as fatal. Never write an all-`true` `minify` block. Dev defaults leave minification off.

Merge order is: built-in defaults, then the mode's defaults, then your `default` export, then your mode export. A value in the `default` export therefore applies to production too: `minify: { identifiers: false }` there keeps production names readable, which is rarely what you want. Put dev-only settings in `export const dev`.

## Rules (must follow)

1. **Never put `siteUrl` in config.** It is an error. Provide it per deployment: `--site-url` flag, then `BASCIK_SITE_URL`, then `.env` (loaded automatically; `--env-file <path>` is repeatable). Sitemap and robots generation (on by default) fail the build without it.
2. **Do not restate defaults** such as `directory.pages: 'src/pages'`, `scoping.deduplicateCss: true`, `scoping.scriptBlocks: true`, empty `pipeline.exec` or `pipeline.watchPaths`, or `base: '/'`.
3. **Do not invent `pipeline.exec` scripts.** Reference only script files that exist in the project.
4. **Exec scripts write to `BASCIK_OUT_DIR` only.** Never into `src/` or any watched path, and never list generated output in `pipeline.watchPaths` or an exec entry's `watch`. There is no `outputs` option.
5. **Use `phase: 'pre'`** for output that pages depend on (bundles, copied vendor modules); `'parallel'` for independent artifacts (search index); `'post'` for steps that read or edit the compiled `dist/` (feeds, sitemap post-processing).
6. **`base` is a literal path prefix** such as `'/docs/'`: no full URL, query, fragment, percent escapes, backslashes, or dot segments. Bascik rewrites root-relative URLs in HTML, CSS, and web manifests, but not URLs built in JavaScript; expose `BASCIK_BASE` from a build script for those.
7. **Keep scoping defaults** (`deduplicateCss`, `scriptBlocks`, `inheritAttributes`) unless a specific integration requires a change, and do not write them out just to keep them.

## Exec scripts

```ts
// bascik.config.ts (illustrative: these script files must already exist)
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    watchPaths: ['src/lib/', 'content/'],
    exec: [
      { script: 'scripts/bundle-vendor.ts', phase: 'pre', watch: ['scripts/vendor-entry.ts'] },
      { script: 'scripts/search-index.ts', phase: 'parallel', watch: ['content/'] },
    ],
  },
});
```

- Exec scripts receive `BASCIK_BUILD`, `BASCIK_PAGES_DIR`, `BASCIK_OUT_DIR`, `BASCIK_BASE`, and `BASCIK_SITE_URL`.
- `watch` reruns the matching script after a source edit in dev; exec-only inputs need no duplicate `pipeline.watchPaths` entry.
- `pipeline.onExecError`: `'warn'` (dev default) reports and continues; `'error'` (`--build` default) stops with exit 1.
- Full semantics (cycle ordering, retries, reload behavior): [references/config-reference.md](references/config-reference.md).

## Monorepos and shared components

`directory.pages`, `directory.components`, and `scripts.importRoot` are independent. `directory.components` accepts an array, and roots may live outside the project:

```ts
export default defineConfig({
  directory: { components: ['../../shared/components', 'src/components'] },
  scripts: { importRoot: '../../shared/scripts' },
});
```

Component names must be unique across all roots; roots may not nest or repeat (including through symlinks). `bascik add` copies into the first root.

## Assets and error pages

- Everything public lives under `directory.pages` (images, fonts, downloads, standalone CSS and JS) and is copied to `dist/` with the same structure. CSS and JS there are minified by `--build` automatically.
- Never copied: dotfiles and dot-directories, `node_modules`, `.html` (compiled instead), `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.map`, `.md`, test and spec files, and inlined stylesheets. `assets.exclude` adds globs relative to `directory.pages`.
- Exception: `src/pages/.well-known/` (top level only) is published to `/.well-known/` for RFC 8615 files such as `security.txt` or `assetlinks.json`. Dotfiles inside it stay private, the deny-list still applies to its files, and files need an extension to be served as assets.
- `src/pages/404.html` becomes `dist/404.html`, which static hosts and both Bascik servers serve for unknown paths.
- `src/pages/500.html` is used only by `bascik --server`. Do not port a 500 page into a static site.
- To exclude a redirect-only page from `sitemap.xml`: `<meta name="bascik-sitemap" content="exclude">`. An authored `src/pages/robots.txt` or `sitemap.xml` takes precedence (with a warning) over generation; turn the matching `generate` flag off when you keep one deliberately.

## Deploy

| Site uses | Deploy |
|---|---|
| Only static pages, build scripts, and dynamic routes | `BASCIK_SITE_URL=https://example.com bascik --build`, upload `dist/` to any static host |
| `data-bascik-server`, `data-bascik-stream`, or `src/api/` | `bascik --build && bascik --server` on Node, or `bascik --build --target cloudflare` for a Worker bundle |

`bascik --server` details (TLS, caching, compression, rate limits, proxies, health checks, Docker, systemd) and the Cloudflare target: [references/deployment.md](references/deployment.md).

## References

- [references/config-reference.md](references/config-reference.md): every option with its default, `http`, `minify.js`, TypeScript compiler, exec cycle semantics
- [references/deployment.md](references/deployment.md): static hosting, the production server, hardening, reverse proxies, serverless targets
