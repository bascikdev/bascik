# Content Security Policy

This guide covers serving a strict Content Security Policy (CSP) from a Bascik site, with no `'unsafe-inline'`, by listing the exact inline scripts each page contains.

## What Bascik does and does not do

Bascik inlines component `<style>` blocks and wraps component `<script>` blocks in isolated IIFEs, so every page carries inline code. A strict policy cannot use `'unsafe-inline'`, so it lists the SHA-256 hash of each inline script instead. A browser runs an inline script only when its hash is on the list.

Bascik does not set a policy for you. Which origins to trust, whether a library needs `'unsafe-eval'`, and how to treat styles all depend on your site, and a generic policy from the framework would either break pages or give false assurance. Bascik gives you the facts about your pages. The policy is yours.

Two ways to get the hashes:

- **`generate.cspHashes: true`** writes `dist/.bascik/csp-hashes.json`, mapping each page to the hashes of its inline scripts and styles. Read it from a step that runs after the build finishes, such as a deploy command or a CI step.
- **Hash the built HTML yourself** in a `post` exec script. Use this when you want to change the pages themselves, as in the recipe below. A `post` script cannot read `csp-hashes.json`, because Bascik finalizes that file after `post` scripts settle. See [Exec Scripts](/exec-scripts).

## Put the policy in a meta tag

A `<meta http-equiv="Content-Security-Policy">` tag carries a policy inside the page, so each page can list exactly its own hashes and no host configuration is needed. This works on any static host.

The script below runs after pages are written. It hashes every inline script in each built page and inserts a policy right after `<meta charset>`:

```ts
// bascik.config.ts: run after pages are written, so the hashes match the final script text.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [{ script: 'scripts/add-csp-meta.mjs', phase: 'post' }],
  },
});
```

```js
// scripts/add-csp-meta.mjs: illustrative recipe, adapt it to your site.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outDir = process.env.BASCIK_OUT_DIR;
if (!outDir) throw new Error('BASCIK_OUT_DIR is not set; run this as a pipeline.exec step');

const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi;
const hash = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

function policyFor(html) {
  const hashes = new Set();
  const origins = new Set();
  for (const [, attributes, body] of html.matchAll(SCRIPT)) {
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (src) {
      // A file from your own site is covered by 'self'. Another origin must be named.
      if (/^(?:https?:)?\/\//i.test(src)) origins.add(new URL(src, 'https://x.invalid').origin);
    } else if (!/\stype\s*=\s*["']?(?:application\/ld\+json|text\/bascik-server)/i.test(attributes)) {
      hashes.add(hash(body));
    }
  }
  const sources = ["'self'", ...origins, ...hashes];
  return `script-src ${sources.join(' ')}; object-src 'none'; base-uri 'self'`;
}

for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
  const file = join(entry.parentPath, entry.name);
  const html = await readFile(file, 'utf8');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html)}" />`;
  await writeFile(file, html.replace(/<meta\s+charset\s*=[^>]*>/i, (charset) => charset + meta));
}
```

The script writes into `BASCIK_OUT_DIR`, never into `src/`, per the [lifecycle output rule](/exec-scripts). It adds only `script-src`, plus `object-src 'none'` and `base-uri 'self'`, which cost nothing and close two common injection routes.

> **Hash the emitted bytes.** The browser hashes the text between the `<script>` tags exactly as served. Run the script last, after any other `post` step that edits the pages, or the hashes will not match.

## What a meta tag cannot do

Browsers ignore some directives in a `<meta>` policy: `frame-ancestors`, `sandbox`, and `report-uri`. Send those as a real response header from your host. Policies from the header and the `<meta>` both apply, and the browser enforces the stricter result, so you can split directives between them.

## Third-party scripts

A script loaded from another origin needs that origin in `script-src`, which the recipe adds automatically. Some libraries also need `'unsafe-eval'`. Alpine and petite-vue compile directive expressions with `new Function`, so a page that loads them needs `'unsafe-eval'` to work. Add it only for those pages. See [JavaScript Libraries](/libraries).

## Styles

Inline `<style>` blocks can be hashed the same way with a `style-src` directive. Inline `style="..."` attributes are different: a plain hash does not match them, and allowing them needs `'unsafe-hashes'` with the hash of each attribute value. Many sites leave `style-src` out of the first version of the policy and tighten scripts first, where the risk is highest.

## Check that it works

Open the page with the browser console visible. A blocked script logs a Content Security Policy violation that names the directive and shows the hash it expected. To test every page, listen for the event in a browser test:

```js
document.addEventListener('securitypolicyviolation', (event) => {
  console.error(event.violatedDirective, event.blockedURI, event.sample);
});
```

Test the built site, for example with `bascik --server`, because the hashes are computed from the built pages.

> **Next:** [Deployment Overview](/deployment) covers where headers belong on your host, and [Exec Scripts](/exec-scripts) covers the `post` phase.
