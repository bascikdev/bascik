/**
 * The docs template's components, pages, global CSS and Playwright spec.
 * The shared pieces come from the default template in `scaffold.ts`.
 */

import {
  HOST_RUNTIME,
  SITE_FOOTER_CSS,
  SITE_HEADER_CSS,
  SITE_META_HTML,
  STYLES_CSS,
  type Adapter,
} from "../../scaffold.js";

// ─── Global CSS ───────────────────────────────────────────────────────────────

/**
 * The default template's design system, plus the three-column docs layout and
 * the styles of rendered Markdown. Markdown arrives as build script output, so
 * it is styled from here under `.prose`, not from a component's scoped CSS.
 */
export const DOCS_STYLES_CSS = `${STYLES_CSS}
/* ── Docs layout: sidebar, page, table of contents ── */
.docs-layout {
  flex: 1;
  width: 100%;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 200px;
  gap: 48px;
  align-items: start;
  padding-top: 40px;
  padding-bottom: 72px;
}
@media (max-width: 1000px) {
  .docs-layout { grid-template-columns: 220px minmax(0, 1fr); gap: 36px; }
}
@media (max-width: 760px) {
  .docs-layout { grid-template-columns: minmax(0, 1fr); gap: 20px; padding-top: 20px; }
}

/* ── Rendered Markdown ── */
.prose h2, .prose h3, .prose h4 { scroll-margin-top: 80px; }
.prose h2 { font-size: 1.4rem; margin: 40px 0 12px; }
.prose h3 { font-size: 1.1rem; margin: 28px 0 8px; }
.prose h4 { font-size: 1rem; margin: 24px 0 8px; }
.prose p, .prose ul, .prose ol, .prose pre, .prose table, .prose blockquote { margin: 0 0 18px; }
.prose ul, .prose ol { padding-left: 22px; color: var(--text-muted); }
.prose li + li { margin-top: 4px; }
.prose pre {
  background: var(--elevated); border: 1px solid var(--border);
  border-radius: var(--r); padding: 16px 18px; overflow-x: auto;
}
.prose pre code {
  background: none; border: none; padding: 0;
  color: var(--text); font-size: 0.85rem; line-height: 1.6;
}
.prose table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.9rem; }
.prose th, .prose td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.prose th { color: var(--text); font-weight: 600; }
.prose td { color: var(--text-muted); }
.prose blockquote {
  background: var(--accent-dim); border: 1px solid rgba(211,255,141,0.22);
  border-radius: var(--r); padding: 14px 18px;
}
.prose blockquote p { color: var(--text); margin: 0; }
`;

// ─── Components ───────────────────────────────────────────────────────────────

/**
 * The default template's head tags without its site-wide description: every
 * page of this template prints its own with `pageHead()`.
 */
export const DOCS_SITE_META_HTML = SITE_META_HTML.split("\n")
  .filter((line) => !line.includes('name="description"'))
  .join("\n");

export const DOCS_SITE_META_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-meta component', () => {
  const path = join(process.cwd(), 'src/components/site-meta/site-meta.html');

  it('contains charset, viewport, favicon, and stylesheet link tags', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('favicon.ico');
    expect(html).toContain('favicon.svg');
    expect(html).toContain('apple-touch-icon.png');
    expect(html).toContain('styles.css');
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
  transition: color .15s, background .15s;
}
.link:hover { color: var(--text); background: var(--elevated); opacity: 1; }
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
    </nav>
  </div>
</header>
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

/** The landing page's opening: the site name, one line about it, and the way into the docs. */
export const HOME_HERO_HTML = `<section class="hero" data-testid="home-hero">
  <div class="container">
    <p class="section-label">Documentation</p>
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { DOCS_HOME } from "@/lib/sidebar.ts";
      import { SITE_NAME } from "@/lib/site.ts";

      export default () => html\`<h1>\${SITE_NAME}</h1>
        <p>The race operations and engineering notes for braking, setup, pit work, telemetry, and Porsche prototypes.</p>
        <div class="hero-actions">
          <a href="\${DOCS_HOME}" class="btn btn-primary" data-testid="home-hero-start">Read the docs</a>
        </div>\`;
    </script>
  </div>
</section>
`;

export const HOME_HERO_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('home-hero component', () => {
  const path = join(process.cwd(), 'src/components/home-hero/home-hero.html');

  it('is a section whose heading and docs link come from a build script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="hero" data-testid="home-hero">');
    expect(html).toContain('<h1>\${SITE_NAME}</h1>');
    expect(html).toContain('href="\${DOCS_HOME}"');
    expect(html).toContain('data-testid="home-hero-start"');
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
      import { currentDoc } from "@/lib/docs.ts";

      export default () => {
        const page = currentDoc();
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

export const DOCS_ARTICLE_CSS = `.title { font-size: clamp(1.8rem, 4vw, 2.4rem); margin-bottom: 10px; }
.lead { font-size: 1.05rem; margin-bottom: 32px; }
`;

/**
 * The page itself: its title, its description, and the rendered Markdown.
 * `data-bascik-preserve="id"` keeps the heading ids as written, so the table
 * of contents and a URL such as /docs/braking-zones#repeat-and-review reach them.
 */
export const DOCS_ARTICLE_HTML = `<style>
${DOCS_ARTICLE_CSS}</style>
<article data-bascik-preserve="id" data-testid="docs-article">
  <script data-bascik-build type="text/typescript">
    import { html, raw } from "@bascik/bascik/html";
    import { currentDoc } from "@/lib/docs.ts";

    export default () => {
      const page = currentDoc();
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
  top: 84px;
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
.sub { padding-left: 24px; }

@media (max-width: 1000px) {
  .toc { display: none; }
}
`;

/** "On this page": a link to each `##` and `###` heading of the page being built. */
export const DOCS_TOC_HTML = `<style>
${DOCS_TOC_CSS}</style>
<aside class="toc" data-testid="docs-toc">
  <script data-bascik-build type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { currentDoc } from "@/lib/docs.ts";

    export default () => {
      const headings = currentDoc().headings.filter((heading) => heading.depth <= 3);
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
`;

export const DOCS_TOC_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('docs-toc component', () => {
  const path = join(process.cwd(), 'src/components/docs-toc/docs-toc.html');

  it('is an aside holding a labeled nav', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<aside class="toc" data-testid="docs-toc">');
    expect(html).toContain('<nav aria-label="On this page" data-testid="docs-toc-nav">');
  });

  it('links each heading by its id and prints its text escaped', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('href="#\${heading.id}"');
    expect(html).toContain('>\${heading.text}</a>');
    expect(html).not.toContain('raw(');
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
    import { currentDoc } from "@/lib/docs.ts";

    export default () => {
      const { previous, next } = currentDoc();
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

/** The extra card a hosted site gets, pointing at the API route every adapter starter has. */
const apiFeatureCard = (runtime: string): string => `
      <feature-card data-testid="feature-api">
        <div data-bascik-slot="header">API route</div>
        <h3>Ready for request-time code</h3>
        <p>The docs are static files. <a href="/api/hello">/api/hello</a>, in <code>src/api/hello.ts</code>, runs in ${runtime}.</p>
      </feature-card>`;

/** The landing page's second section: what the template gives you, as three feature cards (four with an adapter). */
export const homeFeatures = (
  options: { adapter?: Adapter } = {},
): string => `<section class="section" data-testid="home-features">
  <div class="container">
    <p class="section-label">Start here</p>
    <h2>How this site works</h2>
    <p>Replace the sample pages with your own: the sidebar, the table of contents, and the previous and next links follow.</p>
    <div class="grid-3 mt-28">
      <feature-card data-testid="feature-markdown">
        <div data-bascik-slot="header">Markdown</div>
        <h3>One file per page</h3>
        <p>Each file in <code>content/docs/</code> becomes a page at <code>/docs/</code> and its name.</p>
      </feature-card>
      <feature-card data-testid="feature-sidebar">
        <div data-bascik-slot="header">Sidebar</div>
        <h3>You choose the order</h3>
        <p>Groups and pages are listed in <code>src/lib/sidebar.ts</code>. A page you forget to list fails the build.</p>
      </feature-card>
      <feature-card data-testid="feature-toc">
        <div data-bascik-slot="header">On this page</div>
        <h3>Built from your headings</h3>
        <p>Every <code>##</code> and <code>###</code> heading gets a link beside the page.</p>
      </feature-card>${options.adapter ? apiFeatureCard(HOST_RUNTIME[options.adapter]) : ""}
    </div>
  </div>
</section>
`;

export const HOME_FEATURES_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('home-features component', () => {
  const path = join(process.cwd(), 'src/components/home-features/home-features.html');

  it('is a section with a heading and a feature card for each part of the site', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="home-features">');
    expect(html).toContain('<h2>How this site works</h2>');
    for (const card of ['feature-markdown', 'feature-sidebar', 'feature-toc']) {
      expect(html).toContain(\`<feature-card data-testid="\${card}">\`);
    }
  });
});
`;

// ─── Pages ───────────────────────────────────────────────────────────────────

/** The landing page: the hero, then what the template gives you. */
export const DOCS_INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <site-meta />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/head.ts";

    export default () =>
      pageHead({
        title: "Documentation",
        description: "Race operations and engineering guides for braking, setup, pit work, telemetry, rules, and Porsche race cars.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="home-main">
    <home-hero />
    <home-features />
  </main>
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
      (await getDocs()).map((page) => ({
        params: { slug: page.slug },
        data: page,
      }));
  </script>
  <script data-bascik-build type="text/typescript">
    import { currentDoc } from "@/lib/docs.ts";
    import { pageHead } from "@/lib/head.ts";

    export default () => pageHead(currentDoc());
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
  test('landing page leads into the docs', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/^Documentation - /);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByTestId('home-hero-start').click();
    await expect(page).toHaveURL('/docs/race-weekend');
    await expect(page.getByRole('heading', { level: 1, name: 'Race weekend' })).toBeVisible();
  });

  test('skip link is the first stop and points at the page content', async ({ page }) => {
    await page.goto('/docs/race-weekend');
    await page.keyboard.press('Tab');
    const skip = page.getByTestId('site-header-skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('sidebar lists both groups and marks only the current page', async ({ page }) => {
    await page.goto('/docs/braking-zones');
    await expect(page).toHaveTitle(/^Braking zones - /);

    const sidebar = page.getByTestId('docs-sidebar');
    await expect(sidebar.getByText('Racecraft')).toBeVisible();
    await expect(sidebar.getByText('Operations')).toBeVisible();
    await expect(sidebar.getByRole('link')).toHaveCount(6);

    const current = sidebar.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Braking zones');

    await sidebar.getByRole('link', { name: 'Porsche classic race engineering' }).click();
    await expect(page).toHaveURL('/docs/porsche-classics');
    await expect(page.getByTestId('docs-sidebar').locator('[aria-current="page"]')).toHaveText('Porsche classic race engineering');
  });

  test('table of contents links jump to the headings of the page', async ({ page }) => {
    await page.goto('/docs/braking-zones');
    const toc = page.getByTestId('docs-toc-nav');
    const article = page.getByTestId('docs-article');

    // Every link names a heading that exists, by its id.
    const hrefs = await toc.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) await expect(article.locator(\`[id="\${href!.slice(1)}"]\`)).toHaveCount(1);

    await toc.getByRole('link', { name: 'Repeat and review' }).click();
    await expect(page).toHaveURL('/docs/braking-zones#repeat-and-review');
    await expect(article.getByRole('heading', { name: 'Repeat and review' })).toBeInViewport();
  });

  test('previous and next follow the sidebar order', async ({ page }) => {
    await page.goto('/docs/race-weekend');
    await expect(page.getByTestId('docs-pagination-previous')).toHaveCount(0);

    await page.getByTestId('docs-pagination-next').click();
    await expect(page).toHaveURL('/docs/braking-zones');

    await page.getByTestId('docs-pagination-previous').click();
    await expect(page).toHaveURL('/docs/race-weekend');

    await page.goto('/docs/porsche-classics');
    await expect(page.getByTestId('docs-pagination-next')).toHaveCount(0);
    await expect(page.getByTestId('docs-pagination-previous')).toContainText('Data channels and race rules');
  });

  test('sidebar collapses behind its toggle on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/docs/race-weekend');

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
    await expect(menu.getByRole('link', { name: 'Setup and tyres' })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
  });

  test('sidebar stays open with no toggle on a wide screen', async ({ page }) => {
    await page.goto('/docs/race-weekend');
    await expect(page.getByTestId('docs-sidebar-toggle')).toBeHidden();
    await expect(page.getByTestId('docs-sidebar-menu')).toBeVisible();
    await expect(page.getByTestId('docs-toc')).toBeVisible();
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
