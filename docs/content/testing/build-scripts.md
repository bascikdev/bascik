# Testing Build Scripts

Build-time scripts (`<script data-bascik-build>`) run in Node.js during compilation to generate static HTML, render Markdown content, compute canonical metadata, or fetch remote data before pages are written to `dist/`. To make build scripts testable and maintainable, separate business logic and data transformations into pure exported TypeScript modules.

## Architecture & Module Separation

Keep `<script data-bascik-build>` blocks inside your `.html` files thin by delegating complex logic, file reading, and data fetching to helper modules in `src/lib/` or alongside your components:

```text
src/
  lib/
    canonical.ts              ← page-aware helper (reads BASCIK_SOURCE_FILE or BASCIK_PAGE_FILE)
    canonical.test.ts         ← Vitest unit tests with mocked environment variables
    md-renderer.ts            ← Markdown rendering helper
    md-renderer.test.ts       ← Vitest unit tests
  pages/
    index.html                ← template using <script data-bascik-build>
```

By extracting logic into standalone TypeScript files, test runners execute tests directly against source code without needing to invoke the full Bascik compiler for every assertion.

## Testing Pure Build Helpers

Build helpers that transform local data files, parse Markdown, or generate navigation menus can be tested with Vitest as pure functions.

### 1. Pure Helper Module (`src/lib/nav-generator.ts`)

```ts
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface NavItem {
  href: string;
  label: string;
}

export function generateNavList(
  items: NavItem[],
  activeHref?: string,
): SafeHtml {
  if (!items.length) return html``;

  const links = items.map(({ href, label }) => {
    // A hole cannot add an attribute, so the current link is its own template.
    const link =
      href === activeHref
        ? html`<a href="${href}" aria-current="page">${label}</a>`
        : html`<a href="${href}">${label}</a>`;
    return html`<li>${link}</li>`;
  });

  return html`<ul class="site-nav">
    ${links}
  </ul>`;
}
```

### 2. Build Script Usage (`src/pages/index.html`)

```html
<!-- src/pages/index.html -->
<nav>
  <script data-bascik-build>
    import { readFile } from "node:fs/promises";
    import { generateNavList } from "../lib/nav-generator.ts";

    export default async function () {
      const items = JSON.parse(await readFile("./src/data/nav.json", "utf8"));
      return generateNavList(items, "/");
    }
  </script>
</nav>
```

### 3. Unit Test (`src/lib/nav-generator.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { generateNavList } from "./nav-generator.ts";

describe("generateNavList", () => {
  const sampleNav = [
    { href: "/", label: "Home" },
    { href: "/docs", label: "Docs" },
    { href: "/about", label: "About" },
  ];

  it("generates an accessible navigation list with active page indicators", () => {
    // An html value is an object: String() gives the markup.
    const html = String(generateNavList(sampleNav, "/docs"));

    expect(html).toContain('<ul class="site-nav">');
    expect(html).toContain(
      '<li><a href="/docs" aria-current="page">Docs</a></li>',
    );
    expect(html).toContain('<li><a href="/">Home</a></li>');
  });

  it("returns empty markup when no navigation items are provided", () => {
    expect(String(generateNavList([]))).toBe("");
  });

  it("escapes labels and blocks a javascript: link from the data", () => {
    const html = String(
      generateNavList([{ href: "javascript:alert(1)", label: "<b>Hi</b>" }]),
    );
    expect(html).toContain('href="about:invalid"');
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
  });
});
```

## Testing Page-Aware Build Scripts

Bascik injects environment variables into every `data-bascik-build` execution subprocess:

| Variable             | Value                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| `BASCIK_PAGE_PATH`   | Normalized root-relative route path of the page shell (e.g. `/getting-started`, `/`) |
| `BASCIK_SOURCE_FILE` | Absolute path to the file currently being transpiled (page or component template)    |
| `BASCIK_PAGE_FILE`   | Absolute path to the HTML page currently being compiled                              |
| `BASCIK_PAGES_DIR`   | Absolute path to the configured pages directory                                      |
| `BASCIK_SITE_URL`    | The site URL from `--site-url`, the environment, or `.env`; absent when unset        |
| `BASCIK_BASE`        | The normalized deployment base (`base` in the config, `/` by default)                |
| `BASCIK_ROUTE`       | The dynamic route object as JSON, on pages generated from a bracket template         |

Page-aware helpers derive canonical tags, Open Graph metadata, breadcrumbs, and schema markup from these variables.

### Testing Canonical URL Generation

Test page-aware functions in Vitest by setting `process.env` values in test cases and restoring original values afterwards:

```ts
// src/lib/canonical.ts
import { html, type SafeHtml } from "@bascik/bascik/html";

export function getCanonicalUrl(): SafeHtml | "" {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? "").replace(/\/$/, "");
  const pageFile =
    process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? "";
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? "";

  if (!siteUrl || !pageFile || !pagesDir) return "";

  const relPath = pageFile
    .slice(pagesDir.length)
    .replace(/^[\\/]/, "")
    .replace(/\\/g, "/");

  const withoutExt = relPath.replace(/\.html$/, "");
  const route =
    withoutExt === "index" ? "" : withoutExt.replace(/\/index$/, "/");
  const urlPath = route ? `/${route}` : "/";

  // One hole per URL attribute: html refuses two side by side.
  const href = `${siteUrl}${urlPath}`;
  return html`<link rel="canonical" href="${href}" />`;
}
```

```ts
// src/lib/canonical.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCanonicalUrl } from "./canonical.ts";

describe("getCanonicalUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.BASCIK_SITE_URL = "https://example.com";
    process.env.BASCIK_PAGES_DIR = "/app/src/pages";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("generates canonical tag for index pages", () => {
    process.env.BASCIK_SOURCE_FILE = "/app/src/pages/index.html";
    // An html value is an object: compare its text.
    expect(String(getCanonicalUrl())).toBe(
      '<link rel="canonical" href="https://example.com/" />',
    );
  });

  it("generates canonical tag for nested routes", () => {
    process.env.BASCIK_SOURCE_FILE = "/app/src/pages/blog/post.html";
    expect(String(getCanonicalUrl())).toBe(
      '<link rel="canonical" href="https://example.com/blog/post" />',
    );
  });

  it("returns empty string when required environment variables are missing", () => {
    delete process.env.BASCIK_SOURCE_FILE;
    delete process.env.BASCIK_PAGE_FILE;
    expect(getCanonicalUrl()).toBe("");
  });
});
```

## Testing Error Handling & Fallback Markup

When a build script encounters missing files or remote network failures, your helper functions should handle exceptions gracefully so the page build does not produce broken layouts.

```ts
// src/lib/remote-data.ts
import { html, type SafeHtml } from "@bascik/bascik/html";

export async function fetchHeroData(endpoint: string): Promise<SafeHtml> {
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // A remote title is data: html escapes it, so markup in it shows as text.
    return html`<h1 class="hero-title">${data.title}</h1>`;
  } catch (err) {
    console.warn(
      `[build-scripts] Fallback used for ${endpoint}: ${(err as Error).message}`,
    );
    return html`<h1 class="hero-title">Welcome to Bascik</h1>`;
  }
}
```

```ts
// src/lib/remote-data.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchHeroData } from "./remote-data.ts";

describe("fetchHeroData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns formatted HTML on successful response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "Latest Release v1.0" }), {
        status: 200,
      }),
    );

    const hero = await fetchHeroData("https://api.example.com/release");
    expect(String(hero)).toBe(
      '<h1 class="hero-title">Latest Release v1.0</h1>',
    );
  });

  it("shows markup in a remote title as text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "<img src=x onerror=alert(1)>" }), {
        status: 200,
      }),
    );

    const hero = await fetchHeroData("https://api.example.com/release");
    expect(String(hero)).toBe(
      '<h1 class="hero-title">&lt;img src=x onerror=alert(1)&gt;</h1>',
    );
  });

  it("returns fallback markup when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    const hero = await fetchHeroData("https://api.example.com/release");
    expect(String(hero)).toBe('<h1 class="hero-title">Welcome to Bascik</h1>');
  });
});
```

## Testing Build Lifecycle Hooks (`exec` Scripts)

If your project configures lifecycle build scripts in `bascik.config.ts` via the `pipeline.exec` option (for example, generating `sitemap.xml`, search indexes, or RSS feeds), write automated tests to verify that generated files are written directly to `dist/` and match expected schema contracts:

```ts
// scripts/generate-sitemap.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateSitemap } from "./generate-sitemap.ts";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("generateSitemap lifecycle script", () => {
  const distDir = join(process.cwd(), "test-dist");
  const sitemapPath = join(distDir, "sitemap.xml");

  beforeEach(async () => {
    await mkdir(distDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  it("writes valid sitemap XML directly to dist without polluting src", async () => {
    await generateSitemap({
      siteUrl: "https://example.com",
      distDir,
      routes: ["/", "/docs", "/about"],
    });

    const xml = await readFile(sitemapPath, "utf8");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<loc>https://example.com/docs</loc>");
  });
});
```

> **Lifecycle Output Rule:** Build-time generation scripts executed via `pipeline.exec` in `bascik.config.ts` must always write their output files directly to `dist/`, never to `src/`, keeping the source tree clean.
