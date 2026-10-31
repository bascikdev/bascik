/**
 * @module scaffold
 *
 * Core file-creation logic for create-bascik.
 * Separated from the CLI entry so it can be unit-tested without I/O.
 */

import { lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFilesReportLines, writeAgentFiles } from "./agent-setup.js";
import { vscodeReportLines, writeVscodeFiles } from "./vscode-settings.js";

/**
 * The `@bascik/bascik` release a new project depends on. The agent skills are
 * installed from the same release's tag, so the two always match.
 */
export const BASCIK_VERSION = "1.0.0-rc.10";

// ─── Templates ────────────────────────────────────────────────────────────────

/**
 * The starters create-bascik can scaffold. `default` is the plain static site;
 * `cloudflare` is the same site plus the pieces a Cloudflare Workers deployment
 * needs: the hosting adapter, Wrangler, and a demo page the Worker renders.
 */
export const TEMPLATES = ["default", "cloudflare"] as const;
export type Template = (typeof TEMPLATES)[number];

// ─── Root files ───────────────────────────────────────────────────────────────

/**
 * Wrangler is pinned to a recent minor, not just the major, because workerd
 * rejects a compatibility date newer than itself and the adapter pins a recent one.
 */
const WRANGLER_VERSION = "^4.153.0";

export const PACKAGE_JSON = (
  name: string,
  template: Template = "default",
): string => {
  const cloudflare = template === "cloudflare";
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        engines: {
          node: ">=22.22.0",
        },
        scripts: {
          dev: "bascik",
          build: cloudflare
            ? "bascik --build --target cloudflare"
            : "bascik --build",
          // npm puts node_modules/.bin on PATH, so `wrangler` still resolves after the cd.
          ...(cloudflare && {
            preview: "cd dist/.bascik/cloudflare && wrangler dev",
            deploy: "cd dist/.bascik/cloudflare && wrangler deploy",
          }),
          lint: "bascik --check",
          test: "vitest run",
          "test:watch": "vitest",
          "test:coverage": "vitest run --coverage",
          e2e: "playwright test --config e2e/playwright.config.ts",
        },
        dependencies: {
          "@bascik/bascik": `^${BASCIK_VERSION}`,
        },
        devDependencies: {
          ...(cloudflare && { "@bascik/adapter-cloudflare": "^1.0.0-rc.10" }),
          "@bascik/language-server": "^0.1.0-rc.6",
          "@playwright/test": "^1.62.0",
          "@types/node": "^24.0.0",
          "@vitest/coverage-v8": "^4.1.10",
          vitest: "^4.1.10",
          ...(cloudflare && { wrangler: WRANGLER_VERSION }),
        },
      },
      null,
      2,
    ) + "\n"
  );
};

export {
  VSCODE_EXTENSIONS_JSON,
  VSCODE_SETTINGS_JSON,
} from "./vscode-settings.js";

export const VSCODE_LAUNCH_JSON =
  JSON.stringify(
    {
      version: "0.2.0",
      configurations: [
        {
          name: "Debug Dev Server",
          type: "node",
          request: "launch",
          runtimeExecutable: "npx",
          runtimeArgs: ["bascik"],
          console: "integratedTerminal",
          restart: true,
          skipFiles: ["<node_internals>/**"],
        },
        {
          name: "Debug Unit Tests",
          type: "node",
          request: "launch",
          runtimeExecutable: "npx",
          runtimeArgs: ["vitest", "run"],
          console: "integratedTerminal",
          skipFiles: ["<node_internals>/**"],
        },
        {
          name: "Launch Chrome",
          type: "chrome",
          request: "launch",
          url: "http://localhost:8080",
          webRoot: "${workspaceFolder}",
        },
      ],
    },
    null,
    2,
  ) + "\n";

/** \`vitest/config\`, not \`vite\`: the project depends on vitest, and vite is only vitest's own dependency. */
export const VITE_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
`;

export const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    // Playwright runs the command beside this config; the site is one up.
    cwd: '..',
    command: 'npx bascik --build && npx bascik --server --port 8080',
    // The sitemap and robots.txt need a site URL; this test build points them
    // at the server it runs. The real one comes from BASCIK_SITE_URL or .env.
    env: { BASCIK_SITE_URL: 'http://localhost:8080' },
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
`;

/** The starter's Playwright spec, with room for a template to append its own tests. */
const e2eAppSpec = (
  extraTests = "",
): string => `import { test, expect } from '@playwright/test';

test.describe('Starter App E2E Tests', () => {
  test('navigates pages and checks titles', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Home/);

    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page).toHaveURL('/about');
    await expect(page).toHaveTitle(/About/);
  });

  test('counter component increments and decrements count', async ({ page }) => {
    await page.goto('/');

    const val = page.getByTestId('my-counter-value').first();
    const decBtn = page.getByTestId('my-counter-dec').first();
    const incBtn = page.getByTestId('my-counter-inc').first();

    await expect(val).toHaveText('0');

    await incBtn.click();
    await expect(val).toHaveText('1');

    await decBtn.click();
    await expect(val).toHaveText('0');
  });

  test('mobile navigation toggle expands and collapses menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('site-header-nav-toggle').first();
    const menu = page.getByTestId('site-header-nav-menu').first();

    // Assert what the reader sees, not the class name: the build scopes
    // .is-open (hashed under minify.identifiers), so the element never
    // carries the literal class.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
  });

  test('contact form answers a submit without leaving the page', async ({ page }) => {
    await page.goto('/contact');
    await page.getByTestId('contact-form-name').fill('Ada');
    await page.getByTestId('contact-form-email').fill('ada@example.com');
    await page.getByTestId('contact-form-submit').click();
    await expect(page).toHaveURL('/contact');
    await expect(page.getByTestId('contact-form-status')).toBeVisible();
  });

  test('feature card styles the title and text passed through its slot', async ({ page }) => {
    await page.goto('/');
    // The card's own sizes (1rem, 0.88rem), not the page's h3 and p.
    await expect(page.getByRole('heading', { name: 'No framework overhead' })).toHaveCSS('font-size', '16px');
    await expect(page.getByText('Components compile at build time.')).toHaveCSS('font-size', '14.08px');
  });
${extraTests}});
`;

export const E2E_APP_SPEC = e2eAppSpec();

/** The E2E web server is \`bascik --server\`, which runs server scripts on Node, so the edge page is testable here. */
export const CLOUDFLARE_E2E_APP_SPEC = e2eAppSpec(`
  test('edge page renders the request-time greeting', async ({ page }) => {
    await page.goto('/edge?name=Ada');
    await expect(page).toHaveTitle(/Edge/);
    await expect(page.getByTestId('edge-greeting')).toContainText('Ada');
  });

  test('edge page renders the <feat-card> its server script returns', async ({ page }) => {
    await page.goto('/edge?name=Ada');
    const card = page.getByTestId('edge-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Hello, Ada');
    // The component's scoped CSS reached the browser: .fcard is a flex column.
    await expect(card).toHaveCSS('flex-direction', 'column');
    // The card's title rule reaches the <h3> the script passes through the slot.
    await expect(page.getByTestId('edge-greeting')).toHaveCSS('font-size', '16px');
    const html = await page.content();
    expect(html).not.toContain('<feat-card');
  });
`);

/** \`.env\` files hold the site URL and secrets, and Bascik loads them, so they stay out of git. */
export const GITIGNORE = `node_modules/
dist/
coverage/
*.pem
.env
.env.*
!.env.example
`;

/** Wrangler keeps its local state (workerd cache, dev vars) in `.wrangler/`. */
export const CLOUDFLARE_GITIGNORE = `${GITIGNORE}.wrangler/
`;

// ─── Global CSS ───────────────────────────────────────────────────────────────

export const STYLES_CSS = `/* ── Design system ── */
*, *::before, *::after { box-sizing: border-box; }

:root {
  --bg:           #18191b;
  --surface:      #1e2022;
  --elevated:     #242628;
  --border:       rgba(255,255,255,0.07);
  --border-hover: rgba(211,255,141,0.35);
  --accent:       #d3ff8d;
  --accent-dim:   rgba(211,255,141,0.12);
  --text:         #f0f1f2;
  --text-muted:   #8d929e;
  --mono:         'SF Mono','Fira Code',Menlo,monospace;
  --r:            10px;
  --r-sm:         6px;
}

html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.7;
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

main { flex: 1; }

/* ── Layout ── */
.container { max-width: 1140px; margin: 0 auto; padding: 0 28px; }
.section    { padding: 72px 0; }
.section + .section { border-top: 1px solid var(--border); }

/* ── Typography ── */
h1, h2, h3, h4 { margin-top: 0; line-height: 1.25; font-weight: 700; }
h1 { font-size: clamp(2rem, 5vw, 3.25rem); margin-bottom: 16px; }
h2 { font-size: clamp(1.4rem, 3vw, 2rem);  margin-bottom: 12px; }
h3 { font-size: 1.05rem; margin-bottom: 6px; }
p  { margin-top: 0; color: var(--text-muted); }

a { color: var(--accent); text-decoration: none; transition: opacity .15s; }
a:hover { opacity: 0.8; }
p a, li a { text-decoration: underline; text-underline-offset: 3px; }

code {
  font-family: var(--mono);
  font-size: 0.84em;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px 7px;
  color: var(--accent);
}

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 22px; border: none; border-radius: var(--r-sm);
  font-size: 0.9rem; font-weight: 600; cursor: pointer;
  text-decoration: none; transition: filter .15s, opacity .15s; line-height: 1;
}
.btn-primary { background: var(--accent); color: #18191b; }
.btn-ghost   { background: transparent; color: var(--text); border: 1px solid var(--border); }
@media (hover: hover) {
  .btn-primary:hover { filter: brightness(0.88); opacity: 1; }
  .btn-ghost:hover   { border-color: var(--accent); color: var(--accent); opacity: 1; }
}

/* ── Cards ── */
.card {
  background: var(--elevated); border: 1px solid var(--border);
  border-radius: var(--r); padding: 24px;
  transition: border-color .2s, box-shadow .2s;
}
.card:hover { border-color: var(--border-hover); box-shadow: 0 0 0 1px var(--accent-dim); }
.card h3 { margin-top: 0; }
.card p  { margin-bottom: 0; }

/* ── Grid ── */
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }

/* ── Callout ── */
.callout {
  background: var(--accent-dim); border: 1px solid rgba(211,255,141,0.22);
  border-radius: var(--r); padding: 16px 20px; margin: 20px 0;
}
.callout p { color: var(--text); margin: 0; }

/* ── Hero ── */
.hero { padding: 96px 0 72px; text-align: center; }
.hero h1 span { color: var(--accent); }
.hero > .container > p { font-size: 1.1rem; max-width: 520px; margin: 0 auto 36px; }
.hero-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

/* ── Utilities ── */
.text-accent  { color: var(--accent); }
.text-muted   { color: var(--text-muted); }
.section-label {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .1em; color: var(--accent); margin-bottom: 8px;
}
.page-intro { font-size: 1.05rem; color: var(--text-muted); max-width: 600px; margin-bottom: 40px; }

/* ── Responsive ── */
@media (max-width: 640px) {
  .section { padding: 48px 0; }
  .hero    { padding: 64px 0 48px; }
}
`;

// ─── Components ───────────────────────────────────────────────────────────────

export const FAVICON_SVG = `<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg">
  <polygon points="9,2 30,2 23,30 2,30" fill="#d3ff8d" />
  <rect x="15" y="9" width="2" height="14" rx="1" fill="#0e0f10">
    <animate attributeName="opacity" values="0.9;0.9;0;0" keyTimes="0;0.49;0.5;1" dur="1.1s" repeatCount="indefinite" />
  </rect>
</svg>
`;

export const FAVICON_ICO_B64 = `AAABAAMAEBAAAAEAIADIAAAANgAAACAgAAABACAACAEAAP4AAAAwMAAAAQAgAGcBAAAGAgAiVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAeklEQVQ4jWNgoDa4/L93/uX/vf8J4577OAzouU+cAb3zMTSf/9+vQKTm/xf/9yRgGHDxf08CsqINV8vBGJsBIMsI+r+g3Q+MyfZ/AU4DiPR/AQ4DiPL/ZTwGEOX/yzgNICH+C7C7gPj434AlGon2/2UcmGj/0y/9UwoAAEX+8tkvEHwAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6evQAAAAJcEhZcwAACxMAAAsTAQCanBgAAAC6SURBVFiF7ZbRDYMwDEQzwcEIDFC6QJXf0jEYKBEjMBJCGYBRXNEFepZshaqx5O+8+HQ+h9DqS22yDEWy2HY6Alu7pNkeIK80QJG8WgOcn1IApMMa4JSVenxr+svF9X88bxKnsZ7+6PpPV/M/1ADG/ocSwNz/UAKY+x8qAIf9D90E7Pc/FAAu+x8KAJf9DxrAKf/BT8An/0ECuOU/SAC3/I/TKPF1r6N/4bvdf4OL/oXqpn/6kfv/r+sNLlrC+A4T1ksAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAMAAAADAIBgAAAFcC+YcAAAAJcEhZcwAACxMAAAsTAQCanBgAAAEZSURBVGiB7ZjBDcJADARTAVBCKKKGSwfpgo+PlHDfQDOWSQGpBIwuD/7EVpYIr2Qpr+hGXln2Nk0otL0mzWXSrJii2QGAZhxALqbHsw4t8PEqSskEUH+ABGAdWhNA+F/D/+sV/teY/9vNf3mS0piWerxof/OfxqSH42mpfOv2N//7y/kDUL935//eFSBvv/94Aghi//EEYMT+4wdAmP3fsQMFsv97AQhq//cCYNT+7wNAuPvXqQMFdv96AAjy/vUAYOT9awcgAANi40iAAAn3/00EAB2U7f56m/2eQf30E14yR/0AAAABJRU5ErkJggg==`;

export const FAVICON_32_PNG_B64 = `iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAuklEQVRYhe2W0Q2DMAxEM8HBCAxQukCV39IxGCgRIzASQhmAUVzRBXqWbIWqseTvvPh0PofQ6kttsgxFsth2OgJbu6TZHiCvNECRvFoDnJ9SAKTDGuCUlXp8a/rLxfV/PG8Sp7Ge/uj6T1fzP9QAxv6HEsDc/1ACmPsfKgCH/Q/dBOz3PxQALvsfCgCX/Q8awCn/wU/AJ/9BArjlP0gAt/yP0yjxda+jf+G73X+Di/6F6qZ/+pH7/6/rDS5awvgOE9ZLAAAAAElFTkSuQmCC`;

export const APPLE_TOUCH_ICON_PNG_B64 = `iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGKUlEQVR4nO2bzWqdVRSGN72AtqO0WicWJ1KtoTi0dGjTK8gFGGtnH1ghJpXOw1l0kHoTUvlIU6rQa9Dg2R9W8OcK2guwky0nkIGU0kTfsvZZ63nhnWWwz7ufnTwcSCmEEEIIIYQQQgghhBBCCCGEEEII6SG12Xptsyd0Fm2DrZIxtdlYmzVq0TYYSra0dvfUvM2edTA+bdoNpnZvtWTL4kMDU7zHNG+z54tfViVbFn+WvMen9iY2GEvG4M9hH9RQsgV/jtsJf/a/BGqSDfBnYGrBNsCfO7gE2mQb4M8AZWE2wJ87uARqkg3wZ2CK9pjGkjF8/xy2Q8kWvn+O24nvn/0vgZpkA/wZmKI9prFkDP4ctkPJFvw5bif82f8SqEk2wJ+BKdpjGkvG4M9hO5RswZ/jdsKf/S+BmmQD/BmYoj2msWQM/hy2Q8kW/DluJ/zZ/xKoSTbAn4Ep2mMaS8bgz2E7lGzBn+N2wp/9L4GaZAP8GZiiPaaxZAz+HLZDyRb8OW4n/Nn/EqhJNsCfgSnaYxpLxuDPYTuUbMGf43bCn5evj3/farsPNw77+I9t9/PUToo/L1n3ft1sn3z6YTt95uy/evX65bb3dNP9fNW/+POy9Lufvmzn3l55Ceajnr+w0h4c3HY/Z/Ut/rwM/fnvnfb+6ruvhPmol65cbAcvdtzPW52KPy9Jd/c+ey3MR72/v+F+3upQ/HmJenN77dhAf3Fnzf281af487J0/da1YwO9+Fnv81af4s8dXAJAN81G+HMHoAK0SfbBnzuAFKBNuRH+7A0pQJtyI/zZG1KANtk++HMHkAK0SbbBnzsAFKBNuQ/+7A0oQJtyH/zZG1CANtk2+HMHgAK0SXbBnzuAE6BNuQ3+7A0nQJtyG/zZG04ANtku+HMHcAK0STbBnzsAE6BNuQv+7A0mQJtyF/zZG0yANtkm+HMHYAK0SfbAnzuAEqBNuQn+7A0lQJtyE/zZG0qANtke+HMHUAK0SbbAnzsAEgBNuQf+7A0kQJtyD/zZG0iANtkW+HMHQAK0SXbAnzuAEaBNuQX+7A0jQJtyC/zZG0aANtkO+HMHMAK0STbAnzsAEQBNuQP+7A0iQJtyB/zZG0SANtkG+HMHIAK0ZgP8uQMIAdqUG+DP3hACtCk3wJ+9IQRok22AP3cAIUCbZAP8uQMAAdqUG+DP3gACtCk3wJ+9AQRok22AP3cAIECbZAP8uQP4ANqUG+DP3vABtCk3wJ+94QNok22AP3cAH0CbZAP8uQPwANqUG+DP3uABtCk3wJ+9wQNok22AP3cAHkCbZAP8uQPoANqUG+DP3tABtCk3wJ+9oQNok22AP3cAHUCbZAP8uQPgANqUG+DP3sABtCk3wJ+9gQNok22AP3cAHECbZAP8uQPYANqUG+DP3rABtCk3wJ+9YQNok22AP3cAG0CbZAP8uQPQANqUG+DP3qABtCk3wJ+9QQNok22AP3cAGkCbZAP8uQPIANqUG+DPmXpze62dPnP2WL31zQ3389aTF3/O1N2HG8cG+ttHn7uft56w+HOyHrzYaZeuXHwtzB98/N7hz3qft56g+HPSPji43c5fWHklzG+9c659/8tX7uesJy/+nLV7Tzfb1euXX4L52o2P2v5vX7ufr/634s/Z+8Of2+3+/sZhf/zrjvt56v8o/tzBJVCTbIA/A1O0xzSWjFl88A7Gp02+Af4MWHEe1tTurZZsWXxo7+GpyTfAnwEr2sMaS8bgz2E7lGxp7e6peZs962B82rQb4M9AFeZRzdvs+eKXVcmWxZ8l7/GpvYnW/d2iwC0CBAgAIAAAAAAAAgAAAAAAQIECBAgAIAAAAAAAAgAAAAAAQIECBAgAIAAAAAAAAgAAAAAAQIECBAgAIAAAAAAAAgAAAAAAQIEC`;

/** Head component: charset, viewport, favicon, CSS link. */
export const SITE_META_HTML = `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="A fast, modern website built with Bascik." />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
<link rel="stylesheet" href="/css/styles.css" />
`;

export const SITE_HEADER_CSS = `.skip-link {
  position: absolute;
  left: 16px;
  top: -48px;
  padding: 8px 14px;
  border-radius: var(--r-sm);
  background: var(--accent);
  color: #18191b;
  font-weight: 600;
  z-index: 200;
}
.skip-link:focus { top: 8px; }

.header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(24, 25, 27, 0.9);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}

.container { max-width: 1140px; margin: 0 auto; padding: 0 28px; }

.nav {
  display: flex;
  align-items: center;
  height: 60px;
  gap: 24px;
}

.logo {
  font-weight: 700;
  font-size: 1rem;
  color: var(--text);
  letter-spacing: -0.01em;
  flex-shrink: 0;
}
.logo:hover { opacity: 0.8; }

.nav-menu {
  list-style: none;
  margin: 0 0 0 auto;
  padding: 0;
  display: flex;
  gap: 4px;
}
.nav-menu a {
  display: block;
  padding: 6px 12px;
  font-size: 0.9rem;
  color: var(--text-muted);
  border-radius: var(--r-sm);
  transition: color .15s, background .15s;
}
.nav-menu a:hover { color: var(--text); background: var(--elevated); opacity: 1; }

.nav-toggle {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 36px;
  height: 36px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px;
  margin-left: auto;
  border-radius: var(--r-sm);
}
.nav-toggle span {
  display: block;
  height: 2px;
  background: var(--text);
  border-radius: 2px;
}

@media (max-width: 640px) {
  .nav-toggle { display: flex; }

  .nav-menu {
    display: none;
    position: absolute;
    top: 60px;
    left: 0;
    right: 0;
    flex-direction: column;
    gap: 0;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 8px 16px;
  }
  .nav-menu.is-open { display: flex; }
  .nav-menu li { width: 100%; }
  .nav-menu a { padding: 10px 4px; }
}
`;

/** Sticky top nav with logo (brand prop) and mobile hamburger. */
export const SITE_HEADER_HTML = `<style>
${SITE_HEADER_CSS}</style>
<header class="header" data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav class="nav" aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-bascik-prop-brand data-testid="site-header-logo">My Site</a>
      <button id="nav-toggle" type="button" class="nav-toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle">
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="nav-menu" data-testid="site-header-nav-menu">
        <li><a href="/" data-testid="site-header-home">Home</a></li>
        <li><a href="/about" data-testid="site-header-about">About</a></li>
        <li><a href="/contact" data-testid="site-header-contact">Contact</a></li>
      </ul>
    </nav>
  </div>
</header>
<script type="text/typescript">
  const toggle = document.getElementById('nav-toggle') as HTMLButtonElement;
  const menu = document.getElementById('nav-menu') as HTMLUListElement;
  toggle.addEventListener('click', (): void => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    menu.classList.toggle('is-open');
  });
</script>
`;

export const SITE_FOOTER_CSS = `.footer {
  border-top: 1px solid var(--border);
  padding: 28px 0;
}

.container { max-width: 1140px; margin: 0 auto; padding: 0 28px; }

.footer-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.footer-copy { font-size: 0.85rem; color: var(--text-muted); }

.footer-nav {
  display: flex;
  gap: 20px;
}
.footer-nav a {
  font-size: 0.85rem;
  color: var(--text-muted);
}
.footer-nav a:hover { color: var(--text); opacity: 1; }

@media (max-width: 480px) {
  .footer-inner { flex-direction: column; align-items: flex-start; }
}
`;

/** Footer with brand prop and build-time year. */
export const SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer class="footer" data-testid="site-footer">
  <div class="container">
    <div class="footer-inner">
      <span class="footer-copy">
        &copy; <script data-bascik-build-once type="text/typescript">export default (): string => String(new Date().getFullYear());</script>
        <span data-bascik-prop-brand>My Site</span>
      </span>
      <nav class="footer-nav" aria-label="Footer navigation" data-testid="site-footer-nav">
        <a href="/" data-testid="site-footer-home">Home</a>
        <a href="/about" data-testid="site-footer-about">About</a>
        <a href="/contact" data-testid="site-footer-contact">Contact</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const FEAT_CARD_CSS = `.fcard {
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color .2s, box-shadow .2s, transform .2s;
}
.fcard:hover {
  border-color: var(--border-hover);
  box-shadow: 0 0 0 1px var(--accent-dim), 0 8px 32px rgba(0,0,0,0.3);
  transform: translateY(-2px);
}

.fcard-header {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--accent);
}
.fcard-header:empty { display: none; }

.fcard-body { flex: 1; }
/* The h3 and p arrive through the slot from the usage site. Scoping turns a
   bare element selector into a class only this template's own elements get;
   an element name inside :is() is left as written, so these match. */
.fcard-body :is(h2, h3) { margin: 0 0 6px; font-size: 1rem; color: var(--text); }
.fcard-body :is(p) { margin: 0; font-size: 0.88rem; color: var(--text-muted); }

.fcard-footer {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
.fcard-footer:empty { display: none; }
`;

/**
 * Card component demonstrating named slots.
 * Slots: header (label/icon area), default (title + body), footer (actions).
 * A slot marker is replaced by the slot content, its own tag and classes
 * included, so each styled zone wraps its marker instead of carrying it.
 * An unfilled slot leaves its zone empty, and `:empty` hides it.
 */
export const FEAT_CARD_HTML = `<style>
${FEAT_CARD_CSS}</style>
<article class="fcard" data-testid="feat-card">
  <div class="fcard-header"><div data-bascik-slot="header"></div></div>
  <div class="fcard-body"><div data-bascik-slot></div></div>
  <div class="fcard-footer"><div data-bascik-slot="footer"></div></div>
</article>
`;

export const MY_COUNTER_CSS = `.counter {
  display: inline-flex;
  align-items: center;
  gap: 16px;
  font-size: 1.25rem;
}

.count-val {
  font-family: var(--mono);
  font-size: 1.5rem;
  min-width: 2ch;
  text-align: center;
  color: var(--accent);
}

.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 22px; border: none; border-radius: var(--r-sm);
  font-size: 0.9rem; font-weight: 600; cursor: pointer;
  text-decoration: none; transition: filter .15s, opacity .15s; line-height: 1;
}
.btn-primary { background: var(--accent); color: #18191b; }
.btn-ghost   { background: transparent; color: var(--text); border: 1px solid var(--border); }
@media (hover: hover) {
  .btn-primary:hover { filter: brightness(0.88); opacity: 1; }
  .btn-ghost:hover   { border-color: var(--accent); color: var(--accent); opacity: 1; }
}
`;

/** Interactive counter: two instances on a page stay fully independent. */
export const MY_COUNTER_HTML = `<style>
${MY_COUNTER_CSS}</style>
<div class="counter" role="group" aria-label="Counter" data-testid="my-counter">
  <button id="btn-dec" type="button" class="btn btn-ghost" aria-label="Decrease" data-testid="my-counter-dec">−</button>
  <output id="count-val" class="count-val" aria-live="polite" data-testid="my-counter-value">0</output>
  <button id="btn-inc" type="button" class="btn btn-primary" aria-label="Increase" data-testid="my-counter-inc">+</button>
</div>
<script type="text/typescript">
  // Each instance runs this with its own ids, so two counters keep their own count.
  let count: number = 0;
  const val = document.getElementById('count-val') as HTMLOutputElement;
  const show = (next: number): void => {
    count = next;
    val.textContent = String(count);
  };
  document.getElementById('btn-dec')!.addEventListener('click', () => show(count - 1));
  document.getElementById('btn-inc')!.addEventListener('click', () => show(count + 1));
</script>
`;

export const CONTACT_FORM_CSS = `.form { max-width: 520px; }

.field { margin-bottom: 20px; }
.field label {
  display: block; font-size: 0.88rem; font-weight: 600;
  color: var(--text); margin-bottom: 6px;
}
.field input,
.field textarea {
  width: 100%; background: var(--elevated); border: 1px solid var(--border);
  border-radius: var(--r-sm); color: var(--text); font-family: inherit;
  font-size: 0.9rem; padding: 10px 14px; transition: border-color .15s; outline: none;
}
.field input:focus,
.field textarea:focus { border-color: var(--accent); }
.field textarea { min-height: 120px; resize: vertical; }

.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 22px; border: none; border-radius: var(--r-sm);
  font-size: 0.9rem; font-weight: 600; cursor: pointer;
  line-height: 1; transition: filter .15s;
  background: var(--accent); color: #18191b;
}
@media (hover: hover) {
  .btn:hover { filter: brightness(0.88); }
}

.status { margin: 16px 0 0; color: var(--accent); }
`;

/**
 * Contact form. The starter has no backend, so submitting shows a note in
 * place of sending: connect the form to your own endpoint in its script.
 * Field names ship as written, so `new FormData(form)` has the keys name,
 * email and message.
 */
export const CONTACT_FORM_HTML = `<style>
${CONTACT_FORM_CSS}</style>
<form id="contact-form" class="form" data-testid="contact-form">
  <div class="field">
    <label for="name">Name</label>
    <input type="text" id="name" name="name" placeholder="Your name" autocomplete="name" data-testid="contact-form-name" />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" data-testid="contact-form-email" />
  </div>
  <div class="field">
    <label for="message">Message</label>
    <textarea id="message" name="message" placeholder="How can we help?" data-testid="contact-form-message"></textarea>
  </div>
  <button type="submit" class="btn" data-testid="contact-form-submit">Send message</button>
  <p id="contact-status" class="status" role="status" data-testid="contact-form-status" hidden></p>
</form>
<script type="text/typescript">
  const form = document.getElementById('contact-form') as HTMLFormElement;
  const status = document.getElementById('contact-status') as HTMLParagraphElement;
  form.addEventListener('submit', (event: SubmitEvent): void => {
    // Nothing receives the form yet: send it to your own endpoint here.
    event.preventDefault();
    status.textContent = 'Thanks! This starter form does not send anything yet.';
    status.hidden = false;
  });
</script>
`;

// ─── Component Tests ──────────────────────────────────────────────────────────

export const SITE_META_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-meta component', () => {
  const path = join(process.cwd(), 'src/components/site-meta/site-meta.html');

  it('contains charset, viewport, favicon, and stylesheet link tags', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="description"');
    expect(html).toContain('favicon.ico');
    expect(html).toContain('favicon-32x32.png');
    expect(html).toContain('favicon.svg');
    expect(html).toContain('apple-touch-icon.png');
    expect(html).toContain('styles.css');
  });
});
`;

export const SITE_HEADER_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-header component', () => {
  const path = join(process.cwd(), 'src/components/site-header/site-header.html');

  it('renders brand prop placeholder and navigation links', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('data-bascik-prop-brand');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/contact"');
    expect(html).toContain('id="nav-toggle"');
  });
});
`;

export const SITE_FOOTER_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-footer component', () => {
  const path = join(process.cwd(), 'src/components/site-footer/site-footer.html');

  it('renders brand prop placeholder and build-once year script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('data-bascik-prop-brand');
    expect(html).toContain('data-bascik-build-once');
    expect(html).toContain('getFullYear');
  });
});
`;

export const FEAT_CARD_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('feat-card component', () => {
  const path = join(process.cwd(), 'src/components/feat-card/feat-card.html');

  it('defines header, default, and footer slots', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('data-bascik-slot="header"');
    expect(html).toContain('data-bascik-slot');
    expect(html).toContain('data-bascik-slot="footer"');
  });
});
`;

export const MY_COUNTER_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('my-counter component', () => {
  const path = join(process.cwd(), 'src/components/my-counter/my-counter.html');

  it('renders increment and decrement controls with scoped script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('id="btn-dec"');
    expect(html).toContain('id="btn-inc"');
    expect(html).toContain('id="count-val"');
    expect(html).toContain('addEventListener');
  });
});
`;

export const CONTACT_FORM_TEST = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('contact-form component', () => {
  const path = join(process.cwd(), 'src/components/contact-form/contact-form.html');

  it('labels every field and handles submit in a TypeScript script', async () => {
    const html = await readFile(path, 'utf8');
    for (const id of ['name', 'email', 'message']) {
      expect(html).toContain(\`for="\${id}"\`);
      expect(html).toContain(\`id="\${id}"\`);
    }
    expect(html).toContain('data-testid="contact-form-submit"');
    expect(html).toContain('<script type="text/typescript">');
    expect(html).toContain('preventDefault');
  });
});
`;

// ─── Pages ───────────────────────────────────────────────────────────────────

const pageShell = (
  title: string,
  brand: string,
  body: string,
  page: string,
): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${title}</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="${brand}" />
  <main id="main" data-testid="${page}-main">
${body}
  </main>
  <site-footer data-bascik-prop-brand="${brand}" />
</body>
</html>
`;

/** The extra feature card the Cloudflare template adds, linking to the page the Worker renders. */
const EDGE_FEAT_CARD = `
          <feat-card data-testid="feature-edge">
            <div data-bascik-slot="header">Edge</div>
            <h3>Rendered per request</h3>
            <p>Server scripts and API routes run in a Cloudflare Worker. Static pages stay on the CDN.</p>
            <div data-bascik-slot="footer"><a href="/edge" class="btn btn-ghost">See it run →</a></div>
          </feat-card>`;

export const indexPage = (
  brand: string,
  options: { template?: Template } = {},
): string =>
  pageShell(
    `Home - ${brand}`,
    brand,
    `    <section class="hero">
      <div class="container">
        <p class="section-label">Welcome</p>
        <h1>Build fast with <span>${brand}</span></h1>
        <p>A Bascik site. HTML components, scoped CSS, and zero runtime overhead.</p>
        <div class="hero-actions">
          <a href="/about" class="btn btn-primary">About</a>
          <a href="/contact" class="btn btn-ghost">Contact</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <p class="section-label">Features</p>
        <h2>Why Bascik</h2>
        <p>Each card below is a <code>&lt;feat-card&gt;</code> component with three named slots: <code>header</code>, default, and <code>footer</code>.</p>
        <div class="grid-3" style="margin-top:28px;">
          <feat-card data-testid="feature-zero-runtime">
            <div data-bascik-slot="header">Zero runtime</div>
            <h3>No framework overhead</h3>
            <p>Components compile at build time. Nothing extra ships to the browser.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>
          <feat-card data-testid="feature-scoped-css">
            <div data-bascik-slot="header">Scoped CSS</div>
            <h3>Styles that never leak</h3>
            <p>Each component's class names are automatically namespaced at build time.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>
          <feat-card data-testid="feature-named-slots">
            <div data-bascik-slot="header">Named slots</div>
            <h3>Flexible composition</h3>
            <p>Pass header, body, and footer content into components from the usage site.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>${options.template === "cloudflare" ? EDGE_FEAT_CARD : ""}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <p class="section-label">Interactive</p>
        <h2>Counter component</h2>
        <p>Each instance holds its own state. Place the same component twice, and they stay independent.</p>
        <div style="display:flex;gap:48px;flex-wrap:wrap;margin-top:24px;">
          <my-counter />
          <my-counter />
        </div>
      </div>
    </section>`,
    "home",
  );

export const aboutPage = (brand: string): string =>
  pageShell(
    `About - ${brand}`,
    brand,
    `    <div class="container">
      <section class="section">
        <p class="section-label">About</p>
        <h1>About us</h1>
        <p class="page-intro">This is the about page. Tell visitors who you are and what you do.</p>

        <div class="grid-2" style="margin-top:32px;">
          <feat-card data-testid="about-mission">
            <div data-bascik-slot="header">Mission</div>
            <h2>Our mission</h2>
            <p>Describe your mission or purpose here. Keep it concise and genuine.</p>
          </feat-card>
          <feat-card data-testid="about-approach">
            <div data-bascik-slot="header">Approach</div>
            <h2>Our approach</h2>
            <p>Explain how you work or what makes you different from others.</p>
          </feat-card>
        </div>

        <div class="callout" style="margin-top:40px;">
          <p>Want to work together? <a href="/contact">Get in touch →</a></p>
        </div>
      </section>
    </div>`,
    "about",
  );

export const contactPage = (brand: string): string =>
  pageShell(
    `Contact - ${brand}`,
    brand,
    `    <div class="container">
      <section class="section">
        <p class="section-label">Contact</p>
        <h1>Get in touch</h1>
        <p class="page-intro">Have a question or want to work together? Fill out the form below.</p>

        <contact-form />
      </section>
    </div>`,
    "contact",
  );

export const notFoundPage = (brand: string): string =>
  pageShell(
    `404 - ${brand}`,
    brand,
    `    <div class="container">
      <section class="section" style="text-align:center;">
        <p class="section-label">Error</p>
        <p style="font-size:clamp(4rem,12vw,8rem);font-weight:800;line-height:1;color:var(--accent);margin-bottom:8px;">404</p>
        <h1 style="margin-bottom:12px;">Page not found</h1>
        <p style="margin-bottom:32px;">The page you're looking for doesn't exist.</p>
        <a href="/" class="btn btn-primary">Go home</a>
      </section>
    </div>`,
    "404",
  );

// ─── Cloudflare template ──────────────────────────────────────────────────────

/**
 * A page with a `data-bascik-server` script. The Cloudflare adapter keeps it out
 * of `public/` and renders it in the Worker on every request; `bascik --server`
 * renders it on Node. The script returns the starter's `<feat-card>` around its
 * greeting, and the host renders that tag into the component's markup and
 * scoped CSS per request: this page does not use the card in its own markup.
 * The script builds its markup with `html` from @bascik/bascik/html, which
 * escapes the query parameter for where it lands.
 */
export const edgePage = (brand: string): string =>
  pageShell(
    `Edge - ${brand}`,
    brand,
    `    <div class="container">
      <section class="section">
        <p class="section-label">Edge</p>
        <h1>Rendered per request</h1>
        <p class="page-intro">The card below comes from a <code>&lt;script data-bascik-server&gt;</code> block. It runs on every request, so the time changes on reload and <a href="/edge?name=Ada">?name=Ada</a> changes the greeting. The script returns a <code>&lt;feat-card&gt;</code> tag, and the server renders it into the component, scoped CSS included.</p>

        <h2 style="margin-top:28px;">Your greeting</h2>
        <div style="max-width:520px;margin-top:16px;">
          <script data-bascik-server type="text/typescript">
            import { html } from "@bascik/bascik/html";

            export default function (request: Request): string {
              // Query parameters are untrusted: html escapes each value for where it lands.
              const name = new URL(request.url).searchParams.get("name") ?? "visitor";
              return html\`<feat-card data-testid="edge-card">
                <div data-bascik-slot="header">Server script</div>
                <h3 data-testid="edge-greeting">Hello, \${name}</h3>
                <p>Rendered at <code>\${new Date().toISOString()}</code></p>
                <div data-bascik-slot="footer"><a href="/edge" class="btn btn-ghost">Reload →</a></div>
              </feat-card>\`;
            }
          </script>
        </div>

        <div class="callout" style="margin-top:40px;">
          <p>The same Worker answers <a href="/api/hello">/api/hello</a>, an API route in <code>src/api/hello.ts</code>.</p>
        </div>
      </section>
    </div>`,
    "edge",
  );

/**
 * An API route served at /api/hello. \`context.platform\` names the host, so the
 * same handler answers "cloudflare" from the Worker and "node" from \`bascik --server\`.
 */
export const HELLO_API_ROUTE = `export const GET = async (
  request: Request,
  context: { remoteIp: string; platform?: { name: string } },
): Promise<Response> =>
  Response.json({
    hello: new URL(request.url).searchParams.get("name") ?? "world",
    platform: context.platform?.name ?? "unknown",
  });
`;

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns an error message if the name is invalid, or null if it is fine.
 *
 * The name is a new folder under the current directory: one name, or a relative
 * path such as `sites/my-site` whose last segment names the site. `.`, `..`, an
 * absolute path and whitespace are refused, because the folder would be the
 * current or a parent directory, would not be where the printed `cd` points, or
 * would not be a valid npm package name.
 */
export function validateProjectName(name: string): string | null {
  if (!name) return "Project name cannot be empty.";
  if (!/^[a-z0-9@._/\- ]+$/i.test(name)) {
    return `"${name}" is not a valid directory name.`;
  }
  if (name.includes(" ")) {
    return `"${name}" contains a space. Use dashes instead, such as "${name.trim().replace(/ +/g, () => "-")}".`;
  }
  if (name.startsWith("/")) {
    return `"${name}" is an absolute path. Run create-bascik in the parent folder and pass only the new folder's name.`;
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `"${name}" names the current or a parent folder with "." or "..". create-bascik writes a new folder; to add Bascik to an existing project, see ${MANUAL_SETUP_URL}`;
  }
  if (segments.some((segment) => segment === "")) {
    return `"${name}" has an empty path segment. Remove the extra "/".`;
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return `"${name}" starts a folder name with ".", which hides the folder and is not a valid npm package name.`;
  }
  return null;
}

/** Where the docs explain adding Bascik to a project that already exists. */
export const MANUAL_SETUP_URL =
  "https://bascik.dev/getting-started#manual-setup";

/**
 * The site's name: the last segment of the project name, which is the folder
 * the starter is written to. It is the brand on the pages.
 */
export const siteNameOf = (projectName: string): string =>
  projectName.split("/").pop() ?? projectName;

/**
 * The package.json name for a project name: npm wants it lowercase and without
 * a leading `_`. A scoped `@scope/name` stays scoped; a nested path such as
 * `sites/my-site` uses its last segment.
 */
export const packageNameOf = (projectName: string): string => {
  const name = /^@[^/]+\/[^/]+$/.test(projectName)
    ? projectName
    : siteNameOf(projectName);
  return name.toLowerCase().replace(/^_+/, () => "") || "bascik-app";
};

// ─── Scaffold ─────────────────────────────────────────────────────────────────

/**
 * Scaffold a new Bascik project into `targetDir/<projectName>`.
 *
 * @param projectName  The folder to create, relative to `targetDir` (see `validateProjectName`).
 *                     Its last segment names the site and, lowercased, the package.
 * @param targetDir    Parent directory in which to create the project (defaults to cwd).
 * @param options      `template` picks the starter (defaults to the static `default`).
 */
export async function scaffold(
  projectName: string,
  targetDir: string = process.cwd(),
  options: { template?: Template } = {},
): Promise<ScaffoldResult> {
  const root = join(targetDir, projectName);
  const siteName = siteNameOf(projectName);
  const template = options.template ?? "default";
  const notes: string[] = [];

  const dirs = starterDirectories(template);
  const files = starterFiles(siteName, packageNameOf(projectName), template);

  // Nothing is written when the folder already holds a file the starter would replace.
  await assertScaffoldTarget(projectName, root, dirs, files);

  // Create all directories up front
  await Promise.all(
    dirs.map((dir) =>
      mkdir(join(root, ...dir.split("/")), { recursive: true }),
    ),
  );

  await Promise.all([
    // Coding assistants: merged into an AGENTS.md or CLAUDE.md the folder already has.
    // The agent skills are installed afterwards by the CLI, with the skills CLI.
    writeAgentFiles(root, { template }).then((report) => {
      notes.push(...agentFilesReportLines(report));
    }),

    // Editor: merged into any .vscode files the folder already has, never replaced
    writeVscodeFiles(root).then(async (report) => {
      notes.push(...vscodeReportLines(report));
      if (!(await writeLaunchJsonIfAbsent(root))) {
        notes.push(".vscode/launch.json: could not be written.");
      }
    }),

    // Everything else is the starter's own and is new.
    ...files.map(([path, data]) =>
      typeof data === "string"
        ? writeFile(join(root, ...path.split("/")), data, "utf8")
        : writeFile(join(root, ...path.split("/")), data),
    ),
  ]);

  return { notes };
}

/** The folders the starter creates, relative to the project root, with `/` separators. */
const starterDirectories = (template: Template): string[] => [
  "e2e",
  ...(template === "cloudflare" ? ["src/api"] : []),
  "src/pages/assets",
  "src/pages/css",
  "src/components/site-meta",
  "src/components/site-header",
  "src/components/site-footer",
  "src/components/feat-card",
  "src/components/my-counter",
  "src/components/contact-form",
];

/**
 * The files the starter writes as its own, relative to the project root. AGENTS.md,
 * CLAUDE.md and the .vscode files are not here: they are merged into what the folder has.
 */
const starterFiles = (
  siteName: string,
  packageName: string,
  template: Template,
): Array<[path: string, data: string | Buffer]> => {
  const cloudflare = template === "cloudflare";
  return [
    // Root
    ["package.json", PACKAGE_JSON(packageName, template)],
    ["vite.config.js", VITE_CONFIG],
    [".gitignore", cloudflare ? CLOUDFLARE_GITIGNORE : GITIGNORE],

    // E2E
    ["e2e/playwright.config.ts", PLAYWRIGHT_CONFIG],
    ["e2e/app.spec.ts", cloudflare ? CLOUDFLARE_E2E_APP_SPEC : E2E_APP_SPEC],

    // Assets
    ["src/pages/favicon.ico", Buffer.from(FAVICON_ICO_B64, "base64")],
    [
      "src/pages/assets/favicon-32x32.png",
      Buffer.from(FAVICON_32_PNG_B64, "base64"),
    ],
    [
      "src/pages/assets/apple-touch-icon.png",
      Buffer.from(APPLE_TOUCH_ICON_PNG_B64, "base64"),
    ],
    ["src/pages/assets/favicon.svg", FAVICON_SVG],

    // Global CSS
    ["src/pages/css/styles.css", STYLES_CSS],

    // Pages
    ["src/pages/index.html", indexPage(siteName, { template })],
    ["src/pages/about.html", aboutPage(siteName)],
    ["src/pages/contact.html", contactPage(siteName)],
    ["src/pages/404.html", notFoundPage(siteName)],

    // Cloudflare template: the edge demo page and its API route
    ...(cloudflare
      ? ([
          ["src/pages/edge.html", edgePage(siteName)],
          ["src/api/hello.ts", HELLO_API_ROUTE],
        ] as Array<[string, string]>)
      : []),

    // Components
    ["src/components/site-meta/site-meta.html", SITE_META_HTML],
    ["src/components/site-meta/site-meta.test.ts", SITE_META_TEST],
    ["src/components/site-header/site-header.html", SITE_HEADER_HTML],
    ["src/components/site-header/site-header.test.ts", SITE_HEADER_TEST],
    ["src/components/site-footer/site-footer.html", SITE_FOOTER_HTML],
    ["src/components/site-footer/site-footer.test.ts", SITE_FOOTER_TEST],
    ["src/components/feat-card/feat-card.html", FEAT_CARD_HTML],
    ["src/components/feat-card/feat-card.test.ts", FEAT_CARD_TEST],
    ["src/components/my-counter/my-counter.html", MY_COUNTER_HTML],
    ["src/components/my-counter/my-counter.test.ts", MY_COUNTER_TEST],
    ["src/components/contact-form/contact-form.html", CONTACT_FORM_HTML],
    ["src/components/contact-form/contact-form.test.ts", CONTACT_FORM_TEST],
  ];
};

/** Thrown before anything is written when the target folder cannot take the starter. */
export class ScaffoldTargetError extends Error {
  override name = "ScaffoldTargetError";
}

/** The file's type, or null when nothing is there (including when a parent is a file). */
const entryAt = async (path: string): Promise<"directory" | "other" | null> => {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // A dangling symlink is still in the way of a new file.
      try {
        await lstat(path);
        return "other";
      } catch {
        return null;
      }
    }
    throw err;
  }
};

/**
 * Refuse a target that cannot take the starter without losing something: a file
 * where the project folder goes, or a project folder that already has one of the
 * starter's own files (or a file where one of its folders goes). A folder that
 * holds only files the starter merges into, such as AGENTS.md or .vscode/, is fine.
 */
async function assertScaffoldTarget(
  projectName: string,
  root: string,
  dirs: string[],
  files: Array<[path: string, data: string | Buffer]>,
): Promise<void> {
  const rootEntry = await entryAt(root);
  if (rootEntry === null) return;
  if (rootEntry !== "directory") {
    throw new ScaffoldTargetError(
      `"${projectName}" already exists and is not a folder. Choose another project name.`,
    );
  }
  const found = await Promise.all([
    ...dirs.map(async (dir) =>
      (await entryAt(join(root, ...dir.split("/")))) === "other" ? dir : null,
    ),
    ...files.map(async ([path]) =>
      (await entryAt(join(root, ...path.split("/")))) === null ? null : path,
    ),
  ]);
  const conflicts = found.filter((path): path is string => path !== null);
  if (conflicts.length === 0) return;
  const shown = conflicts.slice(0, 5).join(", ");
  const more = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "";
  throw new ScaffoldTargetError(
    `"${projectName}" already has ${shown}${more}, which the starter would replace. ` +
      `Nothing was written. create-bascik makes new projects: choose another name, ` +
      `or to add Bascik to an existing project see ${MANUAL_SETUP_URL}`,
  );
}

/** What `scaffold` wants the user to know, such as a file it could not merge. */
export interface ScaffoldResult {
  notes: string[];
}

/**
 * Write launch.json unless the folder already has one, which stays as it is.
 * Returns false when it could not be written, such as when `.vscode` is a file.
 */
async function writeLaunchJsonIfAbsent(root: string): Promise<boolean> {
  try {
    await writeFile(join(root, ".vscode", "launch.json"), VSCODE_LAUNCH_JSON, {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EEXIST";
  }
}
