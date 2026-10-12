# Asset Fingerprinting

This guide covers content-hashing asset filenames so a CDN can cache them forever, and when that is worth doing.

## What fingerprinting is for

Bascik inlines component CSS and JavaScript directly into page markup, so fingerprinting primarily matters for **images, fonts, and other copied page assets**, not for inlined stylesheets and scripts. A reader arriving from another framework will expect the opposite, because bundler-based frameworks fingerprint every CSS and JS file. In Bascik there is nothing to fingerprint for those: they are already inside the HTML.

## The real fix for most sites: no build step

Bascik's production server already sends strong SHA-256 content-hash `ETag` headers and returns `304 Not Modified` for unchanged content, so identical bytes produce identical ETags across server instances. The `http.cacheControl` option tunes per-extension caching policies with no build step at all:

<!-- demo:cache-control-config -->
```ts
// bascik.config.ts: per-extension cache-control, no build step needed.
// Pair immutable with fingerprinted filenames whose content cannot change.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  http: {
    cacheControl: {
      '.woff2': 'public, max-age=31536000, immutable',
      '.png': 'public, max-age=86400',
    },
  },
});
```

For most sites that is the correct and sufficient answer.

## When to fingerprint

Fingerprinting is for the case where you want **immutable, far-future caching on a CDN**. A fingerprinted filename (`hero.0eace9e1a7.png`) lets the CDN hold the asset forever, because changing the content changes the name, and the new name is a cache miss by definition. Only pair `immutable` with a URL whose content cannot change, which is exactly what a content hash guarantees.

One honest note: do not expect a Lighthouse improvement. The `uses-long-cache-ttl` audit is unweighted in Lighthouse 10 and later, so fingerprinting will not move the score. Do it for CDN behavior, not for a score.

## A lighter option: version the URL, keep the file name

A content hash does not have to be part of the file name. Appending it as a query string (`hero.webp?v=0eace9e1a7`) gives the same guarantee: when the bytes change, the URL changes, so a far-future cache can never serve a stale copy. Nothing is renamed on disk, and there is no post-build rewrite pass. Whatever writes the `<img>` tag computes the hash while it renders, because it already knows the file.

The Bascik docs site works this way for its recorded demos and screenshots. The image helper in `docs/src/lib/md-renderer.ts` hashes each file in `/assets/demos/` and `/assets/vscode/` and emits `?v=<hash>` on the `src` and `srcset` URLs. A build script then writes a Cloudflare Pages `_headers` file that marks only those two folders `immutable`:

```text
/assets/demos/*
  Cache-Control: public, max-age=31536000, immutable

/assets/vscode/*
  Cache-Control: public, max-age=31536000, immutable
```

Two details matter on Cloudflare Pages:

- **`http.cacheControl` does nothing there.** That option configures `bascik --server` only. Pages sets its own headers, and a `_headers` file in the output is how you override them.
- **Bascik does not copy extensionless files**, so a `_headers` file in `src/pages/` never reaches `dist/`. Write it from a `pipeline.exec` script in the build config, the same way the CSP example in [Deployment](/deployment) writes `dist/_headers`.

Only mark a folder `immutable` when every reference to it is versioned. An unversioned URL into that folder would be cached for a year.

## The recipe: hash, rename, rewrite

An `exec` step that runs **after** pages are written, hashes each asset, renames it, and rewrites references in the built HTML:

<!-- demo:fingerprint-config -->
```ts
// bascik.config.ts: run fingerprinting as a post-transpile exec step,
// after pages are written to dist/ and asset references exist to rewrite.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'fingerprint-assets.mjs',
        phase: 'post',
      },
    ],
  },
});
```

<!-- demo:fingerprint-script -->
```js
// fingerprint-assets.mjs: content-hash renames for copied page assets,
// then rewrites references in the built HTML.
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ASSET_DIR = 'dist/assets/img';
const files = await readdir(ASSET_DIR);

const renames = [];
for (const file of files) {
  const full = join(ASSET_DIR, file);
  const buf = await readFile(full);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const dot = file.lastIndexOf('.');
  const hashed = `${file.slice(0, dot)}.${hash}${file.slice(dot)}`;
  if (hashed !== file) {
    await rename(full, join(ASSET_DIR, hashed));
    renames.push([`/assets/img/${file}`, `/assets/img/${hashed}`]);
  }
}

// Rewrite references in built HTML. String replacement is the fragile
// part: it cannot tell a real reference from prose that happens to
// contain the same path.
for (const [from, to] of renames) {
  const page = await readFile('dist/index.html', 'utf8');
  await writeFile('dist/index.html', page.split(from).join(to));
}
console.log(`fingerprinted ${renames.length} asset(s)`);
```

## The reference-rewriting problem

Reference rewriting is the hard part of fingerprinting, and a naive string replace across HTML is fragile. It cannot tell a real `<img src="/assets/img/hero.png">` reference from a code example or prose that happens to contain the same path, it misses references built at runtime from concatenated strings, and it must run on every page that references the asset, not just one. For a handful of images on a small site the script above is honest and workable. For a large asset tree, consider generating the references from a manifest (hash the asset, then emit the `<img>` tag from a build script that already knows the hashed name) so there is nothing to rewrite after the fact.
