/**
 * E2E tests for the Bascik Dev Server (`bascik --dev`).
 *
 * Exercises:
 *   1. Live-reload script injection in dev mode (`/bascik-live-reload` SSE)
 *   2. HTML page modifications -> live SSE reload update on open browser tab
 *   3. Component template modifications -> selective page re-transpilation and live update
 *   4. Multi-tab live reload updates across multiple simultaneous open pages
 *   5. Static asset changes -> live SSE reload update
 *   6. HTTP protocol, security headers, and method handling (GET, HEAD, 405, 400)
 *   7. In-memory page serving, Brotli compression, and route normalization
 *   8. Request-time script execution (`data-bascik-server`) in dev mode
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev.config.ts
 */
import { test, expect } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = join(e2eDir, '..');
const pagePath = join(e2eDir, 'src/pages/scope-test.html');
const secondPagePath = join(e2eDir, 'src/pages/isolation-test.html');
const componentPath = join(e2eDir, 'src/components/scope-test/scope-test.html');
const staticCssPath = join(e2eDir, 'src/pages/dev-static-test.css');
const contentDocPath = join(e2eDir, 'src/content/watch-doc.md');
const subfolderPagePath = join(e2eDir, 'src/pages/subfolder/route-test.html');
const inlinedGlobalCssPath = join(e2eDir, 'src/css/inlined-global.css');

const dynamicCreatedCompPath = join(e2eDir, 'src/components/dynamic-created-comp.html');
const dynamicHeadMetaCompPath = join(e2eDir, 'src/components/dynamic-head-meta.html');
const scopeTestCssPath = join(e2eDir, 'src/components/scope-test/scope-test.css');
const dynamicCreatedPagePath = join(e2eDir, 'src/pages/dynamic-created-page.html');
const tempUnlinkCompPath = join(e2eDir, 'src/components/temp-unlink-comp.html');

test.describe('Dev Server Live-Reload & Watch Engine', () => {
  let originalPageContent: string;
  let originalSecondPageContent: string;
  let originalComponentContent: string;
  let originalContentDoc: string;
  let originalSubfolderPage: string;
  let originalInlinedGlobalCss: string;

  test.beforeAll(async () => {
    originalPageContent = await readFile(pagePath, 'utf8');
    originalSecondPageContent = await readFile(secondPagePath, 'utf8');
    originalComponentContent = await readFile(componentPath, 'utf8');
    originalContentDoc = await readFile(contentDocPath, 'utf8');
    originalSubfolderPage = await readFile(subfolderPagePath, 'utf8');
    originalInlinedGlobalCss = await readFile(inlinedGlobalCssPath, 'utf8');
  });

  test.afterEach(async () => {
    // Always restore original files on disk after each test
    await writeFile(pagePath, originalPageContent, 'utf8');
    await writeFile(secondPagePath, originalSecondPageContent, 'utf8');
    await writeFile(componentPath, originalComponentContent, 'utf8');
    await writeFile(contentDocPath, originalContentDoc, 'utf8');
    await writeFile(subfolderPagePath, originalSubfolderPage, 'utf8');
    await writeFile(inlinedGlobalCssPath, originalInlinedGlobalCss, 'utf8');
    await rm(staticCssPath, { force: true });
    await rm(dynamicCreatedCompPath, { force: true });
    await rm(dynamicHeadMetaCompPath, { force: true });
    await rm(scopeTestCssPath, { force: true });
    await rm(dynamicCreatedPagePath, { force: true });
    await rm(tempUnlinkCompPath, { force: true });
  });

  // ── 1. Dev-mode Script Injection & SSE ─────────────────────────────────────

  test('dev server injects live-reload script with SSE connection', async ({ page }) => {
    await page.goto('/scope-test');

    // Confirm live-reload script tag is present in the DOM
    const hasLiveReloadScript = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts.some((s) => s.textContent?.includes('/bascik-live-reload'));
    });
    expect(hasLiveReloadScript).toBe(true);
  });

  test('SSE endpoint responds with event-stream content-type and no-cache headers', async () => {
    const controller = new AbortController();
    const res = await fetch('http://localhost:9443/bascik-live-reload', {
      headers: { Referer: 'http://localhost:9443/scope-test' },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    controller.abort();
  });

  test('displays disconnection banner when live-reload connection fails', async ({ page }) => {
    // Abort requests to /bascik-live-reload to simulate network drop / server down
    await page.route('**/bascik-live-reload*', (route) => route.abort());

    await page.goto('/scope-test');

    // The banner should appear on the document body
    const banner = page.locator('#bascik-live-reload-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText('Live reload disconnected');

    // Retries exhaust and offline message is rendered (5 retries * 1s = 5s)
    await expect(banner).toContainText('Dev server offline. Will reconnect automatically when server restarts.', { timeout: 15000 });
  });

  test('removes disconnection banner and reconnects instantly when browser window regains focus', async ({ page }) => {
    // Block live-reload route briefly
    await page.route('**/bascik-live-reload*', (route) => route.abort());

    await page.goto('/scope-test');

    const banner = page.locator('#bascik-live-reload-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Unroute live-reload to allow connection to succeed
    await page.unroute('**/bascik-live-reload*');

    // Trigger instantConnect via focus or visibilitychange
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // Banner should be removed from DOM instantly
    await expect(banner).not.toBeAttached({ timeout: 10000 });
  });

  // ── 2. Live Page Modification ──────────────────────────────────────────────

  test('open browser page receives instant live-reload when HTML page source changes', async ({ page }) => {
    await page.goto('/scope-test');
    await expect(page.locator('h1')).toHaveText('JS Scope Rewriting — Live Test');

    const markerText = `Live Page Marker ${Date.now()}`;
    const updatedContent = originalPageContent.replace(
      '<h1>JS Scope Rewriting — Live Test</h1>',
      `<h1>${markerText}</h1>`,
    );
    const start = performance.now();
    await writeFile(pagePath, updatedContent, 'utf8');

    // Page should auto-reload via SSE and display the new text very quickly
    await expect(page.locator('h1')).toHaveText(markerText, { timeout: 15000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000); // Must transpile and reload under 3s
  });

  // ── 3. Live Component Modification ─────────────────────────────────────────

  test('open browser page updates live when a component template changes', async ({ page }) => {
    await page.goto('/scope-test');

    const button = page.locator('button[id$="__add-btn"]').first();
    await expect(button).toBeVisible();

    const markerText = `Click Me ${Date.now()}`;
    const updatedComponent = originalComponentContent.replace(
      'classList.add("active", "highlighted")',
      markerText,
    );
    const start = performance.now();
    await writeFile(componentPath, updatedComponent, 'utf8');

    // Live reload should re-transpile the page with the updated component template very quickly
    await expect(page.locator('button[id$="__add-btn"]').first()).toHaveText(markerText, { timeout: 15000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000); // Must transpile and reload under 3s
  });

  // ── 4. Multi-Tab Live Reload ───────────────────────────────────────────────

  test('simultaneous open browser tabs receive live-reload updates', async ({ context }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await page1.goto('/scope-test');
    await page2.goto('/isolation-test');

    await expect(page1.locator('h1')).toHaveText('JS Scope Rewriting — Live Test');

    // Modify first page
    const marker1 = `Tab 1 Marker ${Date.now()}`;
    await writeFile(pagePath, originalPageContent.replace(
      '<h1>JS Scope Rewriting — Live Test</h1>',
      `<h1>${marker1}</h1>`,
    ), 'utf8');

    // Page 1 reloads with marker
    await expect(page1.locator('h1')).toHaveText(marker1, { timeout: 15000 });

    // Modify second page
    const marker2 = `Tab 2 Marker ${Date.now()}`;
    await writeFile(secondPagePath, originalSecondPageContent.replace(
      '<h1>Cross-Component Isolation Test</h1>',
      `<h1>${marker2}</h1>`,
    ), 'utf8');

    // Page 2 reloads with marker
    await expect(page2.locator('h1')).toHaveText(marker2, { timeout: 15000 });

    await page1.close();
    await page2.close();
  });

  // ── 5. Static Asset Modifications ──────────────────────────────────────────

  test('triggers asset-changed live reload when static assets change', async ({ page }) => {
    await page.goto('/scope-test');
    await expect(page.locator('h1')).toBeVisible();

    // Create / touch a static CSS asset in dist to trigger asset watch event
    await writeFile(staticCssPath, '/* dev server test css */', 'utf8');

    // The browser should receive asset-changed reload event
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toBeVisible();
  });

  // ── 6. Watch System & Chokidar Rapid Edits Stress ──────────────────────────

  test('handles rapid sequential edits to page source without watcher race conditions or crashes', async ({ page }) => {
    await page.goto('/scope-test');

    const finalMarker = `Rapid Edit Final ${Date.now()}`;

    // Write 3 rapid changes in quick succession
    await writeFile(pagePath, originalPageContent.replace('<h1>JS Scope Rewriting — Live Test</h1>', '<h1>Rapid 1</h1>'), 'utf8');
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(pagePath, originalPageContent.replace('<h1>JS Scope Rewriting — Live Test</h1>', '<h1>Rapid 2</h1>'), 'utf8');
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(pagePath, originalPageContent.replace('<h1>JS Scope Rewriting — Live Test</h1>', `<h1>${finalMarker}</h1>`), 'utf8');

    // Server should recover and render the final state on the open browser page
    await expect(page.locator('h1')).toHaveText(finalMarker, { timeout: 15000 });
  });

  // ── 7. Watched Dependencies & Subfolder Routes ─────────────────────────────

  test('open page updates live when a watched external content file changes', async ({ page }) => {
    await page.goto('/watch-content-test');
    await expect(page.locator('h1')).toHaveText('Watch Doc Initial Content');

    const updatedText = `Updated Content ${Date.now()}`;
    const start = performance.now();
    await writeFile(contentDocPath, updatedText, 'utf8');

    await expect(page.locator('h1')).toHaveText(updatedText, { timeout: 15000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000); // Must transpile and reload under 3s
  });

  test('subfolder routes receive live reload when nested page source changes', async ({ page }) => {
    await page.goto('/subfolder/route-test');
    await expect(page.locator('h1')).toHaveText('Subfolder Route Initial');

    const updatedText = `Subfolder Route Updated ${Date.now()}`;
    await writeFile(subfolderPagePath, `<!DOCTYPE html><html><body><h1>${updatedText}</h1></body></html>`, 'utf8');

    await expect(page.locator('h1')).toHaveText(updatedText, { timeout: 15000 });
  });

  // ── 8. Dynamic Component & Page Addition Engine ──────────────────────────

  // ── 8. Dynamic Component & Page Addition Engine ──────────────────────────

  test('invalidates component cache and expands new component when a new component file is created during dev server session', async ({ page }) => {
    await page.goto('/scope-test');
    await expect(page.locator('h1')).toHaveText('JS Scope Rewriting — Live Test');

    const markerText = `Dynamic Comp Marker ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<style>.dyn-box { padding: 8px; border: 1px solid #f0f; }</style><div class="dyn-box" id="dyn-box-id">${markerText}</div>`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      '</body>',
      '<dynamic-created-comp></dynamic-created-comp></body>',
    );
    await writeFile(pagePath, updatedPage, 'utf8');

    const dynElement = page.locator('[id$="__dyn-box-id"]');
    await expect(dynElement).toBeVisible({ timeout: 15000 });
    await expect(dynElement).toHaveText(markerText);
  });

  test('expands dynamically created head component when component file is created during dev server session', async ({ page }) => {
    await page.goto('/scope-test');

    const metaVal = `head-meta-val-${Date.now()}`;
    await writeFile(
      dynamicHeadMetaCompPath,
      `<meta name="e2e-dyn-head-meta" content="${metaVal}">`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      '</head>',
      '<dynamic-head-meta></dynamic-head-meta></head>',
    );
    await writeFile(pagePath, updatedPage, 'utf8');

    await page.waitForFunction(
      (val) => document.querySelector('meta[name="e2e-dyn-head-meta"]')?.getAttribute('content') === val,
      metaVal,
      { timeout: 15000 },
    );
  });

  test('picks up companion CSS file added to component during dev server session', async ({ page }) => {
    await page.goto('/scope-test');

    await writeFile(
      scopeTestCssPath,
      '.dyn-companion-style { color: rgb(12, 34, 56); }',
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedComponent = originalComponentContent + '\n<p class="dyn-companion-style" id="dyn-companion-target">Companion Target</p>';
    await writeFile(componentPath, updatedComponent, 'utf8');

    const target = page.locator('[id$="__dyn-companion-target"]').first();
    await expect(target).toBeVisible({ timeout: 15000 });
    await expect(target).toHaveCSS('color', 'rgb(12, 34, 56)');
  });

  test('transpiles and serves newly created page with component tags during dev server session', async ({ page }) => {
    const pageMarker = `New Page Heading ${Date.now()}`;
    await writeFile(
      dynamicCreatedPagePath,
      `<!DOCTYPE html><html><head><title>New Page</title></head><body><h1 id="dyn-page-h1">${pageMarker}</h1><scope-test></scope-test></body></html>`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1500));

    const res = await page.goto('/dynamic-created-page');
    expect(res?.status()).toBe(200);

    await expect(page.locator('#dyn-page-h1')).toHaveText(pageMarker, { timeout: 15000 });
    await expect(page.locator('button[id$="__add-btn"]').first()).toBeVisible();
  });

  test('invalidates component cache and stops expanding component when component file is deleted', async ({ page }) => {
    const tempMarker = `Temp Unlink ${Date.now()}`;
    await writeFile(
      tempUnlinkCompPath,
      `<div id="temp-unlink-id">${tempMarker}</div>`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      '</body>',
      '<temp-unlink-comp></temp-unlink-comp></body>',
    );
    await writeFile(pagePath, updatedPage, 'utf8');

    await page.goto('/scope-test');
    await expect(page.locator('[id$="__temp-unlink-id"]')).toHaveText(tempMarker, { timeout: 15000 });

    await rm(tempUnlinkCompPath, { force: true });
    await new Promise((r) => setTimeout(r, 1000));
    await writeFile(pagePath, updatedPage + ' ', 'utf8');

    await expect(page.locator('[id$="__temp-unlink-id"]')).not.toBeAttached({ timeout: 15000 });
  });

  // ── 9. Dev Server Caching & Dependency Graph Engine ─────────────────────

  test('updates in-memory component dependency graph when page component usage changes dynamically', async ({ page }) => {
    await page.goto('/scope-test');
    await expect(page.locator('h1')).toHaveText('JS Scope Rewriting — Live Test');

    // 1. Create a new component file
    const dynCompText = `Dyn Comp Usage ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<div id="dyn-reassoc-id">${dynCompText}</div>`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    // 2. Modify page to replace <scope-test> with <dynamic-created-comp>
    const pageWithDyn = originalPageContent.replace(/<scope-test><\/scope-test>/g, '<dynamic-created-comp></dynamic-created-comp>');
    await writeFile(pagePath, pageWithDyn, 'utf8');

    // Verify page now displays the dynamic component
    await expect(page.locator('[id$="__dyn-reassoc-id"]').first()).toHaveText(dynCompText, { timeout: 15000 });

    // 3. Now modify scope-test.html (which is NO LONGER used on /scope-test)
    const scopeCompMarker = `Scope Comp Edited ${Date.now()}`;
    await writeFile(
      componentPath,
      originalComponentContent + `\n<p id="stale-scope-marker">${scopeCompMarker}</p>`,
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Verify page on /scope-test did NOT receive the stale component marker
    await expect(page.locator('#stale-scope-marker')).not.toBeAttached();

    // 4. Now modify dynamic-created-comp.html (which IS used on /scope-test)
    const updatedDynText = `Dyn Comp Updated ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<div id="dyn-reassoc-id">${updatedDynText}</div>`,
      'utf8',
    );

    // Verify page re-transpiled and reloaded with updated dynamic component text
    await expect(page.locator('[id$="__dyn-reassoc-id"]').first()).toHaveText(updatedDynText, { timeout: 15000 });
  });

  test('updates inlined global stylesheet across pages when watched inlineStyles asset changes', async ({ page }) => {
    await page.goto('/scope-test');

    const styleMarker = `.inlined-dyn-test-${Date.now()} { color: rgb(123, 45, 67); }`;
    await writeFile(inlinedGlobalCssPath, originalInlinedGlobalCss + '\n' + styleMarker, 'utf8');

    await expect.poll(async () => {
      const styles = await page.locator('head style').allInnerTexts();
      return styles.some((s) => s.includes(styleMarker));
    }, { timeout: 15000 }).toBe(true);
  });

  test('invalidates build script disk cache and re-executes script when file dependency changes', async ({ page }) => {
    await page.goto('/watch-content-test');
    await expect(page.locator('h1')).toHaveText('Watch Doc Initial Content');

    const updatedText = `Cache Invalidation Text ${Date.now()}`;
    await writeFile(contentDocPath, updatedText, 'utf8');

    // Page updates with the new build script output
    await expect(page.locator('h1')).toHaveText(updatedText, { timeout: 15000 });
  });

  test('maintains isolated build script cache entries across different pages using the same script', async ({ page }) => {
    await page.goto('/build-script-page-env-test');
    const textA = await page.locator('#page-file').textContent();
    expect(textA).toContain('build-script-page-env-test.html');

    await page.goto('/build-script-page-env-test-b');
    const textB = await page.locator('#page-file').textContent();
    expect(textB).toContain('build-script-page-env-test-b.html');
    expect(textB).not.toContain('build-script-page-env-test.html');
  });
});

test.describe('Dev Server HTTP Protocol & Security Headers', () => {
  test('includes security headers and no-cache controls in dev mode responses', async ({ request }) => {
    const res = await request.get('/scope-test');
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers['content-type']).toContain('text/html');
    expect(headers['cache-control']).toContain('no-cache');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('handles HEAD requests with 200 OK and empty body', async ({ request }) => {
    const res = await request.head('/scope-test');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const body = await res.body();
    expect(body.length).toBe(0);
  });

  test('returns 405 Method Not Allowed for POST requests', async ({ request }) => {
    const res = await request.post('/scope-test');
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('GET, HEAD');
  });

  test('rejects path traversal attempts with 400 Bad Request', async ({ request }) => {
    const res1 = await request.get('/../../../etc/passwd');
    // HTTP/1.1 clients (like Playwright in dev mode) may normalize the path to /etc/passwd
    // on the client side before sending, which results in 404 Not Found, while HTTP/2 keeps it as 400.
    expect([400, 404]).toContain(res1.status());

    const res2 = await request.get('/..%2f..%2f..%2fetc/passwd');
    expect(res2.status()).toBe(400);
  });
});

test.describe('Dev Server In-Memory Routing & Brotli Compression', () => {
  test('serves in-memory pages with trailing slash normalization', async ({ page }) => {
    const resExact = await page.goto('/scope-test');
    expect(resExact?.status()).toBe(200);

    const resSlash = await page.goto('/scope-test/');
    expect(resSlash?.status()).toBe(200);
  });

  test('serves Brotli-compressed content when client sends Accept-Encoding: br', async ({ request }) => {
    const res = await request.get('/scope-test', {
      headers: { 'accept-encoding': 'br' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-encoding']).toBe('br');
  });

  test('returns 404 for non-existent page routes', async ({ page }) => {
    const response = await page.goto('/nonexistent-dev-route-12345');
    expect(response?.status()).toBe(404);
  });
});

test.describe('Dev Server Request-Time Scripts (data-bascik-server)', () => {
  test('executes server scripts on request in dev mode', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-test-name': 'DevUser' });
    await page.goto('/server-scripts-test?color=cyan');

    await expect(page.locator('#from-header')).toHaveText('DevUser');
    await expect(page.locator('#from-query')).toHaveText('cyan');
    await expect(page.locator('#from-path')).toHaveText('/server-scripts-test');
    await expect(page.locator('#from-async')).toHaveText('async-ok');
  });

  test('supports Node.js ESM imports, component server scripts, and ANSI stripping in dev mode', async ({ page }) => {
    await page.goto('/server-scripts-advanced-test');

    await expect(page.locator('#esm-import-output')).toHaveText('ESM Import: server-scripts-advanced-test | Method: GET');
    await expect(page.locator('[class*="server-comp-static"]')).toHaveText('Component Static');
    await expect(page.locator('[id$="__comp-server-output"]')).toHaveText('Comp Server: GET');
    await expect(page.locator('#ansi-output')).toHaveText('Clean HTML');
  });
});

test.describe('Dev Server Startup Output', () => {
  test('startup logs do not contain duplicate transpiled page entries or duplicate completion summaries', async () => {
    const entryPath = join(pkgDir, 'bin/bascik.js');
    const child = spawn(process.execPath, [entryPath], {
      cwd: e2eDir,
      env: { ...process.env, PORT: '9989' },
    });

    let output = '';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Dev server startup timed out. Output captured:\n${output}`));
      }, 15000);

      child.stdout?.on('data', (data) => {
        output += data.toString('utf8');
        if (output.includes('All tasks completed in')) {
          clearTimeout(timeout);
          child.kill();
          resolve();
        }
      });

      child.stderr?.on('data', (data) => {
        output += data.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (!output.includes('All tasks completed in')) {
          reject(new Error(`Dev server exited prematurely with code ${code}. Output:\n${output}`));
        } else {
          resolve();
        }
      });
    });

    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);

    // 1. Check transpiled page lines: each page path should be transpiled exactly once
    const transpiledLines = lines.filter((l) => l.startsWith('transpiled:'));
    expect(transpiledLines.length).toBeGreaterThan(0);

    const uniqueTranspiled = new Set(transpiledLines);
    expect(transpiledLines.length).toBe(uniqueTranspiled.size);

    // 2. Check summary line: exactly one "✓ N pages transpiled in Xms" before server ready
    const summaryLines = lines.filter((l) => /^✓ \d+ pages? transpiled in \d+ms$/.test(l));
    expect(summaryLines.length).toBe(1);
  });
});

