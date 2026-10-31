# Content Security Policy

This guide covers serving a strict Content Security Policy (CSP) from a Bascik site, with no `'unsafe-inline'`, by listing the exact inline scripts each page contains. It has a recipe for each host: the Node production server, the development server, Cloudflare, and static hosts.

## What Bascik does and does not do

Bascik inlines component `<style>` blocks and wraps component `<script>` blocks in isolated IIFEs, so every page carries inline code. A strict policy cannot use `'unsafe-inline'`, so it lists the SHA-256 hash of each inline script instead. A browser runs an inline script only when its hash is on the list.

Bascik sends no policy by default. Which origins to trust, whether a library needs `'unsafe-eval'`, and how to treat styles all depend on your site, and a generic policy from the framework would either break pages or give false assurance. Bascik gives you the facts about your pages, and an opt-in option that sends the policy you write with those facts filled in.

Three ways to use the hashes:

- **`contentSecurityPolicy`** in `bascik.config.ts` sends a header with your directives plus each route's hashes, on the Node servers and on Cloudflare. This is the simplest path; see [Send the header with contentSecurityPolicy](#send-the-header-with-contentsecuritypolicy).
- **`generate.cspHashes: true`** writes `.bascik/dist/csp-hashes.json`, mapping each page to the hashes of its inline scripts and styles. Read it from a step that runs after the build finishes, such as a deploy command or a CI step.
- **Hash the built HTML yourself** in a `post` exec script. Use this when you want to change the pages themselves, as in the recipe below. A `post` script cannot read `csp-hashes.json`, because Bascik finalizes that file after `post` scripts settle, from the pages as they left them. See [Exec Scripts](/exec-scripts).

## Send the header with contentSecurityPolicy

Set the directives you want, written as in a CSP header with keywords in single quotes. Bascik adds each route's inline script hashes and inline style hashes to your directives and sends the result on every HTML response. Setting the option turns on `generate.cspHashes`. The hashes never allow more than your policy already does:

- **A directive you wrote is only extended.** Script hashes go at the end of `script-src`, and style hashes at the end of `style-src`. Your sources stay as written, in order. If you wrote `'none'`, the hashes replace it, so the directive allows those hashes and nothing else.
- **`script-src-elem` and `style-src-elem`**, when you write them, get the same hashes, because they take over from `script-src` and `style-src` for `<script>` and `<style>` elements. `script-src-attr` and `style-src-attr` get none: they cover inline `on...=` and `style=` attributes, which an element hash never matches.
- **A missing `script-src` or `style-src` starts from `default-src`.** Bascik creates the directive from your `default-src` sources plus the hashes. With `default-src 'none'`, the created directive is only the hashes. Bascik never adds a source such as `'self'` that you did not write.
- **No `default-src` either: nothing is created.** Without both directives, the browser already runs inline scripts and styles. A directive with only hashes would block your own script files, so Bascik leaves the policy as written. To restrict scripts, write `script-src` or `default-src`.
- **`'unsafe-inline'` means no hashes.** A directive that lists `'unsafe-inline'` gets none, because a hash would turn `'unsafe-inline'` off. This also applies to a missing directive whose `default-src` lists `'unsafe-inline'`.

For example, `default-src 'none'; img-src 'self'` on a page with one inline script and one inline style is sent as `default-src 'none'; img-src 'self'; script-src 'sha256-...'; style-src 'sha256-...'`.

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.example.com"],
      "img-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
    },
    // hashes: { styles: false } hashes scripts only (see Styles below).
    // hashes: false sends the directives exactly as written.
    // reportOnly: true sends Content-Security-Policy-Report-Only instead.
  },
});
```

The hashes always come from the build, never from a response body: a `<script>` a server script reflects from the request gets no hash, so the browser blocks it. Routes with a server or stream script also carry the hashes of every component that can be rendered at request time (see [Server and stream scripts](#server-and-stream-scripts)). Without the option, no header is sent and responses are unchanged.

The config is validated at startup, with the location of each problem: `"script_src" is not a CSP directive. Did you mean "script-src"?`, `write self as 'self' (with single quotes).` (in any directive that takes sources, `script-src-elem` and `style-src-attr` included), a source with a space or `;`, and warnings for `'unsafe-inline'` in `script-src` or `script-src-elem` (every inline script runs, including an injected one), `*` or `https:` in either, and `reportOnly` with no `report-to` or `report-uri`. See [Configuration](/configuration#contentsecuritypolicy).

### Node production server (bascik --server)

Build, start the server, and check the header:

```sh
bascik --build && bascik --server
curl -I http://localhost:8080/
```

The response carries `content-security-policy: default-src 'self'; script-src 'self' https://cdn.example.com 'sha256-...'`. Static pages, pages with server and stream scripts (streamed ones too, since the header comes from the build before the body), `HEAD` requests and `304` responses all get it. The server reads `.bascik/dist/csp-hashes.json` once when it starts.

The hashes describe the pages the build finished with. Once `post` exec scripts settle, the build takes them again from `dist/`, so a `post` script that adds, removes or rewrites an inline `<script>` or `<style>` ships with a header that allows the result. A deploy step that makes the same change to `dist/` after the build makes those blocks fail their hashes. This covers a minifier and an inline analytics snippet, and one dropped semicolon is enough. Browsers block that code, or report it when `reportOnly` is set. The startup warning about changed pages names each one whose inline code is no longer all in `csp-hashes.json`, for example `dist/index.html (1 inline script)`, counting only the kinds your policy restricts with hashes. Move such a step into a `post` exec script, or make the change in the source.

The warning checks inline hashes only. A step that points an external `<script src>` or stylesheet at another host, such as a CDN rewrite or an analytics tag, leaves the hashes as they are, but browsers block the file unless its host is in `script-src` or `style-src`. Add the host to those directives.

### Development server

The same option works on `bascik`: the dev server sends the header with the hashes it recorded as it compiled each page, including the hash of its own live-reload script, so editing under a strict policy works the way production does. Open the browser console to see a violation the moment you add a script the policy does not allow.

### Cloudflare

With `bascik --build --target cloudflare`, the Worker sends the header on every page it renders (pages with server or stream scripts). Static pages are served by Cloudflare's asset layer without the Worker, so the build writes one exact-path rule per static page into the generated `public/_headers`, right after the site-wide [security headers rule](/deployment/cloudflare#security-settings-on-cloudflare) and before your own rules. A page you already have a rule for gets the header in your rule. A `Content-Security-Policy` you set or remove with any rule that matches the page, `/blog/*` or `/*` as well as the exact path, wins there: Bascik writes no rule for that page, so it never sends two policies. Cloudflare reads at most 100 rules from `_headers` and skips any line over 2000 characters; a site whose static pages, own rules and the site-wide rule would need more rules, or a static page with so many inline scripts and styles that its policy line is over 2000 characters, fails the build with a message that names the count or the page. Such a site can send every page through the Worker by setting `"assets": { "run_worker_first": true }` in its Wrangler config: the build keeps that setting, writes no rules, and the Worker sends the header on every page, static ones included (Workers variant only; see [Sending every header from the Worker](/deployment/cloudflare#sending-every-header-from-the-worker)).

Check a deployed preview with `curl -I https://your-preview.pages.dev/`.

### Roll out with reportOnly

Set `reportOnly: true` and a `report-to` or `report-uri` directive to send `Content-Security-Policy-Report-Only`: the browser reports what the policy would block without blocking it. Fix the reports, then remove `reportOnly`.

## Static hosts: put the policy in a meta tag

A `<meta http-equiv="Content-Security-Policy">` tag carries a policy inside the page, so each page can list exactly its own hashes and no host configuration is needed. This works on any static host.

The script below runs after pages are written. It hashes every inline script in each built page and inserts a policy right after `<meta charset>`:

```ts
// bascik.config.ts: run after pages are written, so the hashes match the final script text.
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    exec: [{ script: "scripts/add-csp-meta.mjs", phase: "post" }],
  },
});
```

```js
// scripts/add-csp-meta.mjs: illustrative recipe, adapt it to your site.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.env.BASCIK_OUT_DIR;
if (!outDir)
  throw new Error(
    "BASCIK_OUT_DIR is not set; run this as a pipeline.exec step",
  );

const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi;
// The HTML parser turns CR LF and lone CR into LF before the browser hashes a body.
const hash = (body) =>
  `'sha256-${createHash("sha256")
    .update(body.replace(/\r\n?/g, "\n"), "utf8")
    .digest("base64")}'`;

function policyFor(html) {
  const hashes = new Set();
  const origins = new Set();
  for (const [, attributes, body] of html.matchAll(SCRIPT)) {
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (src) {
      // A file from your own site is covered by 'self'. Another origin must be named.
      if (/^(?:https?:)?\/\//i.test(src))
        origins.add(new URL(src, "https://x.invalid").origin);
    } else if (
      !/\stype\s*=\s*["']?(?:application\/ld\+json|text\/bascik-server)/i.test(
        attributes,
      )
    ) {
      hashes.add(hash(body));
    }
  }
  const sources = ["'self'", ...origins, ...hashes];
  return `script-src ${sources.join(" ")}; object-src 'none'; base-uri 'self'`;
}

for (const entry of await readdir(outDir, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = join(entry.parentPath, entry.name);
  const html = await readFile(file, "utf8");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html)}" />`;
  await writeFile(
    file,
    html.replace(/<meta\s+charset\s*=[^>]*>/i, (charset) => charset + meta),
  );
}
```

The script writes into `BASCIK_OUT_DIR`, never into `src/`, per the [lifecycle output rule](/exec-scripts). It adds only `script-src`, plus `object-src 'none'` and `base-uri 'self'`, which cost nothing and close two common injection routes.

> **Hash the emitted text.** The browser hashes the text between the `<script>` tags as served, after the HTML parser turns each CR LF or lone CR into LF. Bascik hashes that same LF text, so a page saved with Windows line endings gets the same hashes as its LF spelling; the recipe's `hash` does the same. Run the script last, after any other `post` step that edits the pages, or the hashes will not match.

## What a meta tag cannot do

Browsers ignore some directives in a `<meta>` policy: `frame-ancestors`, `sandbox`, and `report-uri`. Send those as a real response header from your host. Policies from the header and the `<meta>` both apply, and the browser enforces the stricter result, so you can split directives between them.

## Third-party scripts

A script loaded from another origin needs that origin in `script-src` (and a stylesheet, in `style-src`). With `contentSecurityPolicy`, list it in `directives`; the meta recipe adds it automatically. Bascik itself allows a script or stylesheet URL on any site, as browsers do, so when such a URL can come from visitor-influenced data, the policy is what stops another origin. A script can also check the URL with `safeUrl(value, { origins })`; see [Loading scripts and styles from other sites](/security#loading-scripts-and-styles-from-other-sites). Some libraries also need `'unsafe-eval'`. Alpine and petite-vue compile directive expressions with `new Function`, so a page that loads them needs `'unsafe-eval'` to work. Add it only for those pages. See [JavaScript Libraries](/libraries).

Scripts injected by your host after the build are not in the emitted HTML, so the recipe cannot discover them. If Cloudflare Web Analytics is enabled, explicitly add `https://static.cloudflareinsights.com` to `sources` in the recipe. The beacon does not need `'unsafe-inline'` or `'unsafe-eval'`. This docs site allows that origin in every page's policy so Cloudflare's injected beacon can run.

## Styles

Inline `<style>` blocks can be hashed the same way with a `style-src` directive. Inline `style="..."` attributes are different: a plain hash does not match them, and once a `style-src` lists any hash, the browser blocks every `style` attribute. The starter pages use a few `style` attributes, and so does the development server's error overlay.

Many sites tighten scripts first, where the risk is highest, and allow inline styles for now. With `contentSecurityPolicy`, list `'unsafe-inline'` in `style-src`; Bascik then adds no style hashes to it, so `style` attributes keep working:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
    },
  },
});
```

`hashes: { scripts: true, styles: false }` does the same without writing `'unsafe-inline'`: script hashes go into `script-src`, and `style-src` stays as you wrote it. To tighten styles later, move `style` attributes into classes, then remove `'unsafe-inline'`.

## Server and stream scripts

The `post` recipe above hashes the built pages, so it never sees what a server or stream script returns per request. Use `csp-hashes.json` for those pages, and keep inline scripts out of the markup your scripts return, or list their hashes yourself.

### Components rendered at request time

A server or stream script can also return component tags, which Bascik renders with their `<style>` block and client scripts at request time (see [Returning component tags](/server-scripts#returning-component-tags)). With `generate.cspHashes: true`, the `csp-hashes.json` entry of every route that has a server or stream script therefore also lists, in its own `styles` and `scripts` arrays, the style hash and first-instance client script hashes of every component that can be rendered at request time. Any component can be returned, so every one of them is listed. The emitted `<style>` text is exactly the hashed text. A targeted `--only` build keeps these entries.

The policy still blocks a `<script>` or `<style>` a visitor manages to write, because its hash is not listed. It cannot block a component tag injected through an escaping bug: that component's client script and stylesheet are listed, so they run, with their usual text, on elements whose props, classes, and inherited attributes the visitor chose. Build script output with `html` from `@bascik/bascik/html`, and write component scripts that treat their own markup as data. See [Security](/security).

Two kinds of component cannot be covered by a hash-only policy when a script returns them, because their bytes change with each instance:

- **Per-instance CSS.** A component whose stylesheet uses `url(#id)`, or any component under `scoping.deduplicateCss: false`, emits CSS that names the instance's ids.
- **Scripts that use scoped ids or names.** A client script that calls `getElementById` on one of the component's own ids, or reads a scoped form field name, has the instance id in its text.

With `generate.cspHashes` on, `bascik --check` lists these under `Components without stable CSP hashes at request time`, and their hashes are not in `csp-hashes.json`. The starter's `<my-counter>` and `<site-header>` are listed, because their scripts use `getElementById`. On pages served under a strict policy, use such components only in page markup, where the build hashes each instance, or change them so their CSS and scripts do not depend on the instance.

To make a script the same in every instance, drop the scoped id and find the element from the event. This is the `<product-card>` script from [Render a card per search result](/server-scripts#render-a-card-per-search-result): one listener on the document serves every card, `closest(".save")` finds the button that was clicked (Bascik rewrites the class to the component's scoped class, which is the same in every instance), and the attribute on `<html>` keeps a second copy of the script from adding a second listener.

```js
// src/components/product-card/product-card.js
// One click listener serves every card on the page. The text is the same in
// every instance (no scoped id), so one CSP hash covers cards a server script
// renders at request time too.
if (!document.documentElement.hasAttribute("data-product-card-save")) {
  document.documentElement.setAttribute("data-product-card-save", "");
  document.addEventListener("click", (event) => {
    const save = event.target.closest(".save");
    if (save === null) return;
    const saved = save.getAttribute("aria-pressed") !== "true";
    save.setAttribute("aria-pressed", String(saved));
    save.textContent = saved ? "Saved" : "Save";
  });
}
```

The button in `product-card.html` has `class="save"` and no `id`. After the change, `bascik --check` no longer lists the component, and its hash is in `csp-hashes.json` for every route with a server or stream script.

## Check that it works

Open the page with the browser console visible. A blocked script logs a Content Security Policy violation that names the directive and shows the hash it expected. To test every page, listen for the event in a browser test:

```js
document.addEventListener("securitypolicyviolation", (event) => {
  console.error(event.violatedDirective, event.blockedURI, event.sample);
});
```

Test the built site, for example with `bascik --server`, because the hashes are computed from the built pages. `curl -I` shows the header the server sends.

> **Next:** [Deployment Overview](/deployment) covers where headers belong on your host, and [Exec Scripts](/exec-scripts) covers the `post` phase.
