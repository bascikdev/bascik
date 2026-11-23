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
Shared head markup for every page: charset, viewport, the saved theme, and icons. The config inlines global CSS. Put this first in <head>, then add the page's own <title> with pageTitle() from src/lib/site.ts.
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
  it("has charset, viewport, description and icons, with saved theme initialization and no external stylesheet", async () => {
    const html = await source();
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="description"');
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain("favicon.ico");
    expect(html).toContain("apple-touch-icon.png");
    // The saved theme is applied from the head before first paint.
    expect(html.indexOf("<theme-init />")).toBeGreaterThan(-1);
    expect(html.indexOf("<theme-init />")).toBeLessThan(
      html.indexOf('rel="icon"'),
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
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    flex-shrink: 0;
    padding: var(--space-2);
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

  .icon {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sun { display: none; }
  .toggle[aria-pressed="true"] .sun { display: block; }
  .toggle[aria-pressed="true"] .moon { display: none; }

  .toggle:hover {
    background: var(--color-accent-wash);
  }

  @media (max-width: 47.99rem) {
    .toggle { display: none; }
  }
</style>
<button
  class="toggle"
  id="toggle"
  type="button"
  aria-label="Dark theme"
  aria-pressed="false"
  data-testid="theme-toggle"
  hidden
>
  <svg class="icon moon" data-testid="theme-toggle-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
  </svg>
  <svg class="icon sun" data-testid="theme-toggle-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
  </svg>
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
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next);
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
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
    // Decorative icons change shape, while the accessible toggle name stays stable.
    expect(html).toContain('aria-label="Dark theme"');
    expect(html).toContain('[aria-pressed="true"] .sun');
    expect(html).toContain('aria-hidden="true"');
  });
});
`,
  ],

  [
    "src/components/app-header/app-header.html",
    `<!-- @bascik
The top bar of every page: the skip link, the site's name, and the theme toggle. At phone width a menu button at the top right opens the navigation, which prints the sidebar's links and ends with the theme switch.
-->
<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 4rem;
    padding: var(--space-2) clamp(1rem, 3vw, 2rem);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    position: relative;
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
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  @media (max-width: 47.99rem) {
    header {
      padding-inline: var(--space-3);
    }
  }

  /* The phone-width menu button: three bars that become a cross while the menu is open. */
  .menu-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    cursor: pointer;
    touch-action: manipulation;
  }
  .menu-toggle:hover { background: var(--color-accent-wash); }
  .toggle-icon,
  .toggle-icon::before,
  .toggle-icon::after {
    display: block;
    width: 20px;
    height: 2px;
    border-radius: 2px;
    background: var(--color-muted);
  }
  .toggle-icon { position: relative; }
  .toggle-icon::before,
  .toggle-icon::after { content: ""; position: absolute; left: 0; }
  .toggle-icon::before { translate: 0 -6px; }
  .toggle-icon::after { translate: 0 6px; }
  .menu-toggle[aria-expanded="true"] .toggle-icon { background: transparent; }
  .menu-toggle[aria-expanded="true"] .toggle-icon::before { translate: 0 0; rotate: 45deg; }
  .menu-toggle[aria-expanded="true"] .toggle-icon::after { translate: 0 0; rotate: -45deg; }
  @media (prefers-reduced-motion: no-preference) {
    .toggle-icon::before,
    .toggle-icon::after { transition: translate 150ms ease-out, rotate 150ms ease-out; }
  }

  /* The panel is hidden at desktop width. */
  .panel { display: none; }

  /* The theme row at the bottom of the phone menu. */
  .mobile { display: none; }
  .separator { margin: 16px 0 20px; border: 0; border-top: 1px solid var(--color-border); }
  .mobile-theme {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
    cursor: pointer;
  }
  .mobile-theme[hidden] { display: none; }
  .mobile-theme:hover { color: inherit; background: var(--color-accent-wash); }
  .mobile-theme svg { flex: 0 0 18px; width: 18px; height: 18px; }
  .mobile-theme .sun { display: none; }
  .mobile-theme[data-dark="true"] .sun { display: block; }
  .mobile-theme[data-dark="true"] .moon { display: none; }

  @media (max-width: 47.99rem) {
    .menu-toggle:not([hidden]) { display: flex; }
    /* The open menu covers the screen below the header. */
    .menu-toggle:not([hidden]) + .panel {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      /* The script sets the exact height from the header's bottom edge when the menu opens. */
      height: calc(100dvh - 4rem);
      overflow-y: auto;
      z-index: 100;
      background: var(--color-bg);
      padding: var(--space-4) var(--space-3);
      flex-direction: column;
      align-items: stretch;
      margin: 0;
    }
    .menu-toggle[aria-expanded="true"] + .panel { display: flex; }
    .menu-toggle:not([hidden]) + .panel .links {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .menu-toggle:not([hidden]) + .panel .links a {
      display: flex;
      align-items: center;
      min-height: 2.75rem;
      padding: var(--space-2) 0.75rem;
      border-radius: var(--radius);
      color: inherit;
      font-size: 0.9375rem;
      text-decoration: none;
    }
    .menu-toggle:not([hidden]) + .panel .links a:hover {
      background: var(--color-accent-wash);
    }
    .menu-toggle:not([hidden]) + .panel .links a[aria-current="page"] {
      font-weight: 700;
      background: var(--color-accent-wash);
    }

    .menu-toggle:not([hidden]) + .panel .mobile { display: block; }
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
  <span class="area">Operations</span>
  <button id="nav-toggle" type="button" class="menu-toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="app-header-nav-toggle" hidden>
    <span class="toggle-icon"></span>
  </button>
  <div id="nav-menu" class="panel" data-testid="app-header-nav-menu">
    <nav aria-label="Main" data-testid="app-header-nav">
      <ul class="links" data-testid="app-header-nav-links">
        <script data-bascik-build type="text/typescript">
          import { navLinks } from "../app-sidebar/nav.ts";
          // The same links as the sidebar, which is not displayed at phone width.
          export default () => navLinks(process.env.BASCIK_PAGE_PATH);
        </script>
      </ul>
    </nav>
    <div class="mobile">
      <hr class="separator" />
      <button id="mobile-theme" type="button" class="mobile-theme" aria-label="Switch to dark theme" data-testid="app-header-mobile-theme" hidden>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z" /></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></svg>
        <span id="mobile-theme-label">Dark</span>
      </button>
    </div>
  </div>
  <theme-toggle />
</header>
<script type="text/typescript">
  const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
  const panel = document.getElementById("nav-menu") as HTMLElement;
  const header = toggle.closest("header") as HTMLElement;
  const setOpen = (open: boolean): void => {
    if (open) {
      // The menu fills the screen below the header, so bring the header to the top and measure it.
      header.scrollIntoView();
      panel.style.height = "calc(100dvh - " + header.getBoundingClientRect().bottom + "px)";
    } else panel.style.height = "";
    toggle.setAttribute("aria-expanded", String(open));
    // The page behind the open menu does not scroll.
    document.body.style.overflow = open ? "hidden" : "";
  };
  toggle.addEventListener("click", (): void => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  header.addEventListener("keydown", (event): void => {
    if (event.key !== "Escape" || toggle.getAttribute("aria-expanded") !== "true" || toggle.getClientRects().length === 0) return;
    setOpen(false);
    toggle.focus();
  });
  // Leaving phone width closes the menu, so the page is never left unable to scroll.
  matchMedia("(max-width: 47.99rem)").addEventListener("change", (): void => setOpen(false));
  toggle.hidden = false;

  // The labeled theme row in the phone menu. <theme-toggle /> is another component, so the row keeps the same
  // storage key and follows the root's data-theme, which both controls write.
  const mobileTheme = document.getElementById("mobile-theme") as HTMLButtonElement;
  const mobileLabel = document.getElementById("mobile-theme-label") as HTMLSpanElement;
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");

  const current = (): string =>
    root.getAttribute("data-theme") ?? (media.matches ? "dark" : "light");

  const sync = (): void => {
    const dark = current() === "dark";
    // The row names the theme it switches to.
    mobileTheme.dataset.dark = String(dark);
    mobileTheme.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    mobileLabel.textContent = dark ? "Light" : "Dark";
  };

  const switchTheme = (): void => {
    const next = current() === "dark" ? "light" : "dark";
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next);
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Not persisted when storage is unavailable; the choice still applies here.
    }
    sync();
  };

  mobileTheme.addEventListener("click", switchTheme);
  media.addEventListener("change", sync);
  // Stay in sync when any other script changes the theme.
  new MutationObserver(sync).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window.addEventListener("pageshow", sync);
  sync();
  mobileTheme.hidden = false;
</script>
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

  it("has a phone menu: a hidden-until-scripted button, the sidebar's links, then a labeled theme row", async () => {
    const html = await source();
    expect(html).toMatch(
      /<button id="nav-toggle"[^>]*aria-controls="nav-menu"[^>]*aria-expanded="false"[^>]*hidden>/,
    );
    expect(html).toContain('.menu-toggle[aria-expanded="true"] + .panel');
    expect(html).toContain('import { navLinks } from "../app-sidebar/nav.ts"');
    const menu = html.slice(html.indexOf('id="nav-menu"'));
    expect(menu.indexOf("navLinks(")).toBeLessThan(
      menu.indexOf('id="mobile-theme"'),
    );
    expect(html).toMatch(
      /<button id="mobile-theme"[^>]*data-testid="app-header-mobile-theme"[^>]*hidden>/,
    );
  });
});
`,
  ],

  [
    "src/components/app-sidebar/app-sidebar.html",
    `<!-- @bascik
The sidebar navigation. It marks the link to the page being built with aria-current="page". At phone width <app-header /> lists the same links in its menu and this sidebar is not displayed; without JavaScript it stays in place.
-->
<style>
  .sidebar {
    padding: var(--space-4) var(--space-3);
    border-inline-end: 1px solid var(--color-border);
    background: var(--color-bg);
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
    font-size: 0.9375rem;
    text-decoration: none;
  }

  .link:hover {
    background: var(--color-accent-wash);
  }

  /* The current page: a bar and bold text, not only a color. */
  .link[aria-current="page"] {
    border-inline-start-color: var(--color-accent);
    background: var(--color-accent-wash);
    font-weight: 700;
  }

  @media (max-width: 47.99rem) {
    .sidebar {
      padding: var(--space-2) var(--space-3);
      border-inline-end: 0;
      border-bottom: 1px solid var(--color-border);
    }

    .sidebar[data-enhanced="true"] {
      display: none;
    }

    .links {
      margin-top: var(--space-2);
    }
  }
</style>
<nav class="sidebar" id="sidebar" aria-label="Main" data-testid="app-sidebar">
  <ul class="links" id="links" data-testid="app-sidebar-links">
    <script data-bascik-build type="text/typescript">
      import { navLinks } from "./nav.ts";
      // BASCIK_PAGE_PATH is the page being built, so each page marks its own link.
      export default () => navLinks(process.env.BASCIK_PAGE_PATH);
    </script>
  </ul>
</nav>
<script type="text/typescript">
  const sidebar = document.getElementById("sidebar") as HTMLElement;
  // With this script running, <app-header /> has the phone menu, so the sidebar steps aside at phone width.
  sidebar.dataset.enhanced = "true";
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
  it("is a labeled <nav> around the list of links, with no menu button of its own", async () => {
    const html = await source();
    expect(html).toMatch(/<nav[^>]*aria-label="Main"/);
    expect(html).toContain('<ul class="links" id="links"');
    expect(html).not.toContain("<button");
  });

  it("stays in place without JavaScript: only its script lets it step aside at phone width", async () => {
    const html = await source();
    expect(html).not.toMatch(/<nav[^>]*data-enhanced/);
    expect(html).toContain('sidebar.dataset.enhanced = "true"');
    expect(html).toMatch(
      /\\.sidebar\\[data-enhanced="true"\\] \\{\\s*display: none;/,
    );
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
