/**
 * @module scaffold
 *
 * Core file-creation logic for create-bascik.
 * Separated from the CLI entry so it can be unit-tested without I/O.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_MD_PATH = fileURLToPath(new URL("../assets/SKILL.md", import.meta.url));

// ─── Root files ───────────────────────────────────────────────────────────────

export const PACKAGE_JSON = (name: string): string =>
  JSON.stringify(
    {
      name,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "bascik",
        build: "bascik --build",
        test: "vitest run",
        "test:watch": "vitest",
        "test:coverage": "vitest run --coverage",
        e2e: "playwright test --config e2e/playwright.config.ts",
      },
      dependencies: {
        "@bascik/bascik": "file:../pkg",
      },
      devDependencies: {
        "@playwright/test": "^1.62.0",
        "@types/node": "^24.0.0",
        "@vitest/coverage-v8": "^4.1.10",
        vitest: "^4.1.10",
      },
    },
    null,
    2,
  ) + "\n";

export const VSCODE_LAUNCH_JSON = JSON.stringify(
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

export const BASCIK_CONFIG = `// Bascik works out of the box — no config required.
// Full reference: https://bascik.dev/configuration
`;

export const VITE_CONFIG = `import { defineConfig } from 'vite';

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
    command: 'npx bascik --build && npx bascik --server --port 8080',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
  },
});
`;

export const E2E_APP_SPEC = `import { test, expect } from '@playwright/test';

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

    const val = page.getByTestId('counter-val').first();
    const decBtn = page.getByTestId('counter-dec').first();
    const incBtn = page.getByTestId('counter-inc').first();

    await expect(val).toHaveText('0');

    await incBtn.click();
    await expect(val).toHaveText('1');

    await decBtn.click();
    await expect(val).toHaveText('0');
  });

  test('mobile navigation toggle expands and collapses menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const toggle = page.getByTestId('nav-toggle').first();
    const menu = page.getByTestId('nav-menu').first();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toHaveClass(/is-open/);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
`;

export const GITIGNORE = `node_modules/
dist/
coverage/
*.pem
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

/* ── Form ── */
.form-group { margin-bottom: 20px; }
.form-group label {
  display: block; font-size: 0.88rem; font-weight: 600;
  color: var(--text); margin-bottom: 6px;
}
.form-group input,
.form-group textarea {
  width: 100%; background: var(--elevated); border: 1px solid var(--border);
  border-radius: var(--r-sm); color: var(--text); font-family: inherit;
  font-size: 0.9rem; padding: 10px 14px; transition: border-color .15s; outline: none;
}
.form-group input:focus,
.form-group textarea:focus { border-color: var(--accent); }
.form-group textarea { min-height: 120px; resize: vertical; }

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

/** Head component — charset, viewport, favicon, CSS link. */
export const SITE_META_HTML = `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="A fast, modern website built with Bascik." />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
<link rel="stylesheet" href="/css/styles.css" />
`;

export const SITE_HEADER_CSS = `.header {
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
<header class="header">
  <div class="container">
    <nav class="nav">
      <a href="/" class="logo" data-bascik-prop-brand>My Site</a>
      <button id="nav-toggle" class="nav-toggle" aria-label="Toggle menu" aria-expanded="false" data-testid="nav-toggle">
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="nav-menu" data-testid="nav-menu">
        <li><a href="/">Home</a></li>
        <li><a href="/about">About</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </nav>
  </div>
</header>
<script>
  var toggle = document.getElementById('nav-toggle');
  var menu = document.getElementById('nav-menu');
  toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') === 'true';
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
<footer class="footer">
  <div class="container">
    <div class="footer-inner">
      <span class="footer-copy">
        &copy; <script data-bascik-build>console.log(new Date().getFullYear())</script>
        <span data-bascik-prop-brand>My Site</span>
      </span>
      <nav class="footer-nav" aria-label="Footer navigation">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
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
.fcard-body h3 { margin: 0 0 6px; font-size: 1rem; color: var(--text); }
.fcard-body p  { margin: 0; font-size: 0.88rem; color: var(--text-muted); }

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
 */
export const FEAT_CARD_HTML = `<style>
${FEAT_CARD_CSS}</style>
<article class="fcard">
  <div class="fcard-header" data-bascik-slot="header"></div>
  <div class="fcard-body" data-bascik-slot></div>
  <div class="fcard-footer" data-bascik-slot="footer"></div>
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

/** Interactive counter — two instances on a page stay fully independent. */
export const MY_COUNTER_HTML = `<style>
${MY_COUNTER_CSS}</style>
<div class="counter">
  <button id="btn-dec" class="btn btn-ghost" data-testid="counter-dec">−</button>
  <span id="count-val" class="count-val" data-testid="counter-val">0</span>
  <button id="btn-inc" class="btn btn-primary" data-testid="counter-inc">+</button>
</div>
<script>
  (function () {
    var count = 0;
    var val = document.getElementById('count-val');
    document.getElementById('btn-dec').addEventListener('click', function () {
      val.textContent = --count;
    });
    document.getElementById('btn-inc').addEventListener('click', function () {
      val.textContent = ++count;
    });
  }());
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

  it('renders brand prop placeholder and build-time year script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('data-bascik-prop-brand');
    expect(html).toContain('data-bascik-build');
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

// ─── Pages ───────────────────────────────────────────────────────────────────

const pageShell = (
  title: string,
  brand: string,
  body: string,
): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${title}</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="${brand}" />
  <main>
${body}
  </main>
  <site-footer data-bascik-prop-brand="${brand}" />
</body>
</html>
`;

export const indexPage = (brand: string): string =>
  pageShell(`Home — ${brand}`, brand, `    <section class="hero">
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
          <feat-card>
            <div data-bascik-slot="header">Zero runtime</div>
            <h3>No framework overhead</h3>
            <p>Components compile at build time. Nothing extra ships to the browser.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>
          <feat-card>
            <div data-bascik-slot="header">Scoped CSS</div>
            <h3>Styles that never leak</h3>
            <p>Each component's class names are automatically namespaced at build time.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>
          <feat-card>
            <div data-bascik-slot="header">Named slots</div>
            <h3>Flexible composition</h3>
            <p>Pass header, body, and footer content into components from the usage site.</p>
            <div data-bascik-slot="footer"><a href="/about" class="btn btn-ghost">Learn more →</a></div>
          </feat-card>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <p class="section-label">Interactive</p>
        <h2>Counter component</h2>
        <p>Each instance holds its own state. Place the same component twice — they stay independent.</p>
        <div style="display:flex;gap:48px;flex-wrap:wrap;margin-top:24px;">
          <my-counter />
          <my-counter />
        </div>
      </div>
    </section>`);

export const aboutPage = (brand: string): string =>
  pageShell(`About — ${brand}`, brand, `    <div class="container">
      <section class="section">
        <p class="section-label">About</p>
        <h1>About us</h1>
        <p class="page-intro">This is the about page. Tell visitors who you are and what you do.</p>

        <div class="grid-2" style="margin-top:32px;">
          <div class="card">
            <h2>Our mission</h2>
            <p>Describe your mission or purpose here. Keep it concise and genuine.</p>
          </div>
          <div class="card">
            <h2>Our approach</h2>
            <p>Explain how you work or what makes you different from others.</p>
          </div>
        </div>

        <div class="callout" style="margin-top:40px;">
          <p>Want to work together? <a href="/contact">Get in touch →</a></p>
        </div>
      </section>
    </div>`);

export const contactPage = (brand: string): string =>
  pageShell(`Contact — ${brand}`, brand, `    <div class="container">
      <section class="section">
        <p class="section-label">Contact</p>
        <h1>Get in touch</h1>
        <p class="page-intro">Have a question or want to work together? Fill out the form below.</p>

        <form style="max-width:520px;" onsubmit="return false;">
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" placeholder="Your name" autocomplete="name" />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div class="form-group">
            <label for="message">Message</label>
            <textarea id="message" name="message" placeholder="How can we help?"></textarea>
          </div>
          <button type="submit" class="btn btn-primary">Send message</button>
        </form>
      </section>
    </div>`);

export const notFoundPage = (brand: string): string =>
  pageShell(`404 — ${brand}`, brand, `    <div class="container">
      <section class="section" style="text-align:center;">
        <p class="section-label">Error</p>
        <h1 style="font-size:clamp(4rem,12vw,8rem);color:var(--accent);margin-bottom:8px;">404</h1>
        <h2 style="margin-bottom:12px;">Page not found</h2>
        <p style="margin-bottom:32px;">The page you're looking for doesn't exist.</p>
        <a href="/" class="btn btn-primary">Go home</a>
      </section>
    </div>`);

// ─── Validation ───────────────────────────────────────────────────────────────

/** Returns an error message if the name is invalid, or null if it is fine. */
export function validateProjectName(name: string): string | null {
  if (!name) return "Project name cannot be empty.";
  if (!/^[a-z0-9@._/-][a-z0-9@._/\- ]*$/i.test(name)) {
    return `"${name}" is not a valid directory name.`;
  }
  return null;
}

// ─── Scaffold ─────────────────────────────────────────────────────────────────

/**
 * Scaffold a new Bascik project into `targetDir/<projectName>`.
 *
 * @param projectName  The name used for the directory and package.json name.
 * @param targetDir    Parent directory in which to create the project (defaults to cwd).
 */
export async function scaffold(
  projectName: string,
  targetDir: string = process.cwd(),
): Promise<void> {
  const root = join(targetDir, projectName);

  // Create all directories up front
  await Promise.all([
    mkdir(join(root, ".vscode"), { recursive: true }),
    mkdir(join(root, ".github", "skills", "bascik"), { recursive: true }),
    mkdir(join(root, ".claude", "skills", "bascik"), { recursive: true }),
    mkdir(join(root, "e2e"), { recursive: true }),
    mkdir(join(root, "src", "pages", "assets"), { recursive: true }),
    mkdir(join(root, "src", "pages", "css"), { recursive: true }),
    mkdir(join(root, "src", "components", "site-meta"), { recursive: true }),
    mkdir(join(root, "src", "components", "site-header"), { recursive: true }),
    mkdir(join(root, "src", "components", "site-footer"), { recursive: true }),
    mkdir(join(root, "src", "components", "feat-card"), { recursive: true }),
    mkdir(join(root, "src", "components", "my-counter"), { recursive: true }),
  ]);

  const skillMd = await readFile(SKILL_MD_PATH, "utf8");

  await Promise.all([
    // Root
    writeFile(join(root, "package.json"), PACKAGE_JSON(projectName), "utf8"),
    writeFile(join(root, "bascik.config.ts"), BASCIK_CONFIG, "utf8"),
    writeFile(join(root, "vite.config.js"), VITE_CONFIG, "utf8"),
    writeFile(join(root, ".gitignore"), GITIGNORE, "utf8"),
    writeFile(join(root, ".vscode", "launch.json"), VSCODE_LAUNCH_JSON, "utf8"),
    writeFile(join(root, ".github", "skills", "bascik", "SKILL.md"), skillMd, "utf8"),
    writeFile(join(root, ".claude", "skills", "bascik", "SKILL.md"), skillMd, "utf8"),

    // E2E
    writeFile(join(root, "e2e", "playwright.config.ts"), PLAYWRIGHT_CONFIG, "utf8"),
    writeFile(join(root, "e2e", "app.spec.ts"), E2E_APP_SPEC, "utf8"),

    // Assets
    writeFile(join(root, "src", "pages", "favicon.ico"), Buffer.from(FAVICON_ICO_B64, "base64")),
    writeFile(join(root, "src", "pages", "assets", "favicon-32x32.png"), Buffer.from(FAVICON_32_PNG_B64, "base64")),
    writeFile(join(root, "src", "pages", "assets", "apple-touch-icon.png"), Buffer.from(APPLE_TOUCH_ICON_PNG_B64, "base64")),
    writeFile(join(root, "src", "pages", "assets", "favicon.svg"), FAVICON_SVG, "utf8"),

    // Global CSS
    writeFile(join(root, "src", "pages", "css", "styles.css"), STYLES_CSS, "utf8"),

    // Pages
    writeFile(join(root, "src", "pages", "index.html"), indexPage(projectName), "utf8"),
    writeFile(join(root, "src", "pages", "about.html"), aboutPage(projectName), "utf8"),
    writeFile(join(root, "src", "pages", "contact.html"), contactPage(projectName), "utf8"),
    writeFile(join(root, "src", "pages", "404.html"), notFoundPage(projectName), "utf8"),

    // Components
    writeFile(join(root, "src", "components", "site-meta", "site-meta.html"), SITE_META_HTML, "utf8"),
    writeFile(join(root, "src", "components", "site-meta", "site-meta.test.ts"), SITE_META_TEST, "utf8"),
    writeFile(join(root, "src", "components", "site-header", "site-header.html"), SITE_HEADER_HTML, "utf8"),
    writeFile(join(root, "src", "components", "site-header", "site-header.test.ts"), SITE_HEADER_TEST, "utf8"),
    writeFile(join(root, "src", "components", "site-footer", "site-footer.html"), SITE_FOOTER_HTML, "utf8"),
    writeFile(join(root, "src", "components", "site-footer", "site-footer.test.ts"), SITE_FOOTER_TEST, "utf8"),
    writeFile(join(root, "src", "components", "feat-card", "feat-card.html"), FEAT_CARD_HTML, "utf8"),
    writeFile(join(root, "src", "components", "feat-card", "feat-card.test.ts"), FEAT_CARD_TEST, "utf8"),
    writeFile(join(root, "src", "components", "my-counter", "my-counter.html"), MY_COUNTER_HTML, "utf8"),
    writeFile(join(root, "src", "components", "my-counter", "my-counter.test.ts"), MY_COUNTER_TEST, "utf8"),
  ]);
}
