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

  --color-bg: light-dark(#f2f5f3, #111816);
  --color-surface: light-dark(#ffffff, #19211e);
  --color-surface-top: var(--color-surface);
  --color-elevated: light-dark(#e9efec, #222c28);
  --color-text: light-dark(#192822, #edf4f0);
  --color-muted: light-dark(#5c6e65, #a9b8b0);
  --color-border: light-dark(#d8e2dc, #34443c);
  --color-accent: light-dark(#28634d, #8bd1ac);
  --color-accent-contrast: light-dark(#ffffff, #13251b);
  --color-accent-wash: light-dark(#e8f1eb, #25382e);
  --surface-panel: none;
  --surface-sheen: none;
  --surface-shadow: none;
  --color-up: light-dark(#176a43, #81d1a2);
  --color-down: light-dark(#aa413d, #f19b8f);
  --color-warn: light-dark(#7a5a18, #e5bf6c);

  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --space-5: 2.5rem;

  --radius: 0.75rem;
  --control-radius: 0.45rem;
  --sidebar-width: 15rem;

  /* The arrow of a select, drawn in --color-text. A data URI cannot read a custom property or light-dark(), so each theme has its own. */
  --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23192822' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 6 4.5 4.5L12.5 6'/%3E%3C/svg%3E");
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23edf4f0' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 6 4.5 4.5L12.5 6'/%3E%3C/svg%3E");
  }
}

/* Explicit choices from the theme toggle. Without data-theme the operating system setting applies. */
:root[data-theme="light"] {
  color-scheme: light;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23edf4f0' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 6 4.5 4.5L12.5 6'/%3E%3C/svg%3E");
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
  min-height: 100dvh;
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
  gap: var(--space-3);
  padding: clamp(1.25rem, 3vw, 2.5rem);
  max-width: 96rem;
  min-width: 0;
  width: 100%;
}

/* At phone width the layout is one column. The sidebar is a row under the header only without JavaScript:
   with it, the header's menu lists the links and the sidebar is not displayed. */
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
    padding: 1.25rem 1rem 2rem;
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
  font-size: clamp(1.55rem, 2.2vw, 2rem);
  letter-spacing: -0.035em;
}

h2 {
  font-size: 1.15rem;
  letter-spacing: -0.015em;
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
  padding: clamp(1rem, 2vw, 1.5rem);
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
  border-radius: var(--control-radius);
  background: var(--color-surface);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.button:disabled {
  color: var(--color-muted);
  cursor: not-allowed;
}

.button:not(:disabled):hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.button-primary:not(:disabled):hover {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
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
  border-radius: var(--control-radius);
  background: var(--color-bg);
  color: inherit;
  font: inherit;
}

/* The browser's own arrow ignores padding and sits against the border, so a select draws one inset to match. */
select.field {
  appearance: none;
  /* Its label is a grid or flex item: without a zero minimum a long option widens the select instead of truncating. */
  min-width: 0;
  max-width: 100%;
  padding-right: 3rem;
  background-image: var(--select-chevron);
  background-repeat: no-repeat;
  background-position: right 1rem center;
  background-size: 1rem;
  text-overflow: ellipsis;
  cursor: pointer;
}

/* Pausing transitions while the theme changes prevents a flash across surfaces. */
.theme-switching *,
.theme-switching *::before,
.theme-switching *::after {
  transition: none !important;
}

@media (prefers-reduced-motion: no-preference) {
  button { transition: transform 150ms ease-out; }
  button:active:not(:disabled) { transform: scale(0.97); }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  button { transition: none; }
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
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.045em;
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
