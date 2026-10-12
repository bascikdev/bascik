# Best Practices

Lighthouse's Best Practices category checks that a page is built on a secure, modern, and error-free foundation. Most of the audits are about the document shell and the network, not about your component code, which is why a Bascik site passes nearly all of them from the first build. A few depend on how you deploy.

## The Document Shell

Two audits check that the browser can interpret the page correctly. Bascik does not alter either, so keep them in every page and layout you write.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Title - Site Name</title>
</head>
```

- **Doctype.** A page without `<!DOCTYPE html>` renders in quirks mode, which changes layout and box-model behavior.
- **Charset.** Declare `<meta charset="UTF-8" />` within the first 1024 bytes of the document, before any `<title>` or scripts, so the browser does not re-parse the page after guessing the encoding.

## HTTPS

Lighthouse flags any page served over plain HTTP and any HTTP URL that does not redirect to HTTPS, and every request made by the page, including images, scripts, and fonts, must also use HTTPS.

In production, HTTPS is usually terminated by your host or CDN, which also handles redirects from HTTP. When you run Bascik's own server, set `http.tls` to serve HTTPS with HTTP/2, and set `http.trustProxy` when the server sits behind a proxy that terminates TLS. See [Production Server](/production-server#http2-tls-support) for the options.

Use root-relative URLs (`/images/hero.jpg`) or `https://` URLs for assets. A hardcoded `http://` URL is mixed content and fails the audit.

## Images at the Right Size and Ratio

Two audits compare an image's natural size to the size it is displayed at:

- **Aspect ratio.** The `width` and `height` attributes must match the real ratio of the file. A 4:3 photo marked `width="800" height="800"` is flagged as distorted.
- **Resolution.** An image that is much larger than its rendered size wastes bytes, and one that is much smaller looks blurry on high-density screens. Serve candidates with `srcset` and `sizes`.

See [Responsive Images with `srcset`](/lighthouse/performance#responsive-images-with-srcset) and [Image CDN](/lighthouse/performance#image-cdn-one-source-infinite-sizes) for the patterns.

## A Clean Console

Lighthouse reports errors logged to the browser console and uses of deprecated browser APIs. Both are signs that something on the page is broken or about to break.

- Open the browser console on every page type, not just the home page. A missing image, a failed `fetch`, or a typo in a component script shows up as a console error.
- Fix 404s for favicons and other assets referenced from your head. A missing `/favicon.ico` is a common source of console noise.
- Replace deprecated APIs when the audit names them. Lighthouse links to the replacement in each result.

## Ask for Permissions on a User Gesture

Pages that request geolocation or notification permission on load fail their audits and train users to dismiss the prompt. Call `navigator.geolocation` or `Notification.requestPermission()` from a click handler after the user asks for the feature, never at startup.

## Trust and Safety Headers

Lighthouse also checks response headers that protect users from cross-site attacks: a Content Security Policy, HTTP Strict Transport Security (HSTS), cross-origin opener isolation, and clickjacking protection. These headers belong to your host or CDN edge, not to the page, so configure them where you deploy.

For a Content Security Policy that does not rely on `'unsafe-inline'`, Bascik can produce the hashes for you. Component `<style>` blocks and wrapped component `<script>` blocks are inlined, so a strict policy needs their exact SHA-256 hashes. Set `generate.cspHashes: true`:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  generate: {
    cspHashes: true,
  },
});
```

The build writes `dist/.bascik/csp-hashes.json`, mapping each page to the hashes of its inline scripts and styles. A post-build script can turn that file into `script-src` and `style-src` directives for your host. See [Deployment Overview](/deployment) for a complete example, and the [FAQ](/faq) for why Bascik emits hashes instead of setting the header itself.

> **Treat the header audits as informational.** They report what your host sends, so a perfect score may require platform-specific configuration. Check them against the production URL, not `localhost`.
