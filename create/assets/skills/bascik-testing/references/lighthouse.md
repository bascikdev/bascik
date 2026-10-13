# Lighthouse Reference

Bascik ships no framework bundle, hydration, or router, so pages start near 100 in every scored category. What Bascik already does:

- One `<style>` block per component type regardless of instance count (`deduplicateCss`).
- HTML, CSS, and JavaScript minification in `--build`.
- `assets.inlineStyles` inlines a stylesheet into `<head>` to remove a render-blocking request.
- `generate.cspHashes` produces hashes for a strict Content Security Policy.

## Performance

- Responsive images with `srcset` and explicit `width` and `height` to prevent layout shift.
- `loading="lazy"` on below-the-fold images and iframes; never on the hero image.
- `<link rel="preload">` for the hero image, critical fonts, and early stylesheets.
- `<link rel="prefetch">` for likely next navigations; `dns-prefetch` and `preconnect` for critical third-party origins.
- `defer` for scripts that need the DOM, `async` for independent ones such as analytics.
- Stream slow per-request blocks with `data-bascik-stream` and reserve their size to avoid layout shift.

## Accessibility

Landmark elements, `lang` on `<html>`, labeled form controls, a skip link whose target `id` lives on the page shell, sufficient contrast, and native `<details>` and `<dialog>` before custom widgets.

## Best practices

`<!DOCTYPE html>` and an early `<meta charset>` in every page, HTTPS, no console errors, and a CSP header built from `dist/.bascik/csp-hashes.json` applied at the host.

## SEO

Each page needs its own `<title>`, `<meta name="description">`, and canonical URL (a page-aware build script in a shared head component works well). `bascik --build` writes `sitemap.xml` and `robots.txt` when a site URL is set.

## Agentic browsing

Reported as a pass ratio, not a score. Semantic HTML, zero layout shift, and a valid `llms.txt` (author `src/pages/llms.txt` or generate it into `dist/` from an exec script) cover the audits that apply by default. WebMCP audits are experimental.

Category guides: `node <skills-dir>/bascik/scripts/read-doc.mjs /lighthouse/performance` (also `/lighthouse/accessibility`, `/lighthouse/best-practices`, `/lighthouse/seo`, `/lighthouse/agentic-browsing`).
