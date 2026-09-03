# Micro Sites

Bascik is unusually good at small sites: a landing page, a documentation site for one tool, a conference site, an internal dashboard. Small, static, fast, no framework. This guide covers what a minimal project actually looks like, which features matter at that size, and deployment for a site with no server.

## What a minimal project looks like

A micro site can be a single page. No router, no server, no framework:

<!-- demo:micro-site-index -->
```html
<!-- src/pages/index.html: an entire micro site can be one page. -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Launch Page</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .hero { padding: 4rem 2rem; text-align: center; }
  </style>
</head>
<body>
  <main class="hero">
    <h1>One Page Is Enough</h1>
    <p>A landing page needs no router, no server, and no framework.</p>
    <a href="#signup">Join the list</a>
  </main>
  <section id="signup">
    <form action="https://form-service.example/subscribe" method="post">
      <input type="email" name="email" placeholder="you@example.com" required>
      <button type="submit">Subscribe</button>
    </form>
  </section>
</body>
</html>
```

Run `bascik --build` and the site is done: one HTML file in `dist/`, deployable anywhere that serves files.

The config can even be omitted entirely; defaults are correct for a small site. If you want to trim the generated files, disable them explicitly:

<!-- demo:micro-site-config -->
```ts
// bascik.config.ts: a micro site needs almost nothing.
// Defaults are correct; this file can even be omitted entirely.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  // generate.sitemap and generate.robots default to true; disable them
  // for a single-page site with no SEO surface.
  generate: { sitemap: false, robots: false },
});
```

## Which features matter at this size

- **Components:** even a one-page site benefits from extracting repeated markup. Two pricing cards on a landing page are a component.
- **Scoped styles:** inline `<style>` in the page is fine for one page. The moment a second page appears, paired CSS files and scoping start paying off.
- **Build scripts:** a build script that reads a JSON file of features or pricing keeps content editable without touching markup.
- **Static assets:** images and fonts live in the pages tree and are copied to `dist/` automatically.

## Which features to ignore

- **Dynamic routes:** no blog, no `[slug].html` templates.
- **API routes and the production server:** a micro site with no per-request data needs only `bascik --build` output and a file host.
- **Server scripts:** nothing on the page varies per visitor.
- **Worker pools, caching layers, TLS:** these exist for larger builds and production servers; a micro site will never notice them.

## Deployment for a site with no server

The output of `bascik --build` is a directory of static files. Any static host works: GitHub Pages, Netlify, Cloudflare Pages, S3 plus a CDN, or a single `scp` to a box running nginx. Point the host at `dist/` and set the deploy command to `bascik --build`. There is no server process to run, no runtime to size, and nothing to monitor.

For forms and other tiny dynamic needs, point the form at a hosted service (Formspree, a serverless function, a form endpoint) rather than standing up a Bascik production server for one endpoint. If the site later grows per-request needs, the [Production Server](/server) is there, and the same `dist/` output serves both modes.
