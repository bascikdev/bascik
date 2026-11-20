/**
 * The docs template's components, pages, global CSS and Playwright spec.
 * The shared pieces come from the default template in `scaffold.ts`.
 */

import {
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  SITE_META_HTML,
  STYLES_CSS,
  type Adapter,
} from "../../scaffold.js";

// ─── Global CSS ───────────────────────────────────────────────────────────────

/**
 * The docs site's own design system, three-column layout, and rendered
 * Markdown styles. Markdown arrives as build output and is styled under
 * `.prose`.
 */
export const DOCS_STYLES_CSS = `${STYLES_CSS}
.container { max-width: 1440px; }

:root {
  --bg: light-dark(#fff, #111317);
  --surface: light-dark(#fff, #191c21);
  --surface-top: light-dark(#fff, #20242a);
  --elevated: light-dark(#f5f6f8, #22262d);
  --border: light-dark(#e2e5e9, #343941);
  --border-hover: light-dark(#bdc6d6, #596274);
  --accent: light-dark(#315bd6, #a9bcff);
  --accent-hover: light-dark(#2449bb, #c0ceff);
  --accent-dim: light-dark(#eef2ff, #202a40);
  --on-accent: light-dark(#fff, #151b2a);
  --text: light-dark(#20242a, #edf0f5);
  --text-muted: light-dark(#626974, #a9b0bb);
  --panel: none;
  --sheen: none;
  --shadow: none;
  --r: 10px;
  --r-sm: 6px;
}

body { background: var(--surface); line-height: 1.65; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
header { background: var(--surface); }
nav a, .logo { text-decoration: none; }

/* ── Docs layout ── */
.docs-layout {
  flex: 1;
  width: 100%;
  display: grid;
  grid-template-columns: minmax(180px, 220px) minmax(0, 760px) minmax(160px, 220px);
  justify-content: center;
  gap: clamp(24px, 3vw, 48px);
  align-items: start;
  padding-top: 36px;
  padding-bottom: 88px;
}
.docs-layout > main#main {
  min-width: 0;
  padding: 0 clamp(12px, 2vw, 28px);
}

@media (max-width: 1100px) {
  .docs-layout { grid-template-columns: minmax(180px, 220px) minmax(0, 760px); }
  .docs-layout > aside { display: none; }
}

@media (max-width: 760px) {
  .docs-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; padding-top: 18px; padding-bottom: 56px; }
  .docs-layout > main#main { padding: 16px 0; }
}

/* ── Rendered Markdown ── */
.title { font-size: clamp(2.2rem, 4vw, 3rem); line-height: 1.1; letter-spacing: -0.05em; margin-bottom: 14px; }
.lead { font-size: 1.1rem; max-width: 68ch; margin-bottom: 40px; }
.prose { max-width: 74ch; line-height: 1.75; }
.prose h2, .prose h3, .prose h4 { scroll-margin-top: 96px; color: var(--text); }
.prose h2 { font-size: 1.45rem; margin: 48px 0 14px; padding-top: 18px; border-top: 1px solid var(--border); }
.prose h3 { font-size: 1.12rem; margin: 30px 0 10px; }
.prose h4 { font-size: 1rem; margin: 24px 0 8px; }
.prose p, .prose ul, .prose ol, .prose pre, .prose table, .prose blockquote { margin: 0 0 20px; }
.prose ul, .prose ol { padding-left: 24px; color: var(--text-muted); }
.prose li + li { margin-top: 6px; }
.prose strong { color: var(--text); }
.prose :not(pre) > code { font-size: .88em; }
.prose pre {
  background: var(--elevated); border: 1px solid var(--border);
  border-radius: var(--r); padding: 18px 20px; overflow-x: auto;
}
.prose pre code {
  background: none; border: none; padding: 0;
  color: var(--text); font-size: 0.86rem; line-height: 1.7;
}
.prose table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.92rem; }
.prose th, .prose td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.prose th { color: var(--text); font-weight: 600; }
.prose td { color: var(--text-muted); }
.prose blockquote {
  margin-inline: 0; padding: 4px 0 4px 18px;
  border-inline-start: 2px solid var(--accent);
}
.prose blockquote p { color: var(--text); margin: 0; }

@media (prefers-reduced-motion: no-preference) {
  .docs-layout a { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
}
`;

// ─── Components ───────────────────────────────────────────────────────────────

/**
 * The default template's head tags without its site-wide description: every
 * page of this template prints its own with `pageHead()`.
 */
export const DOCS_SITE_META_HTML =
  SITE_META_HTML.split("\n")
    .filter(
      (line) =>
        !line.includes('name="description"') &&
        !line.includes('rel="stylesheet"'),
    )
    .join("\n") +
  `<script type="text/typescript">
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {}
</script>
`;

/** Icon-only, progressively enhanced control. Its accessible name stays stable. */
export const DOCS_THEME_TOGGLE_HTML = `<style>
.button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; flex-shrink: 0;
  padding: 10px; border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface); color: var(--text); cursor: pointer;
}
.button[hidden] { display: none; }
.button:hover { background: var(--elevated); }
.icon { width: 20px; height: 20px; }
.sun { display: none; }
.button[aria-pressed="true"] .moon { display: none; }
.button[aria-pressed="true"] .sun { display: block; }
</style>
<button id="theme" class="button" type="button" aria-label="Toggle dark mode" aria-pressed="false" data-testid="theme-toggle" hidden>
  <svg class="icon moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.8 13.2A9 9 0 0 1 10.8 3.2a9 9 0 1 0 10 10Z" /></svg>
  <svg class="icon sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
</button>
<script type="text/typescript">
  const button = document.getElementById("theme") as HTMLButtonElement;
  const root = document.documentElement;
  const preference = matchMedia("(prefers-color-scheme: dark)");
  const sync = (): void => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : preference.matches;
    button.setAttribute("aria-pressed", String(dark));
  };
  sync();
  button.hidden = false;
  preference.addEventListener("change", sync);
  button.addEventListener("click", () => {
    root.classList.add("theme-switching");
    const theme = button.getAttribute("aria-pressed") === "true" ? "light" : "dark";
    root.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch {}
    sync();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  });
</script>
`;

export const DOCS_THEME_TOGGLE_TEST = `import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
describe("theme-toggle", () => {
  it("provides a labeled icon button and preserves the selected theme", async () => {
    const html = await readFile("src/components/theme-toggle/theme-toggle.html", "utf8");
    expect(html).toContain('aria-label="Toggle dark mode"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('localStorage.setItem("theme", theme)');
  });
});
`;

export const DOCS_SITE_META_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-meta component', () => {
  const path = join(process.cwd(), 'src/components/site-meta/site-meta.html');

  it('contains charset, viewport, canonical favicons, and pre-paint theme initialization', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('favicon.ico');
    expect(html).toContain('favicon.svg');
    expect(html).toContain('apple-touch-icon.png');
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('localStorage.getItem("theme")');
  });

  it('leaves the title and description to each page', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).not.toContain('<title');
    expect(html).not.toContain('name="description"');
  });
});
`;

/** The default header's skip link, bar and logo rules, without its collapsing menu: this header has one link. */
const HEADER_BAR_CSS = SITE_HEADER_CSS.slice(
  0,
  SITE_HEADER_CSS.indexOf(".menu {"),
);

export const DOCS_SITE_HEADER_CSS = `${HEADER_BAR_CSS}.links {
  list-style: none;
  margin: 0 0 0 auto;
  padding: 0;
  display: flex;
  gap: 4px;
}
.link {
  display: block;
  padding: 6px 12px;
  font-size: 0.9rem;
  color: var(--text-muted);
  border-radius: var(--r-sm);
  text-decoration: none;
}
.link:hover { color: var(--text); background: var(--elevated); opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .link { transition: color 150ms ease, background-color 150ms ease; }
}
@media (max-width: 640px) {
  .container { padding: 0 16px; }
  nav { justify-content: space-between; gap: 12px; }
  .links { display: none; }
}
`;

/** Sticky header: the skip link first, the site name, and a link to the docs. */
export const DOCS_SITE_HEADER_HTML = `<style>
${DOCS_SITE_HEADER_CSS}</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { DOCS_HOME } from "@/lib/sidebar.ts";
        import { SITE_NAME } from "@/lib/site.ts";

        export default () => html\`<a href="/" class="logo" data-testid="site-header-logo">\${SITE_NAME}</a>
          <ul class="links">
            <li><a href="\${DOCS_HOME}" class="link" data-testid="site-header-docs">Docs</a></li>
          </ul>\`;
      </script>
      <docs-search />
      <theme-toggle />
    </nav>
  </div>
</header>
`;

export const DOCS_SEARCH_CSS = `.root { position: relative; }
.open {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-muted);
  background: var(--surface);
  font: inherit;
  cursor: pointer;
}
.open:hover { color: var(--text); border-color: var(--border-hover); }
.shortcut {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font: 0.75rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dialog {
  width: min(600px, calc(100vw - 32px));
  max-height: min(680px, calc(100vh - 40px));
  max-height: min(680px, calc(100dvh - 40px));
  margin: 10vh auto 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 16px;
  color: var(--text);
  background: var(--surface);
  box-shadow: 0 24px 80px rgb(15 23 42 / .2);
}
.dialog:modal { overscroll-behavior: contain; }
.dialog::backdrop {
  overflow: hidden;
  overscroll-behavior: contain;
  background: rgb(15 23 42 / .44);
}
.dialog[open] { animation: dialog-in 150ms ease-out both; }
@keyframes dialog-in {
  from { opacity: 0; scale: .97; }
  to { opacity: 1; scale: 1; }
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 16px;
}
.title { margin: 0; font-size: 1.05rem; }
.close {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.field { display: block; padding: 0 24px 18px; }
.label { display: block; margin-bottom: 8px; color: var(--text-muted); font-size: .85rem; }
.input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-hover);
  border-radius: var(--r-sm);
  color: var(--text);
  background: var(--surface);
  font: inherit;
}
.input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.results {
  max-height: min(380px, 45vh);
  margin: 0;
  padding: 8px 12px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  list-style: none;
}
.result + .result { border-top: 1px solid var(--border); }
.link {
  display: block;
  padding: 12px;
  border-radius: var(--r-sm);
  color: var(--text);
  text-decoration: none;
}
.link:hover, .link:focus-visible { background: var(--accent-dim); opacity: 1; }
.excerpt { display: block; margin-top: 3px; color: var(--text-muted); font-size: .85rem; }
.status { min-height: 1.5em; margin: 0; padding: 10px 24px 16px; color: var(--text-muted); font-size: .85rem; }
.open:active, .close:active { scale: .97; }
@media (prefers-reduced-motion: no-preference) {
  .open, .close { transition: scale 150ms ease-out, color 150ms ease, border-color 150ms ease, background-color 150ms ease; }
}
@media (prefers-reduced-motion: reduce) {
  .dialog[open] { animation: none; }
}
@media (max-width: 760px) {
  .open { padding: 8px 10px; }
  .shortcut { display: none; }
  .dialog { margin-top: 8vh; }
}
`;

export const DOCS_SEARCH_HTML = `<style>
${DOCS_SEARCH_CSS}</style>
<div class="root" id="root" data-testid="docs-search">
  <pre id="index" hidden><script data-bascik-build-once type="text/typescript">
    import { json } from "@bascik/bascik/html";
    import { getDocs } from "@/lib/docs.ts";
    import { docHref } from "@/lib/sidebar.ts";

    export default async () => {
      const pages = await getDocs();
      const records = pages.flatMap((page) => [
        {
          label: page.title,
          href: docHref(page.slug),
          excerpt: page.description,
          searchText: page.title + " " + page.description + " " + page.searchText,
        },
        ...page.headings.map((heading) => ({
          label: page.title + " · " + heading.text,
          href: docHref(page.slug) + "#" + heading.id,
          excerpt: heading.text,
          searchText: page.title + " " + heading.text,
        })),
      ]);
      return String(json(records));
    };
  </script></pre>
  <button id="open" class="open" type="button" aria-haspopup="dialog" aria-controls="dialog" aria-label="Search documentation" data-testid="docs-search-open" hidden>
    <span class="open-label">Search docs</span>
    <kbd class="shortcut" aria-hidden="true">⌘ / Ctrl K</kbd>
  </button>
  <dialog id="dialog" class="dialog" aria-labelledby="title" data-testid="docs-search-dialog">
    <div class="top">
      <p id="title" class="title">Search the docs</p>
      <button id="close" class="close" type="button" data-testid="docs-search-close">Close</button>
    </div>
    <label class="field">
      <span class="label">Search pages and headings</span>
      <input id="query" class="input" type="search" autocomplete="off" autofocus aria-controls="results" aria-describedby="status" data-testid="docs-search-input">
    </label>
    <ul id="results" class="results" data-testid="docs-search-results"></ul>
    <p id="status" class="status" role="status">Type to search pages and headings.</p>
  </dialog>
  <script src="docs-search.ts"></script>
</div>
`;

export const DOCS_SEARCH_SCRIPT_TS = `interface SearchRecord {
  label: string;
  href: string;
  excerpt: string;
  searchText: string;
}

const root = document.getElementById("root") as HTMLDivElement;
const index = document.getElementById("index") as HTMLPreElement;
const trigger = document.getElementById("open") as HTMLButtonElement;
const dialog = document.getElementById("dialog") as HTMLDialogElement;
const close = document.getElementById("close") as HTMLButtonElement;
const input = document.getElementById("query") as HTMLInputElement;
const results = document.getElementById("results") as HTMLUListElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const records = JSON.parse(index.textContent ?? "[]") as SearchRecord[];

const renderResults = (): void => {
  const query = input.value.trim().toLocaleLowerCase();
  results.replaceChildren();
  if (!query) {
    status.textContent = "Type to search pages and headings.";
    return;
  }

  const matches = records
    .filter((record) => record.searchText.toLocaleLowerCase().includes(query))
    .slice(0, 8);
  for (const match of matches) {
    const item = document.createElement("li");
    item.classList.add("result");
    const link = document.createElement("a");
    link.classList.add("link");
    link.setAttribute("href", match.href);
    link.setAttribute("data-testid", "docs-search-result");
    link.append(document.createTextNode(match.label));
    const excerpt = document.createElement("span");
    excerpt.classList.add("excerpt");
    excerpt.textContent = match.excerpt;
    link.append(excerpt);
    item.append(link);
    results.append(item);
  }
  status.textContent = matches.length
    ? \`\${matches.length} matching results shown.\`
    : \`No results for “\${input.value.trim()}”.\`;
};

trigger.hidden = false;
trigger.addEventListener("click", () => dialog.showModal());
close.addEventListener("click", () => dialog.close());
input.addEventListener("input", renderResults);
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }
});
`;

export const DOCS_SEARCH_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-search component', () => {
  const path = join(process.cwd(), 'src/components/docs-search/docs-search.html');
  const scriptPath = join(process.cwd(), 'src/components/docs-search/docs-search.ts');

  it('uses a native dialog with a labeled search field and a hidden progressive-enhancement trigger', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<dialog id="dialog"');
    expect(html).toContain('aria-labelledby="title"');
    expect(html).toContain('type="search"');
    expect(html).toContain("autofocus");
    expect(html).toContain(".dialog:modal { overscroll-behavior: contain; }");
    expect(html).toContain("overflow: hidden;\\n  overscroll-behavior: contain;");
    expect(html).toMatch(/<button[^>]*data-testid="docs-search-open"[^>]*hidden>/);
    expect(html).toContain('<pre id="index" hidden>');
  });

  it('supports page content search, a keyboard shortcut, and safe text rendering', async () => {
    const html = await readFile(path, 'utf8');
    const script = await readFile(scriptPath, 'utf8');
    expect(html).toContain('data-bascik-build-once');
    expect(html).toContain('getDocs()');
    expect(html).toContain('json(records)');
    expect(script).toContain('event.metaKey || event.ctrlKey');
    expect(script).toContain('event.key.toLowerCase() === "k"');
    expect(script).toContain('document.createTextNode(match.label)');
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('dialog.addEventListener("close"');
  });
});
`;

export const DOCS_SITE_HEADER_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-header component', () => {
  const path = join(process.cwd(), 'src/components/site-header/site-header.html');

  it('puts the skip link first, pointing at the main content', async () => {
    const html = await readFile(path, 'utf8');
    const header = html.slice(html.indexOf('<header'));
    expect(header.indexOf('href="#main"')).toBeLessThan(header.indexOf('<nav'));
    expect(html).toContain('.skip-link:not(:focus)');
  });

  it('prints the site name and the docs link from one build script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<script data-bascik-build-once type="text/typescript">');
    expect(html).toContain('SITE_NAME');
    expect(html).toContain('DOCS_HOME');
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain('<docs-search />');
  });
});
`;

/** Footer: the build year, the site name, and a second way to the docs. */
export const DOCS_SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { DOCS_HOME } from "@/lib/sidebar.ts";
        import { SITE_NAME } from "@/lib/site.ts";

        export default () => html\`<span class="copy">&copy; \${new Date().getFullYear()} \${SITE_NAME}</span>
          <nav aria-label="Footer" data-testid="site-footer-nav">
            <a href="/" data-testid="site-footer-home">Home</a>
            <a href="\${DOCS_HOME}" data-testid="site-footer-docs">Docs</a>
          </nav>\`;
      </script>
    </div>
  </div>
</footer>
`;

export const DOCS_SITE_FOOTER_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-footer component', () => {
  const path = join(process.cwd(), 'src/components/site-footer/site-footer.html');

  it('prints the year, the site name and its links from one build script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<script data-bascik-build-once type="text/typescript">');
    expect(html).toContain('getFullYear');
    expect(html).toContain('SITE_NAME');
    expect(html).toContain('aria-label="Footer"');
  });
});
`;

export const DOCS_SIDEBAR_CSS = `.sidebar {
  position: sticky;
  top: 84px;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  font-size: 0.9rem;
}

.toggle {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.groups, .pages { list-style: none; margin: 0; padding: 0; }
.group + .group { margin-top: 22px; }
.label {
  display: block;
  padding: 0 10px;
  margin-bottom: 6px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--text);
}
.link {
  display: block;
  padding: 5px 10px;
  border-radius: var(--r-sm);
  color: var(--text-muted);
  text-decoration: none;
}
.link:hover { color: var(--text); background: var(--elevated); opacity: 1; }
.link[aria-current="page"] { color: var(--accent); background: var(--accent-dim); font-weight: 600; }

@media (max-width: 760px) {
  .sidebar { position: static; max-height: none; overflow-y: visible; }
  .toggle { display: inline-flex; }
  .toggle[hidden] { display: none; }
  .menu {
    margin-top: 12px;
    padding: 14px 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r);
  }
  .menu[data-state="closed"] { display: none; }
}
`;

/**
 * The docs navigation: every group and page, with the page being built marked
 * `aria-current="page"`. On a small screen it collapses behind a button; the
 * button is `hidden` until the script runs, so the list stays reachable
 * without JavaScript.
 */
export const DOCS_SIDEBAR_HTML = `<style>
${DOCS_SIDEBAR_CSS}</style>
<nav class="sidebar" aria-label="Documentation" data-testid="docs-sidebar">
  <button id="toggle" type="button" class="toggle" aria-expanded="true" aria-controls="menu" data-testid="docs-sidebar-toggle" hidden>Menu</button>
  <div id="menu" class="menu" data-testid="docs-sidebar-menu">
    <script data-bascik-build type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { currentDoc } from "@/lib/current-doc.ts";

      export default async () => {
        const page = await currentDoc();
        // A hole cannot add an attribute, so the current page's link is written out with aria-current.
        const groups = page.sidebar.map((group) => {
          const links = group.links.map((link) =>
            link.slug === page.slug
              ? html\`<li><a href="\${link.href}" class="link" aria-current="page">\${link.title}</a></li>\`
              : html\`<li><a href="\${link.href}" class="link">\${link.title}</a></li>\`,
          );
          return html\`<li class="group">
            <span class="label">\${group.label}</span>
            <ul class="pages">\${links}</ul>
          </li>\`;
        });
        return html\`<ul class="groups">\${groups}</ul>\`;
      };
    </script>
  </div>
</nav>
<script type="text/typescript">
  // Without this script the list stays open. With it, a small screen starts with the list behind the button.
  const toggle = document.getElementById('toggle') as HTMLButtonElement;
  const menu = document.getElementById('menu') as HTMLDivElement;
  const show = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.setAttribute('data-state', open ? 'open' : 'closed');
  };
  toggle.hidden = false;
  show(false);
  toggle.addEventListener('click', (): void => show(toggle.getAttribute('aria-expanded') !== 'true'));
</script>
`;

export const DOCS_SIDEBAR_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-sidebar component', () => {
  const path = join(process.cwd(), 'src/components/docs-sidebar/docs-sidebar.html');

  it('is a labeled nav whose toggle names the list it controls', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<nav class="sidebar" aria-label="Documentation" data-testid="docs-sidebar">');
    expect(html).toContain('aria-controls="menu"');
    expect(html).toContain('id="menu"');
    expect(html).toContain('aria-expanded=');
  });

  it('marks the current page and keeps the list open without JavaScript', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('aria-current="page"');
    // The button only appears once the script that makes it work has run.
    expect(html).toMatch(/<button[^>]*\\shidden>/);
    expect(html).toContain('toggle.hidden = false');
  });
});
`;

export const DOCS_ARTICLE_CSS = `.title { font-size: clamp(2.2rem, 4vw, 3rem); line-height: 1.1; letter-spacing: -0.05em; margin-bottom: 14px; }
.lead { font-size: 1.05rem; margin-bottom: 32px; }
`;

/**
 * The page itself: its title, its description, and the rendered Markdown.
 * `data-bascik-preserve="id"` keeps the heading ids as written, so the table
 * of contents and a URL such as /docs/getting-started#start-the-dev-server reach them.
 */
export const DOCS_ARTICLE_HTML = `<style>
${DOCS_ARTICLE_CSS}</style>
<article data-bascik-preserve="id" data-testid="docs-article">
  <script data-bascik-build type="text/typescript">
    import { html, raw } from "@bascik/bascik/html";
    import { currentDoc } from "@/lib/current-doc.ts";

    export default async () => {
      const page = await currentDoc();
      // The Markdown is this project's own, so its HTML is trusted: raw() inserts it as it is.
      return html\`<h1 class="title">\${page.title}</h1>
        <p class="lead">\${page.description}</p>
        <div class="prose">\${raw(page.html)}</div>\`;
    };
  </script>
</article>
`;

export const DOCS_ARTICLE_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-article component', () => {
  const path = join(process.cwd(), 'src/components/docs-article/docs-article.html');

  it('is an article that keeps heading ids as written', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<article data-bascik-preserve="id" data-testid="docs-article">');
  });

  it('escapes the title and description, and inserts the rendered Markdown', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<h1 class="title">\${page.title}</h1>');
    expect(html).toContain('<p class="lead">\${page.description}</p>');
    expect(html).toContain('raw(page.html)');
  });
});
`;

export const DOCS_TOC_CSS = `.toc {
  position: sticky;
  top: 96px;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  font-size: 0.85rem;
}
/* A page with no sections has no list to show. */
.toc:not(:has(.link)) { display: none; }

.heading {
  margin: 0 0 8px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--text);
}
.list { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
.link {
  display: block;
  padding: 3px 12px;
  color: var(--text-muted);
  text-decoration: none;
}
.link:hover { color: var(--text); opacity: 1; }
.link[aria-current="location"] {
  margin-left: -1px;
  border-left: 2px solid var(--accent);
  color: var(--accent);
  font-weight: 600;
  padding-left: 11px;
}
.sub { padding-left: 24px; }
.sub[aria-current="location"] { padding-left: 23px; }

@media (max-width: 1000px) {
  .toc { display: none; }
}
`;

/** "On this page": a link to each `##` and `###` heading of the page being built. */
export const DOCS_TOC_HTML = `<style>
${DOCS_TOC_CSS}</style>
<aside class="toc" id="toc" data-testid="docs-toc">
  <script data-bascik-build type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { currentDoc } from "@/lib/current-doc.ts";

    export default async () => {
      const headings = (await currentDoc()).headings.filter((heading) => heading.depth <= 3);
      if (headings.length === 0) return "";
      const links = headings.map((heading) =>
        heading.depth === 3
          ? html\`<li><a href="#\${heading.id}" class="link sub">\${heading.text}</a></li>\`
          : html\`<li><a href="#\${heading.id}" class="link">\${heading.text}</a></li>\`,
      );
      return html\`<nav aria-label="On this page" data-testid="docs-toc-nav">
        <p class="heading">On this page</p>
        <ul class="list">\${links}</ul>
      </nav>\`;
    };
  </script>
</aside>
<script src="docs-toc.ts"></script>
`;

export const DOCS_TOC_SCRIPT_TS = `const toc = document.getElementById("toc");
const sections = Array.from(toc?.getElementsByTagName("a") ?? []).flatMap((link) => {
  const id = link.hash.slice(1);
  // These IDs belong to the Markdown, not this component.
  // bascik-ignore js-dynamic-id-lookup
  const heading = document.getElementById(id);
  return heading ? [{ link, heading }] : [];
});
let currentLink: HTMLAnchorElement | undefined;

const setCurrent = (link: HTMLAnchorElement): void => {
  if (currentLink === link) return;
  currentLink?.removeAttribute("aria-current");
  link.setAttribute("aria-current", "location");
  currentLink = link;
};

const updateCurrent = (): void => {
  const first = sections[0];
  const scrolling = document.scrollingElement;
  if (!first || !scrolling) return;

  const tolerance = 4;
  const offset = parseFloat(getComputedStyle(first.heading).scrollMarginTop);
  const maxScroll = scrolling.scrollHeight - scrolling.clientHeight;
  const scrollTop = scrolling.scrollTop;
  const target = sections.find(({ link }) => link.hash === window.location.hash);

  // Different fragments can land at the same scroll limit. Honor the URL
  // while the viewport is still at the native destination for that anchor.
  if (target) {
    const top = target.heading.getBoundingClientRect().top + scrollTop - offset;
    const destination = Math.max(0, Math.min(top, maxScroll));
    if (Math.abs(scrollTop - destination) <= tolerance) {
      setCurrent(target.link);
      return;
    }
  }

  let current = first;
  if (maxScroll > 0 && maxScroll - scrollTop <= 1) {
    current = sections[sections.length - 1];
  } else if (maxScroll > 0) {
    for (const section of sections) {
      if (section.heading.getBoundingClientRect().top > offset + tolerance) break;
      current = section;
    }
  }
  setCurrent(current.link);
};

if (sections.length > 0) {
  let pending = false;
  const scheduleUpdate = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      updateCurrent();
    });
  };
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("hashchange", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
  updateCurrent();
}
`;

export const DOCS_TOC_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-toc component', () => {
  const path = join(process.cwd(), 'src/components/docs-toc/docs-toc.html');

  it('is an aside holding a labeled nav', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<aside [^>]*data-testid="docs-toc"/);
    expect(html).toContain('<nav aria-label="On this page" data-testid="docs-toc-nav">');
  });

  it('links each heading by its id and prints its text escaped', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('href="#\${heading.id}"');
    expect(html).toContain('>\${heading.text}</a>');
    expect(html).not.toContain('raw(');
  });

  it('loads the scroll spy without replacing native fragment links', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<script src="docs-toc.ts"></script>');
  });
});
`;

export const DOCS_PAGINATION_CSS = `.pagination {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 56px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
.link {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 18px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r);
  text-decoration: none;
  transition: border-color .2s;
}
.link:hover { border-color: var(--border-hover); opacity: 1; }
.next { grid-column: 2; text-align: right; }
.direction { font-size: 0.78rem; color: var(--text-muted); }
.name { font-weight: 600; color: var(--text); }

@media (max-width: 480px) {
  .pagination { grid-template-columns: 1fr; }
  .next { grid-column: 1; }
}
`;

/** The previous and next page in sidebar order. The first page has no previous link, the last no next. */
export const DOCS_PAGINATION_HTML = `<style>
${DOCS_PAGINATION_CSS}</style>
<nav class="pagination" aria-label="Previous and next pages" data-testid="docs-pagination">
  <script data-bascik-build type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { currentDoc } from "@/lib/current-doc.ts";

    export default async () => {
      const { previous, next } = await currentDoc();
      return html\`\${
        previous &&
        html\`<a href="\${previous.href}" class="link" rel="prev" data-testid="docs-pagination-previous">
          <span class="direction">Previous</span>
          <span class="name">\${previous.title}</span>
        </a>\`
      }\${
        next &&
        html\`<a href="\${next.href}" class="link next" rel="next" data-testid="docs-pagination-next">
          <span class="direction">Next</span>
          <span class="name">\${next.title}</span>
        </a>\`
      }\`;
    };
  </script>
</nav>
`;

export const DOCS_PAGINATION_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-pagination component', () => {
  const path = join(process.cwd(), 'src/components/docs-pagination/docs-pagination.html');

  it('is a labeled nav with a previous and a next link', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<nav class="pagination" aria-label="Previous and next pages" data-testid="docs-pagination">');
    expect(html).toContain('rel="prev" data-testid="docs-pagination-previous"');
    expect(html).toContain('rel="next" data-testid="docs-pagination-next"');
  });

  it('prints a link only when the page has that neighbor', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('previous &&');
    expect(html).toContain('next &&');
  });
});
`;

// ─── Pages ───────────────────────────────────────────────────────────────────

/** The first guide opens directly at the root, using the complete docs shell. */
export const DOCS_INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/head.ts";
    import { currentDoc } from "@/lib/current-doc.ts";

    export default async () => pageHead(await currentDoc());
  </script>
</head>
<body>
  <site-header />
  <div class="container docs-layout">
    <docs-sidebar />
    <main id="main" data-testid="docs-main">
      <docs-article />
      <docs-pagination />
    </main>
    <docs-toc />
  </div>
  <site-footer />
</body>
</html>
`;

/**
 * One template for every docs page. The routes script reads the Markdown once
 * and returns a route per file; Bascik builds the page once per route and
 * hands each build script that route's data.
 */
export const DOCS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <!-- One page per Markdown file in content/docs/, at /docs/<file name>. -->
  <script data-bascik-routes type="text/typescript">
    import { getDocs } from "@/lib/docs.ts";

    export default async () =>
      (await getDocs()).slice(1).map((page) => ({
        params: { slug: page.slug },
        data: page,
      }));
  </script>
  <script data-bascik-build type="text/typescript">
    import { currentDoc } from "@/lib/current-doc.ts";
    import { pageHead } from "@/lib/head.ts";

    export default async () => pageHead(await currentDoc());
  </script>
</head>
<body>
  <site-header />
  <div class="container docs-layout">
    <docs-sidebar />
    <main id="main" data-testid="docs-main">
      <docs-article />
      <docs-pagination />
    </main>
    <docs-toc />
  </div>
  <site-footer />
</body>
</html>
`;

export const DOCS_NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/head.ts";

    export default () =>
      pageHead({
        title: "Page not found",
        description: "This page does not exist or has moved.",
        noindex: true,
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="404-main">
    <div class="container">
      <section class="section not-found">
        <p class="section-label">Error</p>
        <p class="not-found-code">404</p>
        <h1>Page not found</h1>
        <p class="not-found-text">The page you're looking for doesn't exist.</p>
        <a href="/" class="btn btn-primary" data-testid="404-home">Go home</a>
      </section>
    </div>
  </main>
  <site-footer />
</body>
</html>
`;

// ─── E2E ──────────────────────────────────────────────────────────────────────

/** The Playwright spec. It runs against `bascik --server`, so the API route test only exists with an adapter. */
export const docsE2eSpec = (
  options: { adapter?: Adapter } = {},
): string => `import { test, expect } from '@playwright/test';

test.describe('Docs site', () => {
  test('root opens directly in the docs', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/^Getting started - /);
    await expect(page.getByTestId('docs-sidebar')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();
  });

  test('skip link is the first stop and points at the page content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('site-header-skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main');
    await expect(page.getByTestId('docs-main')).toHaveCount(1);
  });

  test('sidebar lists both groups and marks only the current page', async ({ page }) => {
    await page.goto('/docs/writing-pages');
    await expect(page).toHaveTitle(/^Writing pages - /);

    const sidebar = page.getByTestId('docs-sidebar');
    await expect(sidebar.getByText('Start here')).toBeVisible();
    await expect(sidebar.getByText('Customize')).toBeVisible();
    await expect(sidebar.getByRole('link')).toHaveCount(6);

    const current = sidebar.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Writing pages');

    await sidebar.getByRole('link', { name: 'Deployment' }).click();
    await expect(page).toHaveURL('/docs/deployment');
    await expect(page.getByTestId('docs-sidebar').locator('[aria-current="page"]')).toHaveText('Deployment');
  });

  test('table of contents links jump to the headings of the page', async ({ page }) => {
    await page.goto('/');
    const toc = page.getByTestId('docs-toc-nav');
    const article = page.getByTestId('docs-article');

    // Every link names a heading that exists, by its id.
    const hrefs = await toc.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) await expect(article.locator(\`[id="\${href!.slice(1)}"]\`)).toHaveCount(1);

    const activeSection = toc.getByRole('link', { name: 'Start the dev server' });
    await activeSection.click();
    await expect(page).toHaveURL('/#start-the-dev-server');
    await expect(article.getByRole('heading', { name: 'Start the dev server' })).toBeInViewport();
    await expect(activeSection).toHaveAttribute('aria-current', 'location');
  });

  test('the table of contents preserves anchors that cannot reach the reading line', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/docs/navigation-and-search');
    const toc = page.getByTestId('docs-toc-nav');
    const article = page.getByTestId('docs-article');
    const lastSection = toc.getByRole('link', { name: 'Table of contents' });

    const scrollTo = async (edge: 'top' | 'bottom') => {
      await page.evaluate((target) => {
        const root = document.documentElement;
        window.scrollTo({ top: target === 'top' ? 0 : root.scrollHeight, behavior: 'instant' });
      }, edge);
      await expect.poll(() => page.evaluate((target) => {
        const root = document.documentElement;
        return target === 'top' ? window.scrollY === 0 : root.scrollHeight - root.clientHeight - window.scrollY <= 1;
      }, edge)).toBe(true);
    };

    await scrollTo('bottom');
    await expect(toc.locator('[aria-current="location"]')).toHaveText('Table of contents');
    await scrollTo('top');
    await expect(toc.locator('[aria-current="location"]')).toHaveText('Sidebar');

    await lastSection.click();
    await expect(page).toHaveURL('/docs/navigation-and-search#table-of-contents');
    const heading = article.getByRole('heading', { name: 'Table of contents' });
    await expect(heading).toBeInViewport();
    expect(await heading.evaluate((element) =>
      element.getBoundingClientRect().top - parseFloat(getComputedStyle(element).scrollMarginTop)
    )).toBeGreaterThan(4);
    await expect(toc.locator('[aria-current="location"]')).toHaveText('Table of contents');

    await page.goto('/');
    await page.goto('/docs/navigation-and-search#open-search');
    await expect(toc.locator('[aria-current="location"]')).toHaveText('Open search');
  });

  test('the table of contents starts at the first section when the whole page fits', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto('/docs/navigation-and-search');
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1600);
    const current = page.getByTestId('docs-toc-nav').locator('[aria-current="location"]');
    await expect(current).toHaveText('Sidebar');

    await page.getByRole('link', { name: 'Table of contents', exact: true }).click();
    await expect(current).toHaveText('Table of contents');
  });

  test('previous and next follow the sidebar order', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('docs-pagination-previous')).toHaveCount(0);

    await page.getByTestId('docs-pagination-next').click();
    await expect(page).toHaveURL('/docs/writing-pages');

    await page.getByTestId('docs-pagination-previous').click();
    await expect(page).toHaveURL('/');

    await page.goto('/docs/deployment');
    await expect(page.getByTestId('docs-pagination-next')).toHaveCount(0);
    await expect(page.getByTestId('docs-pagination-previous')).toContainText('Build and check');
  });

  test('search opens from the keyboard, finds page content, and follows a result', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');

    const dialog = page.getByTestId('docs-search-dialog');
    const input = page.getByTestId('docs-search-input');
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('front matter');
    await page.getByTestId('docs-search-results').getByRole('link', { name: /Writing pages/ }).click();
    await expect(page).toHaveURL('/docs/writing-pages');
  });

  test('sidebar collapses behind its toggle on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('docs-sidebar-toggle');
    const menu = page.getByTestId('docs-sidebar-menu');

    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
    // The page fits the screen: nothing scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Writing pages' })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
  });

  test('sidebar stays open with no toggle on a wide screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('docs-sidebar-toggle')).toBeHidden();
    await expect(page.getByTestId('docs-sidebar-menu')).toBeVisible();
    await expect(page.getByTestId('docs-toc')).toBeVisible();
    await expect(page.getByTestId('docs-search-open')).toBeVisible();
  });

  test('unknown page shows the 404 page', async ({ page }) => {
    const response = await page.goto('/docs/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle(/^Page not found - /);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    await page.getByTestId('404-home').click();
    await expect(page).toHaveURL('/');
  });
${
  options.adapter
    ? `
  test('API route answers next to the static docs', async ({ request }) => {
    const response = await request.get('/api/hello?name=reader');
    expect(response.ok()).toBe(true);
    expect((await response.json()).hello).toBe('reader');
  });
`
    : ""
}});
`;
