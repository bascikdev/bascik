# Next.js blog-starter, ported to Bascik

A hand port of the official Next.js `blog-starter` example (`vercel/next.js`,
`examples/blog-starter/`, commit `ba80ee4`, built with Next.js 16.3.6) to Bascik. It exists to
check specific migration claims, not to be a starter template. Code is adapted under the upstream
MIT license (see `NOTICE.md`). Posts, images, and icons are original. The font is Inter under the
SIL OFL 1.1.

The worked tutorial is at `/switch/next-blog-tutorial` in the Bascik docs.

## Run it

```sh
npm ci --ignore-scripts
npm run dev      # development server
npm run build    # writes dist/
npm run serve    # production server over dist/
```

The scripts pass `--site-url https://example.com` because Open Graph URLs and the feed need an
absolute origin. Replace it with your own. Dates are formatted at build time in the machine's time
zone, like the original; set `TZ` if they must not depend on the machine.

## Mapping from the original

| Original | Port |
| --- | --- |
| `src/app/layout.tsx` | Document shell in each page, `site-head`, `theme-init`, `theme-switcher`, `site-footer` |
| `src/app/page.tsx` | `src/pages/index.html` |
| `src/app/posts/[slug]/page.tsx` | `src/pages/posts/[slug].html` (`generateStaticParams` is the routes script, `generateMetadata` is the head build script) |
| `_components/hero-post`, `more-stories`, `post-preview`, `cover-image`, `post-header` | Functions in `src/lib/render.ts` that return escaped HTML |
| `_components/avatar`, `date-formatter`, `container`, `header`, `intro`, `alert`, `footer` | Components with text props or slots |
| `_components/post-body` + `markdown-styles.module.css` | `post-body` (default slot) + `post-body.css` |
| `_components/theme-switcher` + `switch.module.css` | `theme-init` (head script) + `theme-switcher` (button) + `theme-switcher.css` |
| `src/lib/api.ts`, `markdownToHtml.ts` | Same files; relative imports with `.ts`, `.md` filter, `zod` validation |
| `postcss.config.js` + `globals.css` | `scripts/build-css.ts` (`pre` exec step) + `src/css/globals.css` |
| `next/font/google` (Inter) | Self-hosted `.woff2`, `@font-face`, and a preload link |
| `public/` | `src/pages/assets/`, `src/pages/favicon/` |
| Not generated (`/feed.xml` link is a 404) | `scripts/generate-feed.ts` (`post` exec step) |
| Not generated | Built-in `sitemap.xml` and `robots.txt` |

## Deliberate differences

- No client router, prefetching, or React runtime. Two inline scripts run the color scheme switch.
- No image optimization. Covers are served as authored with `width` and `height` set.
- No font fallback metrics.
- `/posts/x/` serves the page instead of redirecting to `/posts/x`. An unknown slug is a 404
  (the original answers 500).
- Social URLs use the configured site URL. The original has no `metadataBase` and writes
  `http://localhost:<port>`.
- Preview mode (the alert's preview branch and `/api/exit-preview`) is not ported. No post uses it
  and the route does not exist in the example.
- The switch button has an `aria-label` and a visible focus ring. The original has neither.

## Bascik behavior

The port exercises scoped keyframe stops, minified descendant selectors, and HTML comments in
development component templates. Use a package build that includes those behaviors when testing
changes to the port.
