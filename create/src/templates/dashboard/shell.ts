/**
 * The dashboard template's app shell: the shared head, the theme pair (the
 * house pattern from `examples/components/theme-init` and `theme-toggle`),
 * the top bar with the skip link, and the sidebar navigation.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const SHELL_FILES: TemplateFile[] = [
  [
    "src/components/site-head/site-head.html",
    `<!-- @bascik
Shared head markup for every page: charset, viewport, the saved theme, the global stylesheet, and icons. Put it first in <head>, then add the page's own <title> with pageTitle() from src/lib/site.ts.
-->
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta
  name="description"
  content="Race entries, car inventory, and sales for a Porsche motorsport back office."
/>
<!-- A back office is not for search results. Remove this line for a public site. -->
<meta name="robots" content="noindex" />
<theme-init />
<link rel="stylesheet" href="/css/styles.css" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link
  rel="icon"
  type="image/png"
  sizes="32x32"
  href="/assets/favicon-32x32.png"
/>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
`,
  ],

  [
    "src/components/site-head/site-head.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/site-head/site-head.html"),
    "utf8",
  );

describe("site-head component", () => {
  it("has the charset, viewport, description, stylesheet and icons, and applies the saved theme first", async () => {
    const html = await source();
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="description"');
    expect(html).toContain("/css/styles.css");
    expect(html).toContain("favicon.ico");
    expect(html).toContain("apple-touch-icon.png");
    // The theme is set before the stylesheet loads, so the page never flashes the wrong one.
    expect(html.indexOf("<theme-init />")).toBeGreaterThan(-1);
    expect(html.indexOf("<theme-init />")).toBeLessThan(
      html.indexOf('rel="stylesheet"'),
    );
  });

  it("keeps a back office out of search results", async () => {
    expect(await source()).toContain(
      '<meta name="robots" content="noindex" />',
    );
  });
});
`,
  ],

  [
    "src/components/theme-init/theme-init.html",
    `<!-- @bascik
Applies the saved light or dark theme before first paint. <site-head /> places it in <head> of every page, so there is no flash of the wrong theme. Pairs with <theme-toggle />.
-->
<!-- Tells the browser both schemes are supported before any CSS loads, so form controls and the canvas match. -->
<meta name="color-scheme" content="light dark" />
<script type="text/typescript">
  try {
    const theme: string | null = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark")
      document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The operating system theme then applies.
  }
</script>
`,
  ],

  [
    "src/components/theme-init/theme-init.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/theme-init/theme-init.html"),
    "utf8",
  );

describe("theme-init component", () => {
  it("declares both color schemes and applies only a saved light or dark theme", async () => {
    const html = await source();
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).toContain('localStorage.getItem("theme")');
    expect(html).toContain('theme === "light" || theme === "dark"');
    expect(html).toContain('<script type="text/typescript">');
  });

  it("survives a browser that blocks storage", async () => {
    expect(await source()).toMatch(/try \\{[\\s\\S]*\\} catch \\{/);
  });
});
`,
  ],

  [
    "src/components/theme-toggle/theme-toggle.html",
    `<!-- @bascik
A button that switches between light and dark themes and remembers the choice. Needs <theme-init /> in <head> and the color-scheme rules in styles.css. Hidden until its script runs.
-->
<style>
  .toggle {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  /* An author display value beats the hidden attribute, so restate it: the button stays hidden until its script runs. */
  .toggle[hidden] {
    display: none;
  }

  /* Pressed is shown by the check mark, not only by a color. */
  .toggle[aria-pressed="true"]::before {
    content: "✓ ";
  }
</style>
<button
  class="toggle"
  id="toggle"
  type="button"
  data-testid="theme-toggle"
  hidden
>
  Dark theme
</button>
<script type="text/typescript">
  // aria-pressed tells assistive technology whether dark theme is on; the label stays the same.
  const toggle = document.getElementById("toggle") as HTMLButtonElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;

  const current = (): string =>
    root.getAttribute("data-theme") ?? (media.matches ? "dark" : "light");

  const render = (): void => {
    toggle.setAttribute("aria-pressed", String(current() === "dark"));
  };

  toggle.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Not persisted when storage is unavailable; the choice still applies here.
    }
    render();
    // Other components can react without reaching into this one.
    toggle.dispatchEvent(
      new CustomEvent("theme-change", {
        bubbles: true,
        detail: { theme: next },
      }),
    );
  });

  media.addEventListener("change", render);
  // Stay in sync when any other script changes the theme.
  new MutationObserver(render).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  render();
  toggle.hidden = false;
</script>
`,
  ],

  [
    "src/components/theme-toggle/theme-toggle.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/theme-toggle/theme-toggle.html"),
    "utf8",
  );

describe("theme-toggle component", () => {
  it("is a real button that stays hidden until its script runs", async () => {
    const html = await source();
    expect(html).toMatch(/<button[^>]*type="button"[^>]*hidden/s);
    expect(html).toContain('data-testid="theme-toggle"');
    expect(html).toContain("toggle.hidden = false");
  });

  it("says its state with aria-pressed, saves the choice, and tells other components", async () => {
    const html = await source();
    expect(html).toContain('setAttribute("aria-pressed"');
    expect(html).toContain('localStorage.setItem("theme", next)');
    expect(html).toContain('new CustomEvent("theme-change"');
    // The pressed state has a mark of its own, so it does not depend on color.
    expect(html).toContain('[aria-pressed="true"]::before');
  });
});
`,
  ],

  [
    "src/components/app-header/app-header.html",
    `<!-- @bascik
The top bar of every page: the skip link, the site's name, and the theme toggle.
-->
<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .skip-link {
    position: absolute;
    left: 16px;
    top: 8px;
    padding: 8px 14px;
    border-radius: var(--radius);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    font-weight: 600;
    z-index: 200;
  }
  /* Hidden until focused. Clipping, not an offset, keeps it hidden when something sits above the header. */
  .skip-link:not(:focus) {
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .brand {
    color: inherit;
    font-weight: 700;
    text-decoration: none;
  }

  .area {
    margin-inline-end: auto;
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  @media (max-width: 47.99rem) {
    header {
      padding-inline: var(--space-3);
    }
  }
</style>
<header data-testid="app-header">
  <a href="#main" class="skip-link" data-testid="app-header-skip-link"
    >Skip to content</a
  >
  <a href="/" class="brand" data-testid="app-header-brand">
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { SITE_NAME } from "@/lib/site.ts";
      export default () => html\`\${SITE_NAME}\`;
    </script>
  </a>
  <span class="area">Back office</span>
  <theme-toggle />
</header>
`,
  ],

  [
    "src/components/app-header/app-header.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/app-header/app-header.html"),
    "utf8",
  );

describe("app-header component", () => {
  it("is a <header> whose first element is the skip link to #main", async () => {
    const html = await source();
    const markup = html.slice(html.indexOf("</style>"));
    expect(markup).toMatch(/^<\\/style>\\s*<header\\b/);
    expect(markup).toMatch(/<header[^>]*>\\s*<a href="#main" class="skip-link"/);
  });

  it("hides the skip link by clipping until it is focused", async () => {
    const html = await source();
    expect(html).toMatch(
      /\\.skip-link:not\\(:focus\\) \\{[^}]*clip-path: inset\\(50%\\)/,
    );
  });

  it("prints the site's name from src/lib/site.ts, and holds the theme toggle", async () => {
    const html = await source();
    expect(html).toContain('import { SITE_NAME } from "@/lib/site.ts"');
    expect(html).toContain("html\`\${SITE_NAME}\`");
    expect(html).toContain("<theme-toggle />");
  });
});
`,
  ],

  [
    "src/components/app-sidebar/app-sidebar.html",
    `<!-- @bascik
The sidebar navigation. It marks the link to the page being built with aria-current="page". At phone width the links collapse behind the Menu button; without JavaScript they stay open.
-->
<style>
  .sidebar {
    padding: var(--space-3);
    border-inline-end: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .toggle {
    display: none;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .links {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .link {
    display: block;
    padding: var(--space-2) 0.75rem;
    border-inline-start: 3px solid transparent;
    border-radius: var(--radius);
    color: inherit;
    text-decoration: none;
  }

  .link:hover {
    background: var(--color-bg);
  }

  /* The current page: a bar and bold text, not only a color. */
  .link[aria-current="page"] {
    border-inline-start-color: var(--color-accent);
    background: var(--color-bg);
    font-weight: 700;
  }

  @media (max-width: 47.99rem) {
    .sidebar {
      padding: var(--space-2) var(--space-3);
      border-inline-end: 0;
      border-bottom: 1px solid var(--color-border);
    }

    .toggle {
      display: block;
    }

    /* An author display value beats the hidden attribute, so restate it: no button without its script. */
    .toggle[hidden] {
      display: none;
    }

    .sidebar[data-collapsed="true"] .links {
      display: none;
    }

    .links {
      margin-top: var(--space-2);
    }
  }
</style>
<nav class="sidebar" id="sidebar" aria-label="Main" data-testid="app-sidebar">
  <button
    class="toggle"
    id="toggle"
    type="button"
    aria-expanded="true"
    aria-controls="links"
    data-testid="app-sidebar-toggle"
    hidden
  >
    Menu
  </button>
  <ul class="links" id="links" data-testid="app-sidebar-links">
    <script data-bascik-build type="text/typescript">
      import { navLinks } from "./nav.ts";
      // BASCIK_PAGE_PATH is the page being built, so each page marks its own link.
      export default () => navLinks(process.env.BASCIK_PAGE_PATH);
    </script>
  </ul>
</nav>
<script type="text/typescript">
  const toggle = document.getElementById("toggle") as HTMLButtonElement;
  const sidebar = document.getElementById("sidebar") as HTMLElement;

  // One function applies the state: the button says it, and the CSS reads it at phone width.
  const render = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
    sidebar.setAttribute("data-collapsed", String(!open));
  };

  toggle.addEventListener("click", () =>
    render(toggle.getAttribute("aria-expanded") !== "true"),
  );
  render(false);
  toggle.hidden = false;
</script>
`,
  ],

  [
    "src/components/app-sidebar/nav.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";

export interface NavLink {
  href: string;
  label: string;
}

/** The sidebar's links, in order. Add a page here and it appears on every page. */
export const NAV_LINKS: readonly NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/orders", label: "Orders" },
  { href: "/titles", label: "Titles" },
  { href: "/settings", label: "Settings" },
];

/** "/orders/", "/orders.html" and "/orders/index" are all the page "/orders". */
const normalize = (path: string): string =>
  path
    .replace(/\\\\/g, () => "/")
    .replace(/\\.html$/, () => "")
    .replace(/\\/index$/, () => "/")
    .replace(/(.)\\/+$/, (_match, before: string) => before) || "/";

/**
 * Whether \`href\` is the page at \`pagePath\`. A page under it, such as
 * /titles/a-title, is a different page, and an empty path is no page at all.
 */
export const isCurrent = (href: string, pagePath: string): boolean =>
  pagePath !== "" && normalize(href) === normalize(pagePath);

/** One \`<li>\` per link, the current page's marked with aria-current="page". */
export function navLinks(
  pagePath = "",
  links: readonly NavLink[] = NAV_LINKS,
): SafeHtml {
  return html\`\${links.map((link) =>
    isCurrent(link.href, pagePath)
      ? html\`<li>
          <a class="link" href="\${link.href}" aria-current="page"
            >\${link.label}</a
          >
        </li>\`
      : html\`<li><a class="link" href="\${link.href}">\${link.label}</a></li>\`,
  )}\`;
}
`,
  ],

  [
    "src/components/app-sidebar/app-sidebar.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_LINKS, isCurrent, navLinks } from "./nav.ts";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/app-sidebar/app-sidebar.html"),
    "utf8",
  );

describe("app-sidebar component", () => {
  it("is a labeled <nav> whose Menu button is a real button that controls the list", async () => {
    const html = await source();
    expect(html).toMatch(/<nav[^>]*aria-label="Main"/);
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-expanded="true"[^>]*aria-controls="links"[^>]*hidden/s,
    );
    expect(html).toContain('<ul class="links" id="links"');
  });

  it("keeps the links open without JavaScript: only the script collapses them", async () => {
    const html = await source();
    expect(html).not.toMatch(/<nav[^>]*data-collapsed/);
    expect(html).toContain('sidebar.setAttribute("data-collapsed"');
    expect(html).toContain("toggle.hidden = false");
  });

  it("marks the current page from the page being built", async () => {
    expect(await source()).toContain("navLinks(process.env.BASCIK_PAGE_PATH)");
  });
});

describe("navLinks", () => {
  it("marks exactly one link with aria-current on each page it links to", () => {
    for (const link of NAV_LINKS) {
      const markup = String(navLinks(link.href));
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      expect(markup).toMatch(
        new RegExp(
          \`href="\${link.href}" aria-current="page"\\\\s*>\${link.label}<\`,
        ),
      );
    }
  });

  it("marks no link on a page the sidebar does not link to, or when there is no page", () => {
    for (const path of ["/titles/the-lighthouse-ledger", "/404", "", undefined])
      expect(String(navLinks(path))).not.toContain("aria-current");
  });

  it("escapes a label that holds markup", () => {
    const markup = String(
      navLinks("/", [{ href: "/x", label: "<b>Tom & Ann</b>" }]),
    );
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("Tom &amp; Ann");
  });
});

describe("isCurrent", () => {
  it("treats a trailing slash, .html, /index and backslashes as the same page", () => {
    for (const path of [
      "/orders",
      "/orders/",
      "/orders.html",
      "/orders/index",
      "/orders/index.html",
      "\\\\orders",
    ])
      expect(isCurrent("/orders", path), path).toBe(true);
    for (const path of ["/", "/index", "/index.html"])
      expect(isCurrent("/", path), path).toBe(true);
  });

  it("does not match a page under the link, or one that only starts the same", () => {
    expect(isCurrent("/titles", "/titles/the-lighthouse-ledger")).toBe(false);
    expect(isCurrent("/orders", "/orders-archive")).toBe(false);
    expect(isCurrent("/", "/orders")).toBe(false);
    // Built with no page (an empty path), nothing is current: not even the home page.
    expect(isCurrent("/", "")).toBe(false);
  });
});
`,
  ],
];
