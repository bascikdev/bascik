# Starter Site

A small, complete Bascik site: shared head, header, and footer components, a light and dark theme, per-page SEO tags, a Markdown blog with tags and an Atom feed, `llms.txt`, a contact form with an API route, and a 404 page. Copy it whole or take the parts you need.

Read about it at https://bascik.dev/examples/starter-site.

```sh
npm install
BASCIK_SITE_URL=https://example.com npx bascik --build
npx bascik --server
```

In this repository the site reads the example components from `../components`. To copy everything into your own project, run `node .agents/skills/bascik/scripts/add-example.mjs starter-site` from your project root.
