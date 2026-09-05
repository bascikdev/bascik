# From Next.js

Next.js and Bascik share intuitive file-based routing, but they serve different architectural goals. Next.js is a full-stack React framework offering server-side rendering, React Server Components (RSC), client-side hydration, and virtual DOM reconciliation. Bascik is a build-time HTML assembler and server that outputs standard vanilla HTML, CSS, and JavaScript with zero client runtime.

Switching to Bascik replaces framework abstractions with standard web platform primitives: JSX components become vanilla HTML files, data-fetching functions become build scripts or server scripts, and specialized Next.js components become standard HTML tags.

## A Low-Risk First Step

To evaluate Bascik on an existing Next.js codebase, migrate a single static marketing page (like an `/about` page) and a shared header component before touching complex application routes:

1. Create `src/components/site-nav/site-nav.html` from your Next.js navigation component.
2. Create `src/pages/about.html` containing your page structure and `<site-nav></site-nav>`.
3. Run `yarn dev` to view your rendered zero-JS page.

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

In Next.js, `pages/blog/[slug].js` uses `getStaticPaths` to define dynamic routes. In Bascik, you create a dynamic route template file like `src/pages/blog/[slug].html` with a `<script data-bascik-build>` block that returns the list of slugs to generate at build time (see [Dynamic Routes](/dynamic-routes)).

```html
<!-- src/pages/blog/[slug].html -->
<script data-bascik-build>
  import { readdir } from 'node:fs/promises';
  const files = await readdir('./content/posts');
  const slugs = files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
  // Returns array of route params for static page generation
  return slugs.map(slug => ({ slug }));
</script>

<article>
  <script data-bascik-build>
    import { readFile } from 'node:fs/promises';
    import { marked } from 'marked';
    const md = await readFile(`./content/posts/${context.params.slug}.md`, 'utf8');
    console.log(marked(md));
  </script>
</article>
```

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

## getStaticProps → Build Scripts

`getStaticProps` fetches data at build time and passes it as props. In Bascik, use a `<script data-bascik-build>` block. The script runs as a Node.js ESM module at build time; its stdout is injected into the page in place of the tag. Top-level `import` and top-level `await` are natively supported.

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

## next/image → Standard img

Replace `<Image>` from `next/image` with a standard `<img>` tag. Add `width`, `height`, and `loading="lazy"` attributes where appropriate. Static assets in `src/pages/img/` or `src/public/` are copied to `dist/` automatically.

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

Handlers run in-process on the production server (`bascik --server`) or during local dev (`bascik`). For serverless edge deployments, handlers use standard web fetch interfaces.

## CSS Modules & Tailwind CSS

- **CSS Modules:** Create a plain `.css` file alongside the component HTML (e.g. `src/components/card/card.css`). Replace `className={styles.foo}` with `class="foo"`. Bascik scopes class names at build time without requiring PostCSS or Webpack configuration.
- **Tailwind CSS:** If your Next.js project uses Tailwind, you can keep your Tailwind classes and run Tailwind via PostCSS as documented in [Libraries](/libraries#tailwind-css).

## TypeScript in Bascik

Bascik component files are vanilla HTML. If you have TypeScript helper functions, data fetchers, or API routes, you can keep them in `.ts` files and import them directly into build scripts, server scripts, or API routes.
