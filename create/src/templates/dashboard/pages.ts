/**
 * The dashboard template's pages and its global stylesheet. Each page is a
 * list of component tags; `src/pages/titles/[slug].html` is the dynamic
 * route that builds one page per title.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const PAGE_FILES: TemplateFile[] = [
  [
    "src/pages/css/styles.css",
    `/* The global stylesheet: design tokens, the app shell's layout, and the styles
   shared by markup that scripts print (tables and charts). Components read the
   tokens with var(--token) and keep their own styles beside their markup. */

:root {
  /* light-dark() picks the first value in light mode and the second in dark mode, following color-scheme. */
  color-scheme: light dark;

  --color-bg: light-dark(#f5f6f8, #111317);
  --color-surface: light-dark(#ffffff, #1a1d23);
  --color-text: light-dark(#1b1d21, #e8e9ec);
  --color-muted: light-dark(#555b67, #a5abb7);
  --color-border: light-dark(#d5d9e0, #343842);
  --color-accent: light-dark(#1f4fc4, #8ab0ff);
  --color-accent-contrast: light-dark(#ffffff, #0b1530);
  --color-up: light-dark(#17693a, #7ddc9f);
  --color-down: light-dark(#b42318, #ff9a8f);
  --color-warn: light-dark(#7a4f00, #f2c66d);

  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --space-5: 2.5rem;

  --radius: 0.5rem;
  --sidebar-width: 14rem;
}

/* Explicit choices from the theme toggle. Without data-theme the operating system setting applies. */
:root[data-theme="light"] {
  color-scheme: light;
}

:root[data-theme="dark"] {
  color-scheme: dark;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

/* ── App shell: the header on top, the sidebar beside the page ── */
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "header header"
    "sidebar main";
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  line-height: 1.5;
}

body > header {
  grid-area: header;
}

body > nav {
  grid-area: sidebar;
}

main {
  grid-area: main;
  display: grid;
  align-content: start;
  gap: var(--space-4);
  padding: var(--space-4);
  max-width: 76rem;
}

/* At phone width the sidebar becomes a row under the header, collapsed behind its Menu button. */
@media (max-width: 47.99rem) {
  body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto 1fr;
    grid-template-areas:
      "header"
      "sidebar"
      "main";
  }

  main {
    padding: var(--space-3);
  }
}

/* ── Base ── */
h1,
h2,
h3 {
  margin: 0;
  line-height: 1.25;
}

h1 {
  font-size: 1.75rem;
}

h2 {
  font-size: 1.15rem;
}

h3 {
  font-size: 1rem;
}

p {
  margin: 0;
}

a {
  color: var(--color-accent);
}

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.lede {
  color: var(--color-muted);
  max-width: 65ch;
}

.card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
}

/* Two cards, one above the other, and side by side when the window has room for both. */
.split {
  display: grid;
  gap: var(--space-4);
  align-items: start;
}

@media (min-width: 72rem) {
  .split {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}

/* Present for screen readers, hidden from view. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.button {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.button:disabled {
  color: var(--color-muted);
  cursor: not-allowed;
}

.button-primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  font-weight: 600;
}

.field {
  padding: var(--space-2) 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: inherit;
  font: inherit;
}

/* ── Tables printed by src/lib/order-table.ts and src/lib/charts.ts ── */
/* A wide table scrolls inside its own box, so the page never scrolls sideways. */
.table-scroll {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

/* A table with many columns keeps a readable width; its .table-scroll box scrolls on a phone. */
.data-table-wide {
  min-width: 44rem;
}

.data-table caption {
  padding-bottom: var(--space-2);
  color: var(--color-muted);
  text-align: start;
}

.data-table th,
.data-table td {
  padding: var(--space-2) 0.75rem;
  border-bottom: 1px solid var(--color-border);
  text-align: start;
  vertical-align: top;
}

.data-table thead th {
  color: var(--color-muted);
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}

.data-table tbody th {
  font-family: var(--font-mono);
  font-weight: 500;
  white-space: nowrap;
}

.data-table .number {
  text-align: end;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.data-table time {
  white-space: nowrap;
}

.data-table .empty-row td {
  padding: var(--space-4) 0.75rem;
  color: var(--color-muted);
  text-align: center;
}

/* ── Charts printed by src/lib/charts.ts ── */
.chart {
  display: block;
  width: 100%;
  height: auto;
}

/* The wide chart keeps a minimum width, so its labels stay readable on a phone: its box scrolls instead. */
.chart-wide {
  min-width: 32rem;
}

.chart-narrow {
  max-width: 30rem;
}

.chart-grid {
  stroke: var(--color-border);
  stroke-width: 1;
}

.chart-text {
  fill: var(--color-muted);
  font-size: 13px;
}

.chart-value {
  fill: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.chart-line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 2.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.chart-area {
  fill: var(--color-accent);
  fill-opacity: 0.14;
}

.chart-point,
.chart-bar {
  fill: var(--color-accent);
}

.chart-track {
  fill: var(--color-border);
  fill-opacity: 0.5;
}

.chart-empty {
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  color: var(--color-muted);
  text-align: center;
}
`,
  ],

  [
    "src/pages/index.html",
    `<!doctype html>
<!--
  The overview. Everything here is built once, at build time, from
  src/lib/shop.ts, except the live orders tile, which a server renders per
  request.

  No authentication: this starter shows demo data to anyone. A real dashboard
  needs it in two places. Put the whole site behind your host's access control
  (the built pages are plain files, so a script cannot guard them), and check
  the session in every server script, stream script, and API route before it
  returns data.
-->
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-build type="text/typescript">
      import { pageTitle } from "@/lib/site.ts";
      export default () => pageTitle("Overview");
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="overview-main">
      <h1>Overview</h1>
      <p class="lede">
        Sales for the last 30 days, compared with the 30 days before. This is
        demo data from <code>src/lib/shop.ts</code>.
      </p>
      <key-figures />
      <div class="split">
        <revenue-chart />
        <top-titles />
      </div>
      <live-orders />
      <recent-orders />
    </main>
  </body>
</html>
`,
  ],

  [
    "src/pages/orders.html",
    `<!doctype html>
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-build type="text/typescript">
      import { pageTitle } from "@/lib/site.ts";
      export default () => pageTitle("Orders");
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="orders-main">
      <h1>Orders</h1>
      <p class="lede">
        Every order of the last 30 days. Select a column heading to sort by it,
        or filter by text and status.
      </p>
      <orders-table />
    </main>
  </body>
</html>
`,
  ],

  [
    "src/pages/titles.html",
    `<!doctype html>
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-build type="text/typescript">
      import { pageTitle } from "@/lib/site.ts";
      export default () => pageTitle("Titles");
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="titles-main">
      <h1>Titles</h1>
      <p class="lede">
        The catalog, with what is in the stockroom. Select a title for its sales
        and orders.
      </p>
      <stock-table />
    </main>
  </body>
</html>
`,
  ],

  [
    "src/pages/titles/[slug].html",
    `<!doctype html>
<!--
  One page per title. The routes script lists the titles, and Bascik builds
  this template once for each: /titles/the-lighthouse-ledger and so on. The
  page of the route being built is in BASCIK_ROUTE.
-->
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-routes type="text/typescript">
      import { TITLES } from "@/lib/shop.ts";
      export default () =>
        TITLES.map((title) => ({ params: { slug: title.slug } }));
    </script>
    <script data-bascik-build type="text/typescript">
      import { titleNamed } from "@/lib/shop.ts";
      import { pageTitle } from "@/lib/site.ts";
      export default () => {
        const route = JSON.parse(process.env.BASCIK_ROUTE || "{}");
        return pageTitle(titleNamed(route.params?.slug).title);
      };
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="title-main">
      <title-detail />
    </main>
  </body>
</html>
`,
  ],

  [
    "src/pages/settings.html",
    `<!doctype html>
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-build type="text/typescript">
      import { pageTitle } from "@/lib/site.ts";
      export default () => pageTitle("Settings");
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="settings-main">
      <h1>Settings</h1>
      <p class="lede">How the shop is named and when it warns about stock.</p>
      <settings-form />
    </main>
  </body>
</html>
`,
  ],

  [
    "src/pages/404.html",
    `<!doctype html>
<html lang="en">
  <head>
    <site-head />
    <script data-bascik-build type="text/typescript">
      import { pageTitle } from "@/lib/site.ts";
      export default () => pageTitle("Page not found");
    </script>
  </head>
  <body>
    <app-header />
    <app-sidebar />
    <main id="main" data-testid="not-found-main">
      <h1>Page not found</h1>
      <p class="lede">
        Nothing is at this address. It may have moved, or the link may be
        mistyped.
      </p>
      <p><a href="/">Back to the overview</a></p>
    </main>
  </body>
</html>
`,
  ],
];
