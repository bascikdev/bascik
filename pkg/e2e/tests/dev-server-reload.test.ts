/**
 * E2E tests for the Bascik Dev Server (`bascik` with no mode flag).
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
 *   9. Component edits that only reach a page through script output (prompt 157)
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev.config.ts
 */
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";
import { BOOT_GATE_PAGE } from "./helpers/boot-gate-page.ts";
import { outDir } from "./helpers/out-dir.ts";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = join(e2eDir, "..");
const pagePath = join(e2eDir, "src/pages/scope-test.html");
const secondPagePath = join(e2eDir, "src/pages/isolation-test.html");
const componentPath = join(e2eDir, "src/components/scope-test/scope-test.html");
const staticCssPath = join(e2eDir, "src/pages/dev-static-test.css");
const contentDocPath = join(e2eDir, "src/content/watch-doc.md");
const subfolderPagePath = join(e2eDir, "src/pages/subfolder/route-test.html");
const inlinedGlobalCssPath = join(e2eDir, "src/css/inlined-global.css");
const scopeTestOutputPath = join(outDir(e2eDir), "scope-test.html");

const dynamicCreatedCompPath = join(
  e2eDir,
  "src/components/dynamic-created-comp.html",
);
const dynamicHeadMetaCompPath = join(
  e2eDir,
  "src/components/dynamic-head-meta.html",
);
const scopeTestCssPath = join(
  e2eDir,
  "src/components/scope-test/scope-test.css",
);
const dynamicCreatedPagePath = join(
  e2eDir,
  "src/pages/dynamic-created-page.html",
);
const tempUnlinkCompPath = join(e2eDir, "src/components/temp-unlink-comp.html");
const missingHelperPath = join(e2eDir, "src/lib/failed-import-helper.ts");
const importedPartialPath = join(
  e2eDir,
  "src/components/css-import/import-base.css",
);

/**
 * Resolve once the page has navigated to a document whose inlined <head>
 * <style> text contains `marker`.
 *
 * Why not `expect.poll` over `allInnerTexts()`: the live-reload client calls
 * `location.reload()` on the SSE `reload` event, and evaluating the old
 * document's DOM while that navigation is in flight throws "Execution
 * context was destroyed" instead of returning false, which aborts the poll.
 *
 * Why not a single `waitForEvent('framenavigated')`: the previous test's
 * `afterEach` restores the same CSS asset, and that restore can produce a
 * reload that lands after this test has already opened the page. Waiting on
 * "the next navigation" would then observe the stale reload and read a
 * document that predates this test's write. Attaching the listener BEFORE
 * the write and checking each navigation's document for the marker makes the
 * wait deterministic regardless of how many reloads precede the right one.
 */
const waitForReloadWithStyle = (
  page: import("@playwright/test").Page,
  marker: string,
  timeout = 15000,
): Promise<number> => {
  let resolveDone!: (navigations: number) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<number>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let navigations = 0;
  const timer = setTimeout(() => {
    page.off("framenavigated", onNav);
    rejectDone(
      new Error(
        `no reload carried ${JSON.stringify(marker)} within ${timeout}ms (${navigations} navigation(s) seen)`,
      ),
    );
  }, timeout);
  const onNav = async (frame: import("@playwright/test").Frame) => {
    if (frame !== page.mainFrame()) return;
    navigations++;
    try {
      await frame.waitForLoadState("domcontentloaded");
      const styles = await frame.locator("head style").allTextContents();
      if (styles.some((s) => s.includes(marker))) {
        clearTimeout(timer);
        page.off("framenavigated", onNav);
        resolveDone(navigations);
      }
    } catch {
      // This document was torn down by a further reload before we could read
      // it; the next framenavigated will re-check.
    }
  };
  page.on("framenavigated", onNav);
  return done;
};

/**
 * Restore a fixture. Returns true when a write actually happened (and so the
 * dev server will rebuild and broadcast a reload for affected open pages).
 */
const restoreFileIfChanged = async (
  filePath: string,
  originalContent: string,
): Promise<boolean> => {
  const currentContent = await readFile(filePath, "utf8").catch(() => null);
  if (currentContent !== originalContent) {
    await writeFile(filePath, originalContent, "utf8");
    return true;
  }
  return false;
};

/**
 * Origin of the dev server this project runs against (its `baseURL`), for
 * requests made with `fetch` outside the Playwright request fixture. Read per
 * call so the lane config stays the only place the port is written.
 */
const laneOrigin = (): string => {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("dev-server-reload needs a project baseURL");
  return new URL(baseURL).origin;
};

/**
 * Subscribe to the dev server's SSE stream as if a tab had `httpPath` open,
 * and resolve once one `reload` event for that page arrives. Used by
 * `afterEach` so the rebuild caused by restoring a fixture is fully consumed
 * before the next test starts; otherwise that reload can land on the next
 * test's freshly opened page and interrupt its own navigation.
 *
 * This is an event wait, not a sleep: it resolves the moment the server says
 * the page was re-transpiled, and rejects loudly if that never happens.
 */
const subscribeToServerReload = async (
  httpPath: string,
  timeout = 15000,
): Promise<{ reload: Promise<void> }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const origin = laneOrigin();
  const res = await fetch(`${origin}/bascik-live-reload`, {
    headers: { Referer: `${origin}${httpPath}` },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readUntil = async (pattern: RegExp, what: string): Promise<void> => {
    try {
      while (!pattern.test(buffered)) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error(`SSE stream closed before ${what} for ${httpPath}`);
        buffered += decoder.decode(value, { stream: true });
      }
    } catch (err) {
      if (controller.signal.aborted)
        throw new Error(`no ${what} for ${httpPath} within ${timeout}ms`);
      throw err;
    }
  };
  // `connected` is written in `addClient`, and the server attaches its
  // `transpiled` listener synchronously in the same tick right after. A file
  // write we issue after observing `connected` therefore cannot be processed
  // before that listener exists, so the resulting reload is guaranteed to
  // reach this subscription.
  await readUntil(/^data: connected$/m, "connected");
  const reload = readUntil(/^data: reload\b/m, "reload").finally(() => {
    clearTimeout(timer);
    controller.abort();
  });
  return { reload };
};

test.describe("Dev Server Live-Reload & Watch Engine", () => {
  let originalPageContent: string;
  let originalSecondPageContent: string;
  let originalComponentContent: string;
  let originalContentDoc: string;
  let originalSubfolderPage: string;
  let originalInlinedGlobalCss: string;
  let originalScopeTestCss: string;
  let originalMissingHelper: string;
  let originalImportedPartial: string;

  test.beforeAll(async () => {
    originalPageContent = await readFile(pagePath, "utf8");
    originalSecondPageContent = await readFile(secondPagePath, "utf8");
    originalComponentContent = await readFile(componentPath, "utf8");
    originalContentDoc = await readFile(contentDocPath, "utf8");
    originalSubfolderPage = await readFile(subfolderPagePath, "utf8");
    originalInlinedGlobalCss = await readFile(inlinedGlobalCssPath, "utf8");
    originalScopeTestCss = await readFile(scopeTestCssPath, "utf8");
    originalMissingHelper = await readFile(missingHelperPath, "utf8");
    originalImportedPartial = await readFile(importedPartialPath, "utf8");
  });

  test.afterEach(async () => {
    const restoreAndConsumeReload = async (
      filePath: string,
      originalContent: string,
      httpPath: string,
    ): Promise<void> => {
      const current = await readFile(filePath, "utf8").catch(() => null);
      if (current !== originalContent) {
        const { reload } = await subscribeToServerReload(httpPath);
        await writeFile(filePath, originalContent, "utf8");
        await reload.catch(() => {});
      }
    };

    // Avoid emitting watcher events for unchanged fixtures between tests, and
    // consume the SSE reload for any restored fixture so it cannot interrupt
    // the next test's initial page.goto().
    await restoreAndConsumeReload(pagePath, originalPageContent, "/scope-test");
    await restoreAndConsumeReload(
      secondPagePath,
      originalSecondPageContent,
      "/isolation-test",
    );
    await restoreAndConsumeReload(
      componentPath,
      originalComponentContent,
      "/scope-test",
    );
    await restoreAndConsumeReload(
      contentDocPath,
      originalContentDoc,
      "/watch-content-test",
    );
    await restoreAndConsumeReload(
      subfolderPagePath,
      originalSubfolderPage,
      "/subfolder/route-test",
    );
    await restoreFileIfChanged(missingHelperPath, originalMissingHelper);
    await restoreAndConsumeReload(
      inlinedGlobalCssPath,
      originalInlinedGlobalCss,
      "/scope-test",
    );
    await restoreAndConsumeReload(
      scopeTestCssPath,
      originalScopeTestCss,
      "/scope-test",
    );
    await restoreAndConsumeReload(
      importedPartialPath,
      originalImportedPartial,
      "/css-import-test",
    );
    await rm(staticCssPath, { force: true });
    await rm(dynamicCreatedCompPath, { force: true });
    await rm(dynamicHeadMetaCompPath, { force: true });
    await rm(dynamicCreatedPagePath, { force: true });
    await rm(tempUnlinkCompPath, { force: true });
  });

  // ── 1. Dev-mode Script Injection & SSE ─────────────────────────────────────

  test("dev server injects live-reload script with SSE connection", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    // Confirm live-reload script tag is present in the DOM
    const hasLiveReloadScript = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll("script"));
      return scripts.some((s) =>
        s.textContent?.includes("/bascik-live-reload"),
      );
    });
    expect(hasLiveReloadScript).toBe(true);
  });

  test("serves a page while its transpiled HTML is available in dist", async ({
    page,
  }) => {
    const response = await page.goto("/scope-test");
    expect(response?.status()).toBe(200);

    await expect
      .poll(async () => {
        const output = await readFile(scopeTestOutputPath, "utf8").catch(
          () => "",
        );
        return output.includes("/bascik-live-reload");
      })
      .toBe(true);
  });

  test("SSE endpoint responds with event-stream content-type and no-cache headers", async () => {
    const controller = new AbortController();
    const res = await fetch(`${laneOrigin()}/bascik-live-reload`, {
      headers: { Referer: `${laneOrigin()}/scope-test` },
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    controller.abort();
  });

  test("displays disconnection banner when live-reload connection fails", async ({
    page,
  }) => {
    // Abort requests to /bascik-live-reload to simulate network drop / server down
    await page.route("**/bascik-live-reload*", (route) => route.abort());

    await page.goto("/scope-test");

    // The banner should appear on the document body
    const banner = page.locator("#bascik-live-reload-banner");
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText("Live reload disconnected");

    // Retries exhaust and offline message is rendered (5 retries * 1s = 5s)
    await expect(banner).toContainText(
      "Dev server offline. Will reconnect automatically when server restarts.",
      { timeout: 15000 },
    );
  });

  test("removes disconnection banner and reconnects instantly when browser window regains focus", async ({
    page,
  }) => {
    // Block live-reload route briefly
    await page.route("**/bascik-live-reload*", (route) => route.abort());

    await page.goto("/scope-test");

    const banner = page.locator("#bascik-live-reload-banner");
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Unroute live-reload to allow connection to succeed
    await page.unroute("**/bascik-live-reload*");

    // Trigger instantConnect via focus or visibilitychange
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Banner should be removed from DOM instantly
    await expect(banner).not.toBeAttached({ timeout: 10000 });
  });

  // ── 2. Live Page Modification ──────────────────────────────────────────────

  test("open browser page receives instant live-reload when HTML page source changes", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    const markerText = `Live Page Marker ${Date.now()}`;
    const updatedContent = originalPageContent.replace(
      "<h1>JS Scope Rewriting — Live Test</h1>",
      `<h1>${markerText}</h1>`,
    );
    const start = performance.now();
    await writeFile(pagePath, updatedContent, "utf8");

    // Page should auto-reload via SSE and display the new text very quickly
    await expect(page.locator("h1")).toHaveText(markerText, { timeout: 15000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  // ── 3. Live Component Modification ─────────────────────────────────────────

  test("open browser page updates live when a component template changes", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    const button = page.locator('button[id$="__add-btn"]').first();
    await expect(button).toBeVisible();

    const markerText = `Click Me ${Date.now()}`;
    const updatedComponent = originalComponentContent.replace(
      'classList.add("active", "highlighted")',
      markerText,
    );
    const start = performance.now();
    await writeFile(componentPath, updatedComponent, "utf8");

    // Live reload should re-transpile the page with the updated component template very quickly
    await expect(page.locator('button[id$="__add-btn"]').first()).toHaveText(
      markerText,
      { timeout: 15000 },
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  // ── 4. Multi-Tab Live Reload ───────────────────────────────────────────────

  test("simultaneous open browser tabs receive live-reload updates", async ({
    context,
  }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await page1.goto("/scope-test");
    await page2.goto("/isolation-test");

    await expect(page1.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // Modify first page
    const marker1 = `Tab 1 Marker ${Date.now()}`;
    await writeFile(
      pagePath,
      originalPageContent.replace(
        "<h1>JS Scope Rewriting — Live Test</h1>",
        `<h1>${marker1}</h1>`,
      ),
      "utf8",
    );

    // Page 1 reloads with marker
    await expect(page1.locator("h1")).toHaveText(marker1, { timeout: 15000 });

    // Modify second page
    const marker2 = `Tab 2 Marker ${Date.now()}`;
    await writeFile(
      secondPagePath,
      originalSecondPageContent.replace(
        "<h1>Cross-Component Isolation Test</h1>",
        `<h1>${marker2}</h1>`,
      ),
      "utf8",
    );

    // Page 2 reloads with marker
    await expect(page2.locator("h1")).toHaveText(marker2, { timeout: 15000 });

    await page1.close();
    await page2.close();
  });

  // ── 5. Static Asset Modifications ──────────────────────────────────────────

  test("triggers asset-changed live reload when static assets change", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toBeVisible();

    // Create / touch a static CSS asset in dist to trigger asset watch event
    await writeFile(staticCssPath, "/* dev server test css */", "utf8");

    // The browser should receive asset-changed reload event
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("h1")).toBeVisible();
  });

  // ── 6. Watch System & Chokidar Rapid Edits Stress ──────────────────────────

  test("handles rapid sequential edits to page source without watcher race conditions or crashes", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    const finalMarker = `Rapid Edit Final ${Date.now()}`;

    // Write 3 rapid changes in quick succession
    await writeFile(
      pagePath,
      originalPageContent.replace(
        "<h1>JS Scope Rewriting — Live Test</h1>",
        "<h1>Rapid 1</h1>",
      ),
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      pagePath,
      originalPageContent.replace(
        "<h1>JS Scope Rewriting — Live Test</h1>",
        "<h1>Rapid 2</h1>",
      ),
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      pagePath,
      originalPageContent.replace(
        "<h1>JS Scope Rewriting — Live Test</h1>",
        `<h1>${finalMarker}</h1>`,
      ),
      "utf8",
    );

    // Server should recover and render the final state on the open browser page
    await expect(page.locator("h1")).toHaveText(finalMarker, {
      timeout: 15000,
    });
  });

  test("a broader component rebuild never overwrites a newer direct page edit with stale content", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // Stage two overlapping invalidations: a broad component change (rebuilt
    // through the shared-component path) and a newer direct page edit. The
    // page edit carries the newest content; regardless of which compiler path
    // finishes last, the browser must settle on the newest page content and
    // never regress to a stale component-driven rebuild of this page.
    const componentMarker = `component stage ${Date.now()}`;
    const pageMarker = `page final ${Date.now()}`;

    // Subscribe before the component write and wait for its rebuild to publish
    // before issuing the newer direct page edit. This establishes the intended
    // source-event order without an arbitrary delay while still allowing the
    // component-triggered reload/navigation to overlap the direct edit.
    const componentReload = await subscribeToServerReload("/scope-test");
    await writeFile(
      componentPath,
      originalComponentContent +
        `\n<span data-testid="overlap-comp-marker">${componentMarker}</span>`,
      "utf8",
    );
    await componentReload.reload;

    const newest = originalPageContent.replace(
      "<h1>JS Scope Rewriting — Live Test</h1>",
      `<h1>${pageMarker}</h1>`,
    );
    await writeFile(pagePath, newest, "utf8");

    // The final document must carry the newest page heading. Poll via
    // toHaveText (Playwright retries across reloads); a stale overwrite would
    // briefly show an old heading but must settle on `pageMarker`.
    await expect(page.locator("h1")).toHaveText(pageMarker, { timeout: 15000 });
    // After settling, the newest heading must persist (no late stale reload).
    await page.waitForTimeout(500);
    await expect(page.locator("h1")).toHaveText(pageMarker);
  });

  // ── 7. Watched Dependencies & Subfolder Routes ─────────────────────────────

  test("open page updates live when a watched external content file changes", async ({
    page,
  }) => {
    await page.goto("/watch-content-test");
    await expect(page.getByTestId("watch-content-heading")).toHaveText(
      "Watch Doc Initial Content",
    );

    const updatedText = `Updated Content ${Date.now()}`;
    const start = performance.now();
    await writeFile(contentDocPath, updatedText, "utf8");

    await expect(page.getByTestId("watch-content-heading")).toHaveText(
      updatedText,
      { timeout: 15000 },
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test("handles rapid alternating content edits on watched markdown doc without stale reload", async ({
    page,
  }) => {
    await page.goto("/watch-content-test");
    const heading = page.getByTestId("watch-content-heading");
    await expect(heading).toHaveText("Watch Doc Initial Content");

    // Perform 10 rapid alternating saves (add/save, remove/save, add/save...)
    for (let i = 1; i <= 10; i++) {
      const isEven = i % 2 === 0;
      const expectedText = isEven
        ? `Watch Doc Alternate ${i}`
        : `Watch Doc Primary ${i}`;

      await writeFile(contentDocPath, expectedText, "utf8");

      // Assert after each save that DOM text matches the file on disk without stale generation rollback
      await expect(heading).toHaveText(expectedText, { timeout: 15000 });
    }
  });

  test("subfolder routes receive live reload when nested page source changes", async ({
    page,
  }) => {
    await page.goto("/subfolder/route-test");
    await expect(page.locator("h1")).toHaveText("Subfolder Route Initial");

    const updatedText = `Subfolder Route Updated ${Date.now()}`;
    await writeFile(
      subfolderPagePath,
      `<!DOCTYPE html><html><body><h1>${updatedText}</h1></body></html>`,
      "utf8",
    );

    await expect(page.locator("h1")).toHaveText(updatedText, {
      timeout: 15000,
    });
  });

  // ── 8. Dynamic Component & Page Addition Engine ──────────────────────────

  // ── 8. Dynamic Component & Page Addition Engine ──────────────────────────

  test("invalidates component cache and expands new component when a new component file is created during dev server session", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    const markerText = `Dynamic Comp Marker ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<style>.dyn-box { padding: 8px; border: 1px solid #f0f; }</style><div class="dyn-box" id="dyn-box-id">${markerText}</div>`,
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      "</body>",
      "<dynamic-created-comp></dynamic-created-comp></body>",
    );
    await writeFile(pagePath, updatedPage, "utf8");

    const dynElement = page.locator('[id$="__dyn-box-id"]');
    await expect(dynElement).toBeVisible({ timeout: 15000 });
    await expect(dynElement).toHaveText(markerText);
  });

  test("expands dynamically created head component when component file is created during dev server session", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    const metaVal = `head-meta-val-${Date.now()}`;
    await writeFile(
      dynamicHeadMetaCompPath,
      `<meta name="e2e-dyn-head-meta" content="${metaVal}">`,
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      "</head>",
      "<dynamic-head-meta></dynamic-head-meta></head>",
    );
    await writeFile(pagePath, updatedPage, "utf8");

    await page.waitForFunction(
      (val) =>
        document
          .querySelector('meta[name="e2e-dyn-head-meta"]')
          ?.getAttribute("content") === val,
      metaVal,
      { timeout: 15000 },
    );
  });

  test("picks up companion CSS file added to component during dev server session", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    const updatedComponent =
      originalComponentContent +
      '\n<p class="dyn-companion-style" data-testid="dyn-companion-target">Companion Target</p>';
    await writeFile(componentPath, updatedComponent, "utf8");

    const target = page.getByTestId("dyn-companion-target").first();
    await expect(target).toBeVisible({ timeout: 15000 });

    await writeFile(
      scopeTestCssPath,
      originalScopeTestCss +
        "\n.dyn-companion-style { color: rgb(12, 34, 56); }",
      "utf8",
    );

    await expect(target).toHaveCSS("color", "rgb(12, 34, 56)", {
      timeout: 15000,
    });
  });

  test("rebuilds a component page when a stylesheet its CSS imports changes", async ({
    page,
  }) => {
    await page.goto("/css-import-test");
    const text = page.locator('p[id$="__text"]');
    await expect(text).toHaveCSS("font-size", "18px");

    // import-base.css is not a component of its own: only css-import.css
    // imports it, so this edit reaches the page through that import alone.
    const reloaded = waitForReloadWithStyle(page, "23px");
    await writeFile(
      importedPartialPath,
      originalImportedPartial.replace("18px", "23px"),
      "utf8",
    );
    await reloaded;
    await expect(text).toHaveCSS("font-size", "23px");
  });

  test("transpiles and serves newly created page with component tags during dev server session", async ({
    page,
  }) => {
    const pageMarker = `New Page Heading ${Date.now()}`;
    await writeFile(
      dynamicCreatedPagePath,
      `<!DOCTYPE html><html><head><title>New Page</title></head><body><h1 id="dyn-page-h1">${pageMarker}</h1><scope-test></scope-test></body></html>`,
      "utf8",
    );

    await expect
      .poll(
        async () => {
          const res = await page.goto("/dynamic-created-page");
          return res?.status();
        },
        { timeout: 15000 },
      )
      .toBe(200);

    await expect(page.locator("#dyn-page-h1")).toHaveText(pageMarker, {
      timeout: 15000,
    });
    await expect(page.locator('button[id$="__add-btn"]').first()).toBeVisible();
  });

  test("invalidates component cache and stops expanding component when component file is deleted", async ({
    page,
  }) => {
    const tempMarker = `Temp Unlink ${Date.now()}`;
    await writeFile(
      tempUnlinkCompPath,
      `<div id="temp-unlink-id">${tempMarker}</div>`,
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 1000));

    const updatedPage = originalPageContent.replace(
      "</body>",
      "<temp-unlink-comp></temp-unlink-comp></body>",
    );
    await writeFile(pagePath, updatedPage, "utf8");

    await page.goto("/scope-test");
    await expect(page.locator('[id$="__temp-unlink-id"]')).toHaveText(
      tempMarker,
      { timeout: 15000 },
    );

    await rm(tempUnlinkCompPath, { force: true });
    await new Promise((r) => setTimeout(r, 1000));
    await writeFile(pagePath, updatedPage + " ", "utf8");

    await expect(page.locator('[id$="__temp-unlink-id"]')).not.toBeAttached({
      timeout: 15000,
    });
  });

  // ── 9. Dev Server Caching & Dependency Graph Engine ─────────────────────

  test("updates in-memory component dependency graph when page component usage changes dynamically", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // 1. Create a new component file
    const dynCompText = `Dyn Comp Usage ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<div id="dyn-reassoc-id">${dynCompText}</div>`,
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 1000));

    // 2. Modify page to replace <scope-test> with <dynamic-created-comp>
    const pageWithDyn = originalPageContent.replace(
      /<scope-test><\/scope-test>/g,
      "<dynamic-created-comp></dynamic-created-comp>",
    );
    await writeFile(pagePath, pageWithDyn, "utf8");

    // Verify page now displays the dynamic component
    await expect(page.locator('[id$="__dyn-reassoc-id"]').first()).toHaveText(
      dynCompText,
      { timeout: 15000 },
    );

    // 3. Now modify scope-test.html (which is NO LONGER used on /scope-test)
    const scopeCompMarker = `Scope Comp Edited ${Date.now()}`;
    await writeFile(
      componentPath,
      originalComponentContent +
        `\n<p id="stale-scope-marker">${scopeCompMarker}</p>`,
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Verify page on /scope-test did NOT receive the stale component marker
    await expect(page.locator("#stale-scope-marker")).not.toBeAttached();

    // 4. Now modify dynamic-created-comp.html (which IS used on /scope-test)
    const updatedDynText = `Dyn Comp Updated ${Date.now()}`;
    await writeFile(
      dynamicCreatedCompPath,
      `<div id="dyn-reassoc-id">${updatedDynText}</div>`,
      "utf8",
    );

    // Verify page re-transpiled and reloaded with updated dynamic component text
    await expect(page.locator('[id$="__dyn-reassoc-id"]').first()).toHaveText(
      updatedDynText,
      { timeout: 15000 },
    );
  });

  test("updates inlined global stylesheet across pages when watched inlineStyles asset changes", async ({
    page,
  }) => {
    await page.goto("/scope-test");

    const styleMarker = `.inlined-dyn-test-${Date.now()} { color: rgb(123, 45, 67); }`;
    // Arm the listener before the write so the reload cannot be missed, then
    // wait for the navigation whose document carries the new rule. See
    // waitForReloadWithStyle for why neither expect.poll nor a bare
    // waitForEvent('framenavigated') is sufficient here.
    const reloaded = waitForReloadWithStyle(page, styleMarker);
    await writeFile(
      inlinedGlobalCssPath,
      originalInlinedGlobalCss + "\n" + styleMarker,
      "utf8",
    );
    await expect(reloaded).resolves.toBeGreaterThanOrEqual(1);
  });

  test("prioritizes open browser tab during full rebuild and reloads immediately when global styles change", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toBeVisible();

    const uniqueRule = `.global-prio-rule-${Date.now()} { color: rgb(45, 90, 135); }`;
    const reloaded = waitForReloadWithStyle(page, uniqueRule);
    const start = performance.now();
    await writeFile(
      inlinedGlobalCssPath,
      originalInlinedGlobalCss + "\n" + uniqueRule,
      "utf8",
    );

    // The open page /scope-test must be prioritized during processAllPages and
    // reloaded very quickly: measure until the document carrying the new rule
    // has actually arrived.
    await expect(reloaded).resolves.toBeGreaterThanOrEqual(1);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test("invalidates build script disk cache and re-executes script when file dependency changes", async ({
    page,
  }) => {
    await page.goto("/watch-content-test");
    await expect(page.locator("h1")).toHaveText("Watch Doc Initial Content");

    const updatedText = `Cache Invalidation Text ${Date.now()}`;
    await writeFile(contentDocPath, updatedText, "utf8");

    // Page updates with the new build script output
    await expect(page.locator("h1")).toHaveText(updatedText, {
      timeout: 15000,
    });
  });

  test("maintains isolated build script cache entries across different pages using the same script", async ({
    page,
  }) => {
    await page.goto("/build-script-page-env-test");
    const textA = await page.locator("#page-file").textContent();
    expect(textA).toContain("build-script-page-env-test.html");

    await page.goto("/build-script-page-env-test-b");
    const textB = await page.locator("#page-file").textContent();
    expect(textB).toContain("build-script-page-env-test-b.html");
    expect(textB).not.toContain("build-script-page-env-test.html");
  });

  // ── 8. Build-error overlay: error is delivered exactly once and clears on recovery ──

  test("shows a located build-error overlay on a compile error and recovers on a valid edit", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // Remove the body content so transpilation throws a validate-markup
    // PageProcessingError. This is a genuine, script-independent failure not
    // gated by the harness's on*ScriptError: 'warn' settings, so it must be
    // published as a located build-error event (not just logged) for the
    // overlay to appear.
    const broken = originalPageContent.replace(
      /<body>[\s\S]*<\/body>/,
      "<body></body>",
    );
    await writeFile(pagePath, broken, "utf8");

    const overlay = page.getByTestId("bascik-build-error-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay).toContainText("body");

    // Restore a valid page: the overlay clears and the page reloads.
    await writeFile(pagePath, originalPageContent, "utf8");
    await expect(overlay).not.toBeAttached({ timeout: 15000 });
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );
  });

  test("shows the overlay when a component fails to load, and clears it when the component is fixed", async ({
    page,
  }) => {
    await page.goto("/scope-test");
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // A component that cannot be loaded fails before any page is built, so there is no page to attach
    // the error to. This bug class hid because the failure was only logged, never sent to the browser.
    // A static `export` in a classic inline TypeScript script is used because, unlike a failing build
    // script, it is not downgraded to a warning by this harness's `on*ScriptError: 'warn'` settings. It
    // fails whatever TypeScript compiler is configured (this harness uses esbuild, which accepts `enum`).
    const broken =
      originalComponentContent +
      '\n<script type="text/typescript">export const broken = 1;</script>\n';
    await writeFile(componentPath, broken, "utf8");

    const overlay = page.getByTestId("bascik-build-error-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay).toContainText("TypeScript transformation failed");
    await expect(overlay).toHaveCount(1);

    // Fixing the component rebuilds the pages that use it, which clears the overlay and reloads.
    await writeFile(componentPath, originalComponentContent, "utf8");
    await expect(overlay).not.toBeAttached({ timeout: 15000 });
    await expect(page.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );
  });

  test("delivers a build-error to each open tab of the affected page exactly once", async ({
    context,
  }) => {
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    await tab1.goto("/scope-test");
    await tab2.goto("/scope-test");
    await expect(tab1.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );
    await expect(tab2.locator("h1")).toHaveText(
      "JS Scope Rewriting — Live Test",
    );

    // Per-page error isolation: only tabs on the failed page receive the
    // overlay, and each receives exactly one instance (single-owner broadcast).
    const broken = originalPageContent.replace(
      /<body>[\s\S]*<\/body>/,
      "<body></body>",
    );
    await writeFile(pagePath, broken, "utf8");

    const overlay1 = tab1.getByTestId("bascik-build-error-overlay");
    const overlay2 = tab2.getByTestId("bascik-build-error-overlay");
    await expect(overlay1).toBeVisible({ timeout: 15000 });
    await expect(overlay2).toBeVisible({ timeout: 15000 });
    await expect(overlay1).toHaveCount(1);
    await expect(overlay2).toHaveCount(1);

    await tab1.close();
    await tab2.close();
  });

  // ── 9. Missing-import recovery: creating a previously missing helper rebuilds the page ──

  test("creates a previously missing imported helper to recover the page without a page edit", async ({
    page,
  }) => {
    await page.goto("/missing-recovery-test");
    await expect(page.getByTestId("failed-import-marker")).toHaveText(
      "missing-recovery-helper-v1",
    );

    // Delete the imported helper. The failed compile (or a harness-swallowed
    // import failure) must still record the attempted dependency so the
    // import-root watcher knows to rebuild this page when the helper reappears.
    await rm(missingHelperPath, { force: true });
    await page.waitForTimeout(500);

    // Recreate the precise helper with new content. The import-root watcher
    // must route the add through the failed-dependency index and rebuild this
    // page automatically, with no further page edit or reload.
    await writeFile(
      missingHelperPath,
      "export const recoveryMarker = (): string => 'missing-recovery-helper-v2';\n",
      "utf8",
    );

    await expect(page.getByTestId("failed-import-marker")).toHaveText(
      "missing-recovery-helper-v2",
      { timeout: 15000 },
    );
  });
});

test.describe("Dev Server HTTP Protocol & Security Headers", () => {
  test("includes security headers and no-cache controls in dev mode responses", async ({
    request,
  }) => {
    const res = await request.get("/scope-test");
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers["content-type"]).toContain("text/html");
    expect(headers["cache-control"]).toContain("no-cache");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("handles HEAD requests with 200 OK and empty body", async ({
    request,
  }) => {
    const res = await request.head("/scope-test");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    const body = await res.body();
    expect(body.length).toBe(0);
  });

  test("returns 405 Method Not Allowed for POST requests", async ({
    request,
  }) => {
    const res = await request.post("/scope-test");
    expect(res.status()).toBe(405);
    expect(res.headers()["allow"]).toBe("GET, HEAD");
  });

  test("rejects path traversal attempts with 400 Bad Request", async ({
    request,
  }) => {
    const res1 = await request.get("/../../../etc/passwd");
    // HTTP/1.1 clients (like Playwright in dev mode) may normalize the path to /etc/passwd
    // on the client side before sending, which results in 404 Not Found, while HTTP/2 keeps it as 400.
    expect([400, 404]).toContain(res1.status());

    const res2 = await request.get("/..%2f..%2f..%2fetc/passwd");
    expect(res2.status()).toBe(400);
  });
});

test.describe("Dev Server In-Memory Routing & Brotli Compression", () => {
  test("serves in-memory pages with trailing slash normalization", async ({
    page,
  }) => {
    const resExact = await page.goto("/scope-test");
    expect(resExact?.status()).toBe(200);

    const resSlash = await page.goto("/scope-test/");
    expect(resSlash?.status()).toBe(200);
  });

  test("serves Brotli-compressed content when client sends Accept-Encoding: br", async ({
    request,
  }) => {
    const res = await request.get("/scope-test", {
      headers: { "accept-encoding": "br" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-encoding"]).toBe("br");
  });

  test("falls back to gzip when the client sends Accept-Encoding without br", async ({
    request,
  }) => {
    const res = await request.get("/scope-test", {
      headers: { "accept-encoding": "gzip, deflate" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-encoding"]).toBe("gzip");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("returns 404 for non-existent page routes", async ({ page }) => {
    const response = await page.goto("/nonexistent-dev-route-12345");
    expect(response?.status()).toBe(404);
  });
});

test.describe("Dev Server Request-Time Scripts (data-bascik-server)", () => {
  test("executes server scripts on request in dev mode", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-test-name": "DevUser" });
    await page.goto("/server-scripts-test?color=cyan");

    await expect(page.locator("#from-header")).toHaveText("DevUser");
    await expect(page.locator("#from-query")).toHaveText("cyan");
    await expect(page.locator("#from-path")).toHaveText("/server-scripts-test");
    await expect(page.locator("#from-async")).toHaveText("async-ok");
  });

  test("supports Node.js ESM imports, component server scripts, and ANSI stripping in dev mode", async ({
    page,
  }) => {
    await page.goto("/server-scripts-advanced-test");

    await expect(page.locator("#esm-import-output")).toHaveText(
      "ESM Import: server-scripts-advanced-test | Method: GET",
    );
    await expect(page.locator('[class*="server-comp-static"]')).toHaveText(
      "Component Static",
    );
    await expect(page.locator('[id$="__comp-server-output"]')).toHaveText(
      "Comp Server: GET",
    );
    await expect(page.locator("#ansi-output")).toHaveText("Clean HTML");
  });
});

test.describe("Dev Server component edits used only in script output (prompt 157)", () => {
  // `server-card` appears in no page's markup: its only usages are the strings
  // the server scripts on /server-components return. The page therefore has
  // no component dependency for the watcher to follow; what links them is the
  // request-time manifest, rebuilt on any component-list invalidation, and the
  // reload the dev server publishes for every open page that has a
  // server-script plan.
  const serverCardPath = join(
    e2eDir,
    "src/components/server-card/server-card.html",
  );
  const INSTANCES = 3;
  let originalServerCard: string;

  const countOf = (html: string, marker: string): number =>
    html.split(marker).length - 1;

  test.beforeAll(async () => {
    originalServerCard = await readFile(serverCardPath, "utf8");
  });

  test.afterEach(async () => {
    const current = await readFile(serverCardPath, "utf8").catch(() => null);
    if (current !== originalServerCard) {
      const { reload } = await subscribeToServerReload("/server-components");
      await writeFile(serverCardPath, originalServerCard, "utf8");
      await reload.catch(() => {});
    }
  });

  test("editing a component used only in server-script output reloads the open server page and the next response renders the new template", async ({
    page,
  }) => {
    await page.goto("/server-components");
    const versions = page.getByTestId("server-card-version");
    await expect(versions).toHaveCount(INSTANCES);
    await expect(versions.first()).toHaveText("server-card-v1");

    const marker = `server-card-v2-${Date.now()}`;
    const start = performance.now();
    await writeFile(
      serverCardPath,
      originalServerCard.replace("server-card-v1", marker),
      "utf8",
    );

    // The tab reloads over SSE and every instance renders the edited template.
    await expect(page.getByTestId("server-card-version").first()).toHaveText(
      marker,
      { timeout: 15000 },
    );
    await expect(page.getByTestId("server-card-version")).toHaveText(
      Array.from({ length: INSTANCES }, () => marker),
    );
    expect(performance.now() - start).toBeLessThan(5000);
  });

  test("a request during the rebuild renders a single version of the component", async ({
    request,
  }) => {
    const before = await (await request.get("/server-components")).text();
    expect(countOf(before, "server-card-v1")).toBe(INSTANCES);

    const marker = `server-card-v2-${Date.now()}`;
    await writeFile(
      serverCardPath,
      originalServerCard.replace("server-card-v1", marker),
      "utf8",
    );

    // Every response between the write and the first fully new one is either
    // all old or all new: a page always renders with the manifest it was
    // stored with, never a mix.
    await expect
      .poll(
        async () => {
          const html = await (await request.get("/server-components")).text();
          const oldCount = countOf(html, "server-card-v1");
          const newCount = countOf(html, marker);
          expect(oldCount + newCount, html).toBe(INSTANCES);
          expect(oldCount === 0 || newCount === 0, html).toBe(true);
          return newCount;
        },
        { timeout: 15000 },
      )
      .toBe(INSTANCES);
  });
});

test.describe("Dev Server API Route Module Reload (prompt 112)", () => {
  // A route no other spec requests: production lanes running alongside import
  // API handlers from this same source tree on first request, so editing a
  // shared route such as health.ts could leak into them.
  const apiRoutePath = join(e2eDir, "src/api/reload-probe.ts");
  let originalHealthRoute: string;

  test.beforeAll(async () => {
    originalHealthRoute = await readFile(apiRoutePath, "utf8");
  });

  test.afterEach(async () => {
    if (await restoreFileIfChanged(apiRoutePath, originalHealthRoute)) {
      // Wait until the restored module is served again so the next suite never
      // observes this test's edit. Event-driven: polls the live route.
      await expect
        .poll(
          async () => {
            const res = await fetch(`${laneOrigin()}/api/reload-probe`);
            return (await res.json()).status;
          },
          { timeout: 15000 },
        )
        .toBe("healthy");
    }
  });

  test("serves the edited API route handler on the next request without a restart", async ({
    request,
  }) => {
    const before = await request.get("/api/reload-probe");
    expect(before.status()).toBe(200);
    expect((await before.json()).status).toBe("healthy");

    const marker = `reloaded-${Date.now()}`;
    await writeFile(
      apiRoutePath,
      originalHealthRoute.replace('status: "healthy"', `status: "${marker}"`),
      "utf8",
    );

    // The watcher debounces the write and invalidates the module identity; the
    // next request after invalidation must load the new code. Polling the
    // route is the observable boundary a developer sees.
    await expect
      .poll(
        async () => {
          const res = await request.get("/api/reload-probe");
          return (await res.json()).status;
        },
        { timeout: 15000 },
      )
      .toBe(marker);
  });
});

test.describe("Dev Server Startup Output", () => {
  test("startup logs do not contain duplicate transpiled page entries or duplicate completion summaries", async () => {
    const entryPath = join(pkgDir, "bin/bascik.js");
    const fixtureDir = await mkdtemp(join(tmpdir(), "bascik-dev-startup-"));
    await Promise.all([
      mkdir(join(fixtureDir, "src/pages"), { recursive: true }),
      mkdir(join(fixtureDir, "src/components"), { recursive: true }),
    ]);
    await writeFile(
      join(fixtureDir, "src/pages/index.html"),
      "<!DOCTYPE html><html><head><title>Startup</title></head><body><h1>Startup</h1></body></html>",
      "utf8",
    );
    const child = spawn(process.execPath, [entryPath], {
      cwd: fixtureDir,
      env: { ...process.env, BASCIK_SERVER_PORT: "9989" },
    });

    let output = "";
    let bootCompleted = false;
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 15000);

        const captureOutput = (data: Buffer): void => {
          output += stripVTControlCharacters(data.toString("utf8"));
          if (output.includes("All tasks completed in")) {
            bootCompleted = true;
            child.kill();
          }
        };
        child.stdout?.on("data", captureOutput);
        child.stderr?.on("data", captureOutput);

        child.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on("exit", (code) => {
          clearTimeout(timeout);
          if (bootCompleted) {
            resolve();
          } else if (timedOut) {
            reject(
              new Error(
                `Dev server startup timed out. Output captured:\n${output}`,
              ),
            );
          } else {
            reject(
              new Error(
                `Dev server exited prematurely with code ${code}. Output:\n${output}`,
              ),
            );
          }
        });
      });
    } finally {
      if (!child.killed) child.kill();
      await rm(fixtureDir, { recursive: true, force: true });
    }

    const lines = output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // 1. Check transpiled page lines: each page path should be transpiled exactly once
    const transpiledLines = lines.filter((l) => l.startsWith("transpiled:"));
    expect(transpiledLines.length).toBeGreaterThan(0);

    const uniqueTranspiled = new Set(transpiledLines);
    expect(transpiledLines.length).toBe(uniqueTranspiled.size);

    // 2. Check summary line: exactly one "✓ N pages transpiled in Xms" before server ready.
    // A site with build scripts appends "(N build scripts ran, M from cache)".
    const summaryLines = lines.filter((l) =>
      /^✓ \d+ pages? transpiled in (?:[<]?[\d.]+(?:ms|s))(?: \(\d+ build scripts? ran, \d+ from cache\))?$/.test(
        l,
      ),
    );
    expect(summaryLines.length).toBe(1);
  });
});

/**
 * The environment for a dev server a test starts itself in this fixture.
 * The Playwright worker carries the lane's BASCIK_E2E_OUT (dist-dev), which
 * is the lane's own dev server's output directory: a child booting into it
 * cleared it while that server was writing there, failed with "ENOTEMPTY:
 * directory not empty, rmdir", and exited during boot (seen as a 20 s wait
 * for "Server running at" under yarn pkg:e2e:all). Each child gets its own.
 */
const childServerEnv = (port: string): NodeJS.ProcessEnv => ({
  ...process.env,
  BASCIK_SERVER_PORT: port,
  BASCIK_E2E_OUT: childServerOut(port),
});
const childServerOut = (port: string): string => `dist-dev-child-${port}`;
const removeChildServerOut = (port: string): Promise<void> =>
  rm(join(e2eDir, childServerOut(port)), { recursive: true, force: true });

const stopChildServer = async (
  child: ReturnType<typeof spawn>,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill();
  });
};

test.describe("Dev Server Cold Start & Boot Loading Screen", () => {
  test("survives an invalid page at boot and serves the fixed page without restarting", async ({
    page,
  }) => {
    const entryPath = join(pkgDir, "bin/bascik.js");
    const brokenPagePath = join(e2eDir, "src/pages/dev-recovery-test.html");
    const port = "9993";
    const baseUrl = `http://localhost:${port}`;
    await writeFile(
      brokenPagePath,
      "<!DOCTYPE html><html><head><title>Broken</title></head></html>",
      "utf8",
    );

    const child = spawn(process.execPath, [entryPath], {
      cwd: e2eDir,
      env: childServerEnv(port),
    });
    let output = "";
    let exited = false;
    const captureOutput = (data: Buffer): void => {
      output += stripVTControlCharacters(data.toString("utf8"));
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);
    child.on("exit", () => {
      exited = true;
    });

    try {
      await expect
        .poll(() => output.includes("All tasks completed in"), {
          timeout: 20000,
          message:
            "Dev server did not finish booting after encountering an invalid page",
        })
        .toBe(true);
      expect(exited).toBe(false);

      const brokenResponse = await fetch(`${baseUrl}/dev-recovery-test`);
      expect(brokenResponse.status).toBe(404);
      expect(await brokenResponse.text()).not.toContain("Building site");

      const healthyResponse = await fetch(`${baseUrl}/scope-test`);
      expect(healthyResponse.status).toBe(200);

      const recoveredText = `Recovered ${Date.now()}`;
      await writeFile(
        brokenPagePath,
        `<!DOCTYPE html><html><head><title>Recovered</title></head><body><h1 data-testid="recovered-page">${recoveredText}</h1></body></html>`,
        "utf8",
      );

      await expect
        .poll(
          async () => {
            const response = await fetch(`${baseUrl}/dev-recovery-test`);
            return response.status;
          },
          { timeout: 15000 },
        )
        .toBe(200);
      await page.goto(`${baseUrl}/dev-recovery-test`);
      await expect(page.getByTestId("recovered-page")).toHaveText(
        recoveredText,
      );
      expect(exited).toBe(false);
    } finally {
      await stopChildServer(child);
      await rm(brokenPagePath, { force: true });
      await removeChildServerOut(port);
    }
  });

  // The boot page answers only while the initial transpile is still running
  // and only for a page not yet in memory: alone that window is under a
  // second for /index.html, and under load it may pass before the first
  // request lands. So the test holds the transpile open itself: a gate page
  // whose build script waits for a file the test writes only after it has
  // seen the boot page, which makes the boot page's assertion unconditional.
  // The server is polled until it binds (the child's output is shown if it
  // exits first), never for a fixed number of attempts.
  test("serves boot loading screen during cold start before initial transpile completes and resolves pages afterwards", async () => {
    test.setTimeout(150_000);
    const entryPath = join(pkgDir, "bin/bascik.js");
    const cacheDir = join(e2eDir, "node_modules/.cache/bascik");
    await rm(cacheDir, { recursive: true, force: true });

    const gateDir = await mkdtemp(join(tmpdir(), "bascik-boot-gate-"));
    const gateFile = join(gateDir, "release");
    const gatePagePath = join(e2eDir, `src/pages/${BOOT_GATE_PAGE}`);
    // Released by the test's file, by the test's cleanup removing the gate
    // directory, or when this Playwright worker is gone (killed on a
    // timeout, Ctrl-C), so an interrupted run never holds a later build.
    // run-lanes.ts also removes a gate page a killed run left behind.
    const gatePage = `<!doctype html><html><head><title>Boot gate</title></head><body>
<script data-bascik-build>
import { existsSync } from "node:fs";
export default async function () {
  // Held until the test has seen the boot page (dev-server-reload.test.ts).
  const owner = ${process.pid};
  const alive = () => {
    try {
      process.kill(owner, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 50000;
  while (
    existsSync(${JSON.stringify(gateDir)}) &&
    !existsSync(${JSON.stringify(gateFile)}) &&
    alive() &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  return '<p data-testid="boot-gate">gate released</p>';
}
</script>
</body></html>
`;
    const port = "9992";
    const baseUrl = `http://localhost:${port}`;
    let child: ReturnType<typeof spawn> | undefined;
    let bootFinished = false;
    let output = "";
    const exited = (): boolean =>
      child !== undefined &&
      (child.exitCode !== null || child.signalCode !== null);

    try {
      await writeFile(gatePagePath, gatePage, "utf8");
      child = spawn(process.execPath, [entryPath], {
        cwd: e2eDir,
        env: childServerEnv(port),
      });
      const captureOutput = (data: Buffer): void => {
        output += stripVTControlCharacters(data.toString("utf8"));
        bootFinished = output.includes("All tasks completed in");
      };
      child.stdout?.on("data", captureOutput);
      child.stderr?.on("data", captureOutput);

      // 1. Poll until the server binds and answers. The gate page cannot be
      //    in memory yet, so it gets the boot page.
      let bootPage: { status: number; html: string } | null = null;
      await expect
        .poll(
          async () => {
            if (exited())
              throw new Error(`dev server exited during boot:\n${output}`);
            try {
              const res = await fetch(`${baseUrl}/${BOOT_GATE_PAGE}`);
              bootPage = { status: res.status, html: await res.text() };
              return true;
            } catch {
              return false; // connection refused while the server starts
            }
          },
          { timeout: 60000, intervals: [50] },
        )
        .toBe(true);

      // 2. The boot loading screen, while the initial transpile is held.
      expect(bootPage!.status).toBe(200);
      expect(bootPage!.html).toContain("Building site");
      expect(bootFinished).toBe(false);

      // 3. Release the transpile and wait for boot to complete.
      await writeFile(gateFile, "go", "utf8");
      await expect
        .poll(
          () => {
            if (exited() && !bootFinished)
              throw new Error(`dev server exited during boot:\n${output}`);
            return bootFinished;
          },
          { timeout: 60000 },
        )
        .toBe(true);

      // 4. Every page resolves with its transpiled content, the gate page
      //    included, and none of them is the boot page.
      const gateRes = await fetch(`${baseUrl}/${BOOT_GATE_PAGE}`);
      expect(gateRes.status).toBe(200);
      const gateText = await gateRes.text();
      expect(gateText).not.toContain("Building site");
      expect(gateText).toContain("gate released");

      const indexHtmlRes = await fetch(`${baseUrl}/index.html`);
      expect(indexHtmlRes.status).toBe(200);
      const indexText = await indexHtmlRes.text();
      expect(indexText).not.toContain("Building site");
      expect(indexText).toMatch(/<!doctype html>/i);

      const rootRes = await fetch(`${baseUrl}/`);
      expect(rootRes.status).toBe(200);
      const rootText = await rootRes.text();
      expect(rootText).not.toContain("Building site");

      const scopeRes = await fetch(`${baseUrl}/scope-test.html`);
      expect(scopeRes.status).toBe(200);
      const scopeText = await scopeRes.text();
      expect(scopeText).not.toContain("Building site");
      expect(scopeText).toContain("JS Scope Rewriting");
    } finally {
      // Release the main dev server's compile of the gate page too.
      await writeFile(gateFile, "go", "utf8").catch(() => {});
      if (child) await stopChildServer(child);
      await rm(gatePagePath, { force: true });
      await rm(gateDir, { recursive: true, force: true });
      await removeChildServerOut(port);
    }
  });

  // Prompt 146: dev server SSE shutdown hang
  // In dev mode, HTML pages connect the injected live-reload EventSource to /bascik-live-reload.
  // When SIGINT is received, the SSE manager's shutdown handler must terminate active SSE responses
  // so the server does not hang waiting on open sockets until the drain timeout.
  // Note: curl alone cannot exercise browser reconnect logic; a real browser tab with EventSource is required.
  test("shuts down cleanly on SIGINT in under 1500ms with an open browser tab connected to live reload", async ({
    page,
  }) => {
    const entryPath = join(pkgDir, "bin/bascik.js");
    const port = "9993";
    const baseUrl = `http://localhost:${port}`;
    const child = spawn(process.execPath, [entryPath], {
      cwd: e2eDir,
      env: childServerEnv(port),
    });

    let output = "";
    const captureOutput = (data: Buffer): void => {
      output += stripVTControlCharacters(data.toString("utf8"));
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    try {
      // Boot here is a few seconds even under load. A child that exits
      // first fails at once with its output, not after the poll's timeout.
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`dev server exited during boot:\n${output}`);
            return output.includes("Server running at");
          },
          { timeout: 20000, message: "dev server did not finish booting" },
        )
        .toBe(true);
      expect(output).toContain(`Server running at ${baseUrl}`);

      // Open a real page in the browser that connects the injected live-reload EventSource
      await page.goto(`${baseUrl}/server-scripts-resilience-test.html`);
      await expect(page.getByTestId("resilience-before")).toBeVisible({
        timeout: 15000,
      });

      // Send SIGINT and verify clean exit in under 1500ms
      const startTime = Date.now();
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      child.kill("SIGINT");
      const { code } = await exitPromise;
      const durationMs = Date.now() - startTime;

      expect(code).toBe(0);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      await stopChildServer(child);
      await removeChildServerOut(port);
    }
  });
});
