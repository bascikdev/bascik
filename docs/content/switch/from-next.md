# From Next.js

Next.js and Bascik share file-based routing, but Next.js is a full-stack React framework while Bascik is a build-time HTML assembler. Switching is largely about removing framework abstractions: replace JSX pages with HTML files, replace data-fetching functions with build scripts, and replace special Next.js components with their standard HTML equivalents.

## Pages Router → src/pages/

The Pages Router maps directly to Bascik's `src/pages/` directory. Each `.js` / `.tsx` page file becomes a plain `.html` file at the same relative path.

```text
Before (Next.js Pages Router)    After (Bascik)
pages/                           src/pages/
  index.js                         index.html
  about.js                         about.html
  blog/                            blog/
    index.js                         index.html
    [slug].js                        my-first-post.html
                                     another-post.html
```

> **No dynamic segments:** Bascik has no equivalent of `[slug].js`. Each URL needs its own `.html` file. For many programmatically generated pages, write a Node.js script that creates the files before running `bascik --build`.

## App Router Layouts → Shared Layout Components

Next.js App Router uses `layout.tsx` files to wrap pages in shared UI. In Bascik, the `<html>`, `<head>`, and `<body>` tags live in each page file. Repeated structure goes into components.

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

If many pages share the same outer shell, extract it into a layout component that accepts a default slot for the page-specific content:

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

> **Head components:** Components work inside `<head>` too. Create a `<site-meta>` component for shared meta tags and viewport declarations, then include it on every page.

## getStaticProps → Build Scripts or Inline HTML

`getStaticProps` fetches or reads data at build time and injects it as props. In Bascik, use a `<script data-bascik-build>` block. The script runs as a Node.js ESM module at build time; its stdout is injected into the page in place of the tag. Top-level `import` and top-level `await` are supported.

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

## getStaticPaths → One File Per Route

`getStaticPaths` tells Next.js which dynamic URLs to pre-render. In Bascik there are no dynamic segments, each URL is a separate `.html` file. Generate them in a script that runs before `bascik --build`.

```json
{
  "scripts": {
    "generate": "node scripts/generate-pages.js",
    "build": "npm run generate && bascik --build"
  }
}
```

```js
// scripts/generate-pages.js
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { marked } from 'marked';

const posts = await readdir('./content/posts');
await mkdir('./src/pages/blog', { recursive: true });

// Read the HTML template
const template = await readFile('./scripts/blog-template.html', 'utf8');

for (const file of posts.filter(f => f.endsWith('.md'))) {
  const slug = file.replace('.md', '');
  const md = await readFile(`./content/posts/${file}`, 'utf8');
  const body = marked(md);
  
  // Replace placeholders in the template
  const html = template
    .replaceAll('{{title}}', `${slug} - Blog`)
    .replaceAll('{{body}}', body);

  await writeFile(`./src/pages/blog/${slug}.html`, html);
}
```

## next/image → Standard img

Replace `<Image>` from `next/image` with a standard `<img>` tag. Add `width`, `height`, and `loading="lazy"` manually where you want lazy loading. Images in `src/pages/img/` are copied to `dist/` automatically.

```jsx
// Before (Next.js)
<Image src="/hero.jpg" alt="Hero" width={1200} height={600} priority />
```

```html
<!-- After (Bascik) -->
<img src="/img/hero.jpg" alt="Hero" width="1200" height="600" />
```

## next/link → Standard a

Replace `<Link href="...">` with a standard `<a href="...">`. There is no client-side navigation in Bascik, every link triggers a full page load, which is standard browser behavior for static sites.

## next/head → Inline head Tags

Replace the `<Head>` component from `next/head` with regular `<title>` and `<meta>` tags in each page's `<head>` element.

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

Handlers run in-process on the production server (`bascik --server`) or during local dev (`bascik`). For purely static hosting deployments, handlers can also be lifted directly to Cloudflare Workers, Fastly Compute, Netlify Edge Functions, or AWS Lambda without rewriting because they use standard web APIs.

## CSS Modules → Paired .css Files

Delete the `.module.css` file and create a plain `.css` file alongside the component HTML. Change `className={styles.foo}` to `class="foo"`. Bascik scopes class names at build time, no Webpack or PostCSS configuration required.

## TypeScript → Not Needed

Bascik component files are vanilla HTML. Type annotations are not applicable. If you have TypeScript utility scripts or content-generation scripts you want to keep, continue using TypeScript there, just not in Bascik component or page HTML files.
