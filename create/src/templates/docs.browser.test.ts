/// <reference lib="dom" />
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { scaffold } from "../scaffold.js";
import { DOCS_TEMPLATE } from "./docs.js";

// Every browser test here opens a page on a production server. The default 5s
// is too short on a loaded Windows runner; tests that need longer say so.
vi.setConfig({ testTimeout: 30_000 });

const exec = promisify(execFile);
const repo = resolve(fileURLToPath(import.meta.url), "../../../..");
const port = 19451;
const origin = `http://127.0.0.1:${port}`;
let scratch: string;
let server: ChildProcess;
let browser: Browser;
let logs = "";
let projectRoot: string;

beforeAll(async () => {
  await mkdir(join(repo, ".headroom"), { recursive: true });
  scratch = await mkdtemp(join(repo, ".headroom/docs-feedback-"));
  await scaffold("docs", scratch, { template: DOCS_TEMPLATE });
  const root = join(scratch, "docs");
  projectRoot = root;
  await mkdir(join(root, "node_modules/@bascik"), { recursive: true });
  await symlink(join(repo, "pkg"), join(root, "node_modules/@bascik/bascik"));
  for (const dependency of ["marked", "vitest", "vite"]) {
    await symlink(
      join(repo, "node_modules", dependency),
      join(root, "node_modules", dependency),
    );
  }
  await mkdir(join(root, "node_modules/@playwright"), { recursive: true });
  await symlink(
    join(repo, "node_modules/@playwright/test"),
    join(root, "node_modules/@playwright/test"),
  );
  await writeFile(
    join(root, "production-test.config.ts"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "app.spec.ts", workers: 1,
  use: { baseURL: "${origin}", browserName: "chromium", viewport: { width: 1280, height: 900 } },
});
`,
  );
  const cli = join(repo, "pkg/bin/bascik.js");
  await exec(process.execPath, [cli, "--build"], {
    cwd: root,
    env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
    timeout: 120_000,
  });
  await exec(process.execPath, [cli, "--check"], {
    cwd: root,
    timeout: 120_000,
  });
  const units = await exec(
    process.execPath,
    [join(repo, "node_modules/vitest/vitest.mjs"), "run", "--reporter=dot"],
    { cwd: root, timeout: 120_000 },
  );
  console.info(
    units.stdout
      .split("\n")
      .filter((line) => /^\s*(Test Files|Tests)\s/.test(line))
      .join("\n"),
  );
  for (const audit of [
    "skills/bascik/scripts/check-links.mjs",
    "skills/bascik/scripts/audit-components.mjs",
    "skills/bascik-components/scripts/check-tokens.mjs",
    "skills/bascik-config/scripts/audit-config.mjs",
  ]) {
    try {
      await exec(process.execPath, [join(repo, audit)], {
        cwd: root,
        timeout: 120_000,
      });
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${audit}: ${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
  }
  server = spawn(
    process.execPath,
    [cli, "--server", "--port", String(port), "--host", "127.0.0.1"],
    { cwd: root },
  );
  server.stdout?.on("data", (data) => {
    logs += String(data);
  });
  server.stderr?.on("data", (data) => {
    logs += String(data);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(origin)).ok;
    } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error(`Production server failed: ${logs}`);
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("freshly scaffolded production docs", () => {
  it("passes the generated browser suite against the fresh production server", async () => {
    const result = await exec(
      process.execPath,
      [
        join(repo, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        "production-test.config.ts",
        "--reporter=dot",
      ],
      { cwd: projectRoot, timeout: 120_000 },
    ).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error && "stderr" in error) {
        throw new Error(
          `${error.message}\n${String(error.stdout)}\n${String(error.stderr)}`,
          { cause: error },
        );
      }
      throw error;
    });
    console.info(
      result.stdout
        .split("\n")
        .filter((line) => /\d+ passed/.test(line))
        .join("\n"),
    );
  }, 150_000);
  it("starts directly in docs, with no stylesheet request or initial animation", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(origin);
    expect(await page.getByTestId("docs-article").count()).toBe(1);
    expect(await page.getByTestId("docs-sidebar").count()).toBe(1);
    expect(
      await page
        .getByTestId("docs-article")
        .getByRole("heading", { level: 1 })
        .textContent(),
    ).toBe("Getting started");
    expect(await page.getByTestId("site-header-logo").textContent()).toBe(
      "docs",
    );
    expect(
      await page.locator('link[rel="stylesheet"][href*="styles.css"]').count(),
    ).toBe(0);
    expect(
      requests.filter((url) => new URL(url).pathname.endsWith("/styles.css")),
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        [...document.body.querySelectorAll("*")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              box.top < innerHeight &&
              box.bottom > 0 &&
              style.visibility !== "hidden"
            );
          })
          .filter(
            (element) => getComputedStyle(element).animationName !== "none",
          )
          .map((element) => element.tagName),
      ),
    ).toEqual([]);
    expect(
      await page
        .getByTestId("docs-article")
        .evaluate((element) => getComputedStyle(element).opacity),
    ).toBe("1");
    expect(
      await page
        .getByTestId("site-header-logo")
        .evaluate((element) => getComputedStyle(element).textDecorationLine),
    ).toBe("none");
    const icon = await (
      await page.request.get(`${origin}/assets/favicon.svg`)
    ).text();
    expect(icon).toContain('points="10,3 28,3 23,29 4,29" fill="#d3ff8d"');
    for (const route of [
      "/",
      "/docs/writing-pages",
      "/docs/navigation-and-search",
      "/docs/components-and-design",
      "/docs/build-and-check",
      "/docs/deployment",
      "/404",
    ]) {
      await page.goto(`${origin}${route}`);
      expect(
        await page
          .locator('link[rel="stylesheet"][href*="styles.css"]')
          .count(),
      ).toBe(0);
      expect(
        (await page.getByTestId("theme-toggle").textContent())?.trim(),
      ).toBe("");
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll("nav a")].every(
            (link) => getComputedStyle(link).textDecorationLine === "none",
          ),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() =>
          [...document.body.querySelectorAll("*")]
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.height > 0 &&
                box.top < innerHeight &&
                box.bottom > 0
              );
            })
            .every(
              (element) => getComputedStyle(element).animationName === "none",
            ),
        ),
      ).toBe(true);
    }
    expect(
      requests.filter((url) => new URL(url).pathname.endsWith("/styles.css")),
    ).toEqual([]);
    await context.close();
  });

  it("offers an icon-only keyboard theme control, persisting both states on reload", async () => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(origin);
    const toggle = page.getByTestId("theme-toggle");
    expect((await toggle.textContent())?.trim()).toBe("");
    expect(await toggle.getAttribute("aria-label")).toBe("Toggle dark mode");
    expect(await toggle.locator("svg").count()).toBe(2);
    for (const theme of ["dark", "light"]) {
      await toggle.focus();
      await page.keyboard.press("Enter");
      expect(
        await page.evaluate(() => document.documentElement.dataset.theme),
      ).toBe(theme);
      await page.reload();
      expect(
        await page.evaluate(() => document.documentElement.dataset.theme),
      ).toBe(theme);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      ).toBe(theme);
      expect(await toggle.getAttribute("aria-pressed")).toBe(
        String(theme === "dark"),
      );
    }
    await context.close();
  });

  it("preserves root search, pagination, and the TOC bottom/fragment regression", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByTestId("site-header-skip-link")
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("Control+k");
    expect(await page.getByTestId("docs-search-dialog").isVisible()).toBe(true);
    await page.getByTestId("docs-search-input").fill("front matter");
    await page
      .getByTestId("docs-search-results")
      .getByRole("link", { name: /Writing pages/ })
      .click();
    expect(new URL(page.url()).pathname).toBe("/docs/writing-pages");
    await page.getByTestId("docs-pagination-previous").click();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.goto(`${origin}/docs/navigation-and-search`);
    const toc = page.getByTestId("docs-toc-nav");
    await page.keyboard.press("End");
    await new Promise((done) => setTimeout(done, 600));
    expect(await toc.locator('[aria-current="location"]').textContent()).toBe(
      "Table of contents",
    );
    await page.keyboard.press("Home");
    await new Promise((done) => setTimeout(done, 600));
    expect(await toc.locator('[aria-current="location"]').textContent()).toBe(
      "Sidebar",
    );
    await toc
      .getByRole("link", { name: "Table of contents", exact: true })
      .click();
    await new Promise((done) => setTimeout(done, 600));
    expect(await toc.locator('[aria-current="location"]').textContent()).toBe(
      "Table of contents",
    );
    await page.goto(`${origin}/docs/navigation-and-search#open-search`);
    await new Promise((done) => setTimeout(done, 600));
    expect(await toc.locator('[aria-current="location"]').textContent()).toBe(
      "Open search",
    );
    await context.close();
  });

  it("stays usable across responsive themes, reduced motion, and without JavaScript", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      for (const width of [320, 375, 768, 1440]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.goto(origin);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(await page.getByTestId("docs-article").isVisible()).toBe(true);
        if (width < 760) {
          // The header's menu lists the pages at phone width, and ends with the theme switch.
          expect(await page.getByTestId("docs-sidebar").isVisible()).toBe(
            false,
          );
          await page.getByTestId("site-header-nav-toggle").click();
          expect(
            await page.getByTestId("site-header-nav-menu").isVisible(),
          ).toBe(true);
          expect(
            (
              await page.getByTestId("site-header-mobile-theme").innerText()
            ).trim(),
          ).toBe(colorScheme === "dark" ? "Light" : "Dark");
        }
        if (width === 320 || width === 1440) {
          await page.screenshot({
            path: join(repo, ".headroom", `docs-${colorScheme}-${width}.png`),
          });
        }
        await context.close();
      }
    }
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 375, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(origin);
    expect(await page.getByTestId("docs-sidebar-menu").isVisible()).toBe(true);
    await page
      .getByTestId("docs-sidebar")
      .getByRole("link", { name: "Writing pages" })
      .click();
    expect(new URL(page.url()).pathname).toBe("/docs/writing-pages");
    await context.close();
  }, 60_000);
});
