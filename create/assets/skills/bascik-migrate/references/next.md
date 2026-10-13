# From Next.js

Full guide: `read-doc.mjs /switch/from-next`.

| Next.js | Bascik |
|---|---|
| `app/page.tsx`, `app/posts/[slug]/page.tsx` | `src/pages/index.html`, `src/pages/posts/[slug].html` (`/posts/<slug>`, also served with a trailing slash) |
| `generateStaticParams` | `<script data-bascik-routes>` returning `[{ params: { slug: '...' } }]` |
| `generateMetadata` / `metadata` export | A build script in `<head>` returning `<title>` and `<meta>` from a `src/lib` helper; absolute URLs from `BASCIK_SITE_URL` |
| `app/layout.tsx` | Pages keep `<html>`/`<head>`/`<body>`; a head component plus header and footer components |
| Server component mapping data to JSX | A `src/lib` helper returning escaped HTML strings, returned by a build script |
| `"use client"` component with `useState`/`useEffect` | A component with a plain `<script>`; persistent state lives in the DOM or `localStorage` |
| `next/link`, `next/image`, `next/font` | `<a>`, `<img>` with `width`/`height`, self-hosted `@font-face` plus `<link rel="preload">` |
| CSS Modules (`styles.x`) | Companion component `.css`; a class written in the template is scoped |
| Tailwind via PostCSS | A `pipeline.exec` `pre` script running PostCSS and Tailwind into `BASCIK_OUT_DIR`; Tailwind `content` lists `src/**/*.html` and `src/lib/**/*.ts` |
| `app/api/x/route.ts` | `src/api/x.ts` exporting `GET`/`POST`; `context.params` is a plain object, not a promise; `bascik --server` only |

Gotchas:

- `@/` in a helper that imports another helper fails. tsconfig `paths` do not apply because Node runs `src/lib/*.ts` directly. Inside helpers, use relative paths with the `.ts` extension, and `import type` for type-only imports.
- Tailwind `@apply` in component CSS is not processed. Write the CSS out, or keep `@apply` in the global Tailwind input file.
- Tailwind's `dark` class works unscoped when it is toggled on `<html>` and the component's own CSS does not define it.
- A pre-paint script (theme, flash of unstyled content) goes in `<head>`. Production HTML minification moves body scripts to the end of the body; head scripts stay.
- Style slotted Markdown with `.wrapper :is(h2)`, not `.wrapper h2`.
- Unknown slugs return 404.
