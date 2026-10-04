# From Next.js

Next.js and Bascik share intuitive file-based routing, but they serve different architectural goals. Next.js is a full-stack React framework offering server-side rendering, React Server Components (RSC), client-side hydration, and virtual DOM reconciliation. Bascik is a build-time HTML assembler and server that outputs standard vanilla HTML, CSS, and JavaScript with zero client runtime.

Switching to Bascik replaces framework abstractions with standard web platform primitives: JSX components become vanilla HTML files, data-fetching functions become build scripts or server scripts, and specialized Next.js components become standard HTML tags.

For a complete worked example, see the [Next.js Blog Tutorial](/switch/next-blog-tutorial), a port of the official `blog-starter` example. Its home and post pages ship two short inline scripts for the color scheme switch; the original ships about 590 kB of framework JavaScript.

## A Low-Risk First Step

To evaluate Bascik on an existing Next.js codebase, migrate a single static marketing page (like an `/about` page) and a shared header component before touching complex application routes:

1. Create a project with `npm create bascik@latest`.
2. Create `src/components/site-nav/site-nav.html` from your Next.js navigation component.
3. Create `src/pages/about.html` containing your page structure and `<site-nav></site-nav>`.
4. Run `npm run dev` to view your rendered page.

## Pages Router vs Bascik Routing

The Next.js Pages Router maps cleanly to Bascik's `src/pages/` directory. Each `.js` / `.tsx` page file becomes a plain `.html` file at the same relative path:

```text
Before (Next.js Pages Router)    After (Bascik)
pages/                           src/pages/
  index.js                         index.html
  about.js                         about.html
  blog/                            blog/
    index.js                         index.html
    [slug].js                        [slug].html
```

### Dynamic Routes: [slug].html Templates

In Next.js, `pages/blog/[slug].js` uses `getStaticPaths` (Pages Router) and `app/blog/[slug]/page.tsx` uses `generateStaticParams` (App Router) to define dynamic routes. In Bascik, you create a dynamic route template file like `src/pages/blog/[slug].html` with a `<script data-bascik-routes>` block that prints the list of routes to generate at build time (see [Dynamic Routes](/dynamic-routes)).

A template is a full page, like every file in `src/pages/`: it needs `<html>`, `<head>`, and a non-empty `<body>`. The routes script can sit in the `<head>`. The template below writes `dist/blog/<slug>.html`, served at `/blog/<slug>`; use `src/pages/blog/[slug]/index.html` instead for `/blog/<slug>/` URLs.

```html
<!-- src/pages/blog/[slug].html -->
<!doctype html>
<html lang="en">
<head>
  <script data-bascik-routes>
    import { readdir } from 'node:fs/promises';
    const files = await readdir('./content/posts');
    const routes = files
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({ params: { slug: file.replace(/\.md$/, '') } }));
    console.log(JSON.stringify(routes));
  </script>
  <title>Blog</title>
</head>
<body>
  <article>
    <script data-bascik-build>
      import { readFile } from 'node:fs/promises';
      import { marked } from 'marked';
      const { params } = JSON.parse(process.env.BASCIK_ROUTE);
      const md = await readFile(`./content/posts/${params.slug}.md`, 'utf8');
      console.log(marked(md));
    </script>
  </article>
</body>
</html>
```

`marked` is not part of a new project: install it with `npm install marked`. A script that reads `content/` cannot be cached by its imports, so add the template to `scripts.cache.exclude` and `content/` to `pipeline.watchPaths` (see [Build Scripts](/build-scripts)). An unknown slug gets the site's 404 page.

## App Router Layouts → Shared Layout Components

Next.js App Router uses `layout.tsx` files to wrap nested pages in shared UI. In Bascik, the `<html>`, `<head>`, and `<body>` tags live in each page file, and repeated layout structure lives in components with slots.

```jsx
// app/layout.tsx (Next.js - before)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
```

```html
<!-- src/pages/about.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>About - Acme</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <site-nav></site-nav>
  <main>
    <h1>About</h1>
    <p>We build things.</p>
  </main>
  <site-footer></site-footer>
</body>
</html>
```

If many pages share the same outer wrapper, extract it into a layout component that accepts a default slot for the page content:

```html
<!-- src/components/site-layout/site-layout.html -->
<site-nav></site-nav>
<main class="content">
  <div data-bascik-slot></div>
</main>
<site-footer></site-footer>
```

```html
<!-- src/pages/about.html (using the layout component) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <title>About - Acme</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <site-layout>
    <h1>About</h1>
    <p>We build things.</p>
  </site-layout>
</body>
</html>
```

## Server Components and getStaticProps → Build Scripts

`getStaticProps` (Pages Router) and an async server component (App Router) fetch data at build time. In Bascik, use a `<script data-bascik-build>` block. The script runs as a Node.js ESM module at build time; its stdout is injected into the page in place of the tag. Top-level `import` and top-level `await` are natively supported.

A build script prints strings, not JSX, so escape every value you interpolate. The example below does not, which is fine only because it is illustrative; see [Escaping](#escaping-and-shared-helpers).

```jsx
// pages/products.js (Next.js - before)
export async function getStaticProps() {
  const res = await fetch('https://api.example.com/products');
  const products = await res.json();
  return { props: { products } };
}

export default function Products({ products }) {
  return (
    <ul>
      {products.map(p => (
        <li key={p.id}>{p.name} - ${p.price}</li>
      ))}
    </ul>
  );
}
```

```html
<!-- src/pages/products.html (Bascik - after) -->
<ul>
  <script data-bascik-build>
    const res = await fetch('https://api.example.com/products');
    const products = await res.json();
    const items = products
      .map(p => `<li>${p.name} - $${p.price}</li>`)
      .join('\n');
    console.log(items);
  </script>
</ul>
```

### Escaping and Shared Helpers

Move the code that turns data into markup into `src/lib/*.ts` helpers that return strings, and import them with the `@/` alias from any page. Two rules differ from Next.js:

- **`@/` works only in the script tag.** Bascik resolves `@/lib/x.ts` inside `<script data-bascik-build>`. A helper file is run by Node as-is, so tsconfig `paths` do not apply there: a helper that imports another helper uses a relative path with its extension (`./site.ts`), and a type-only import must be `import type`.
- **Escape every value.** JSX escapes text for you; a template string does not. Write one `escapeHtml` helper and call it on every interpolated value, including attribute values.

```ts
// src/lib/render.ts (illustrative)
import type { Post } from '../interfaces/post.ts';
import { escapeHtml as e } from './site.ts';

export function renderPreview(post: Post): string {
  return `<h3><a href="/posts/${e(post.slug)}">${e(post.title)}</a></h3>`;
}
```

## Metadata → Head Build Scripts

`export const metadata` and `generateMetadata` become a build script in the page `<head>` that prints `<title>` and `<meta>` tags. For absolute Open Graph URLs, read `BASCIK_SITE_URL` (set with `--site-url`, the environment, or `.env`). Fail the build when it is missing rather than falling back: Next.js falls back to `http://localhost:3000` with a warning when `metadataBase` is unset, which ships social URLs that point at a developer machine.

```html
<head>
  <site-head></site-head>
  <script data-bascik-build>
    import { renderHead } from '@/lib/site.ts';
    console.log(renderHead({ title: 'About - Acme' }));
  </script>
</head>
```

A dynamic route reads the same `BASCIK_ROUTE` in its head script as in its body.

## next/image → Standard img

Replace `<Image>` from `next/image` with a standard `<img>` tag. Add `width`, `height`, and `loading="lazy"` attributes where appropriate. Files under `src/pages/` that are not pages or source code (images, fonts, `.webmanifest`, and similar) are copied to `dist/` at the same path, so `src/pages/assets/hero.jpg` is served at `/assets/hero.jpg`. Bascik has no `public/` directory, and it does not resize images or generate `srcset`.

```jsx
// Before (Next.js)
<Image src="/hero.jpg" alt="Hero" width={1200} height={600} priority />
```

```html
<!-- After (Bascik) -->
<img src="/img/hero.jpg" alt="Hero" width="1200" height="600" />
```

## next/link → Standard a

Replace `<Link href="...">` with a standard `<a href="...">`. Because Bascik sites do not require a heavy client router, navigation uses standard browser page requests.

## next/font → @font-face

`next/font` downloads a font, self-hosts it, and adds a preload. Do the same by hand: put the `.woff2` file and its license under `src/pages/assets/fonts/`, declare it with `@font-face` in your global stylesheet, and add `<link rel="preload" as="font" type="font/woff2" crossorigin>` to the head. Bascik does not generate fallback-metric adjustments.

## Client Components → Component Scripts

A `"use client"` component becomes a Bascik component with a plain `<script>`. There is no hydration: the HTML is final, and the script attaches behavior. `useState` becomes a variable or a DOM attribute, and `useEffect` becomes code that runs once when the script runs. Use `getElementById` for the component's own elements, because Bascik rewrites those ids per instance.

A script that must run before the page paints (for example, applying a saved color scheme) goes in `<head>`. Production HTML minification moves scripts in the body to the end of the body, but leaves head scripts where they are. The [tutorial](/switch/next-blog-tutorial#the-color-scheme-switch) splits the example's theme switcher this way.

## next/head → Inline head Tags

Replace the `<Head>` component from `next/head` with regular `<title>` and `<meta>` tags in each page's `<head>` element:

```jsx
// pages/about.js (Next.js - before)
import Head from 'next/head';

export default function About() {
  return (
    <>
      <Head>
        <title>About - Acme</title>
        <meta name="description" content="About Acme Corp." />
      </Head>
      <h1>About</h1>
    </>
  );
}
```

```html
<!-- src/pages/about.html (Bascik - after) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>About - Acme</title>
  <meta name="description" content="About Acme Corp." />
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <site-nav></site-nav>
  <h1>About</h1>
  <site-footer></site-footer>
</body>
</html>
```

## API Routes → src/api/

Next.js App Router route handlers (`app/api/.../route.ts`) map directly to Bascik API routes in `src/api/`. Both frameworks use standard WHATWG `Request` and `Response` interfaces:

```text
Before (Next.js App Router)       After (Bascik)
app/api/contact/route.ts          src/api/contact.ts
app/api/users/[id]/route.ts       src/api/users/[id].ts
```

```ts
// src/api/contact.ts (Bascik)
export const POST = async (request: Request): Promise<Response> => {
  const data = await request.json();
  return Response.json({ received: data }, { status: 201 });
};
```

The second argument differs. In Next.js 15 and later, `params` is a promise you `await`; in Bascik it is a plain object, `context.params.id`. Code that awaits it still works, because awaiting a plain object returns the object.

Handlers run in-process on the production server (`bascik --server`) or during local dev (`bascik`). A static build (`bascik --build`) cannot serve them and prints a warning; see [Static Builds vs Production Server](/api-routes#static-builds-vs-production-server) and [Deployment](/deployment#serverless-hosting) for the supported serverless targets.

## CSS Modules & Tailwind CSS

- **CSS Modules:** Create a plain `.css` file alongside the component HTML (e.g. `src/components/card/card.css`). Replace `className={styles.foo}` with `class="foo"`. Bascik scopes class names at build time without requiring PostCSS or Webpack configuration. A rule such as `.markdown h2` matches only `h2` elements written in the component's template; to style HTML passed through a slot, such as rendered Markdown, write `.markdown :is(h2)`.
- **Tailwind CSS:** Keep your Tailwind classes and run Tailwind as a `pipeline.exec` script with `phase: 'pre'` that writes the stylesheet into `BASCIK_OUT_DIR`, then link it from the head. Point Tailwind's `content` at `src/**/*.html` and at any `src/lib` helpers that return markup. Bascik leaves a class unscoped when the component's own stylesheet does not define it, so Tailwind utilities and a `dark` class toggled on `<html>` keep matching without `scoping.attributes.class: false`. `@apply` in a component's `.css` file is not processed, because Bascik does not run Tailwind on component stylesheets; write the CSS out or keep `@apply` in the Tailwind input file. See [Libraries](/libraries#tailwind-css) for the CDN option.

## TypeScript in Bascik

Bascik component files are vanilla HTML. If you have TypeScript helper functions, data fetchers, or API routes, you can keep them in `.ts` files and import them directly into build scripts, server scripts, or API routes.
