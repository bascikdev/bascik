/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scaffold.ts";
import { FAVICON_SVG } from "../scaffold.ts";
import { BLOG_TEMPLATE } from "./blog.ts";
import { SAMPLE_POSTS } from "./blog/content.ts";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");

describe("fresh production blog in Chromium", () => {
  it("keeps the editorial layout, theme and content usable from first paint", async () => {
    const scratch = join(root, ".headroom");
    await mkdir(scratch, { recursive: true });
    const parent = await mkdtemp(join(scratch, "blog-browser-"));
    const project = join(parent, "my-blog");
    let server: ReturnType<typeof spawn> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await scaffold("my-blog", parent, { template: BLOG_TEMPLATE });
      await mkdir(join(project, "node_modules/@bascik"), { recursive: true });
      await symlink(
        join(root, "pkg"),
        join(project, "node_modules/@bascik/bascik"),
        "dir",
      );
      await mkdir(join(project, "node_modules/@playwright"), {
        recursive: true,
      });
      await symlink(
        join(root, "node_modules/@playwright/test"),
        join(project, "node_modules/@playwright/test"),
        "dir",
      );
      await mkdir(join(project, "node_modules/.bin"), { recursive: true });
      await symlink(
        join(root, "pkg/bin/bascik.js"),
        join(project, "node_modules/.bin/bascik"),
      );
      await symlink(
        join(root, "node_modules/marked"),
        join(project, "node_modules/marked"),
        "dir",
      );
      const cli = join(root, "pkg/bin/bascik.js");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [cli, "--build"],
        {
          cwd: project,
          env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
          timeout: 90_000,
        },
      );
      console.log(
        stdout
          .match(/^.*(?:pages transpiled|Build complete).*$/gim)
          ?.join("\n") ?? "Production build completed",
      );
      await promisify(execFile)(process.execPath, [cli, "--check"], {
        cwd: project,
        timeout: 90_000,
      });
      const dist = join(project, "dist");
      const pages = (await readdir(dist, { recursive: true })).filter((path) =>
        path.endsWith(".html"),
      );
      expect(pages.length).toBeGreaterThan(0);
      for (const path of pages) {
        const html = await readFile(join(dist, path), "utf8");
        expect(html, path).not.toMatch(
          /<link\b[^>]*href=["'][^"']*(?:styles|blog)\.css\b/i,
        );
      }
      expect(
        await readFile(join(project, "dist/assets/favicon.svg"), "utf8"),
      ).toBe(FAVICON_SVG);
      const port = Number(process.env.BLOG_TEST_PORT ?? 19431);
      const url = `http://127.0.0.1:${port}`;
      server = spawn(
        process.execPath,
        [cli, "--server", "--port", String(port)],
        { cwd: project },
      );
      let output = "";
      server.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      server.stderr?.on("data", (chunk) => {
        output += chunk;
      });
      await expect
        .poll(
          async () => {
            if (server!.exitCode !== null) throw new Error(output);
            return fetch(url).then(
              () => true,
              () => false,
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      browser = await chromium.launch();
      const context = await browser.newContext();
      const errors: string[] = [];
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      const styles: string[] = [];
      page.on("request", (request) => {
        if (
          request.resourceType() === "stylesheet" ||
          /\/(?:styles|blog)\.css(?:[?#]|$)/.test(request.url())
        )
          styles.push(request.url());
      });
      await page.addInitScript(() => {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const aboveFold = ["site-header", "site-intro", "home-main"].map(
              (testId) => document.querySelector(`[data-testid="${testId}"]`),
            );
            (window as Window & { firstBlogPaint?: unknown }).firstBlogPaint = {
              opacity: aboveFold.map((el) =>
                el ? getComputedStyle(el).opacity : null,
              ),
              animation: aboveFold.map((el) =>
                el ? getComputedStyle(el).animationName : null,
              ),
            };
          },
          { once: true },
        );
      });
      await page.goto(url);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { firstBlogPaint?: unknown }).firstBlogPaint,
        ),
      ).toEqual({
        opacity: ["1", "1", "1"],
        animation: ["none", "none", "none"],
      });
      const favicon = await page.evaluate(async () => {
        const link = document.querySelector<HTMLLinkElement>(
          'link[rel="icon"][type="image/svg+xml"]',
        );
        if (!link) throw new Error("Missing SVG favicon link");
        const response = await fetch(link.href);
        if (!response.ok) throw new Error(`Favicon HTTP ${response.status}`);
        return response.text();
      });
      expect(favicon).toBe(FAVICON_SVG);
      expect(favicon).toContain('points="10,3 28,3 23,29 4,29" fill="#d3ff8d"');
      expect(favicon).toContain('rx="1" fill="#0e0f10"');
      expect(styles).toEqual([]);
      const toggle = page.getByTestId("theme-toggle");
      await browserExpect(toggle).toHaveAccessibleName("Dark mode");
      await browserExpect(toggle).toHaveAttribute("aria-label", "Dark mode");
      expect((await toggle.textContent())?.trim()).toBe("");
      for (const theme of ["dark", "light"]) {
        if (
          ((await toggle.getAttribute("aria-pressed")) === "true") !==
          (theme === "dark")
        ) {
          await toggle.focus();
          await page.keyboard.press("Space");
        }
        expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
          theme,
        );
        await page.reload();
        expect(
          await page.evaluate(() => document.documentElement.dataset.theme),
        ).toBe(theme);
        await browserExpect(toggle).toHaveAttribute(
          "aria-pressed",
          String(theme === "dark"),
        );
        await browserExpect(toggle).toHaveAttribute("aria-label", "Dark mode");
        expect((await toggle.textContent())?.trim()).toBe("");
      }
      for (const path of pages) {
        await page.goto(
          `${url}/${path === "index.html" ? "" : path.replace(/index\.html$/, "")}`,
        );
        expect(
          await page
            .locator('link[href*="styles.css"], link[href*="blog.css"]')
            .count(),
        ).toBe(0);
      }
      expect(styles).toEqual([]);
      await page.goto(url);
      for (const width of [1440, 768, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"]) {
          if (
            ((await toggle.getAttribute("aria-pressed")) === "true") !==
            (theme === "dark")
          )
            await toggle.click();
          expect(
            await page.evaluate(() => document.documentElement.dataset.theme),
          ).toBe(theme);
          await browserExpect(page.getByTestId("author-sidebar")).toBeVisible();
          const sidebar = await page.getByTestId("site-header").boundingBox();
          const main = await page.getByTestId("home-main").boundingBox();
          if (width > 900)
            expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(main!.x);
          else
            expect(sidebar!.y + sidebar!.height).toBeLessThanOrEqual(main!.y);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(
            await page
              .getByTestId("site-header-blog")
              .evaluate((el) => getComputedStyle(el).textDecorationLine),
          ).toBe("none");
          if (
            process.env.BLOG_SCREENSHOTS === "1" &&
            [1440, 375].includes(width)
          )
            await page.screenshot({
              path: join(scratch, `blog-${width}-${theme}.png`),
              fullPage: true,
            });
        }
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await toggle.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect(
        await toggle.evaluate((el) => getComputedStyle(el).outlineStyle),
      ).not.toBe("none");
      expect(
        await toggle.evaluate((el) => getComputedStyle(el).transitionDuration),
      ).toBe("0s");
      await page.goto(`${url}/blog/${SAMPLE_POSTS[0][0]}/`);
      await browserExpect(
        page.getByTestId("post-author-context"),
      ).toContainText("John Doe");
      await browserExpect(
        page.getByTestId("post-author-context"),
      ).toContainText("placeholder");
      await browserExpect(page.getByTestId("post-article")).not.toContainText(
        /Hurley Haywood|Ross Bentley/,
      );
      const noJs = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 375, height: 812 },
      });
      const plain = await noJs.newPage();
      await plain.goto(`${url}/blog/`);
      await browserExpect(plain.getByTestId("site-header-blog")).toBeVisible();
      await browserExpect(plain.getByTestId("post-card-link")).toHaveCount(4);
      await browserExpect(plain.getByTestId("theme-toggle")).toBeHidden();
      await noJs.close();
      expect(errors).toEqual([]);
      expect(styles).toEqual([]);
      // Run the freshly generated app.spec.ts, not a copied repository fixture.
      // Override only the runner's port, since this test owns the already-built local server.
      await writeFile(
        join(project, "e2e/feedback.config.ts"),
        `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.', testMatch: 'app.spec.ts', workers: 1, use: { baseURL: '${url}', headless: true }, reporter: 'dot', outputDir: '../test-results' });\n`,
      );
      const generated = await promisify(execFile)(
        process.execPath,
        [
          join(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          "e2e/feedback.config.ts",
        ],
        {
          cwd: project,
          timeout: 90_000,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
      );
      console.log(generated.stdout.trim());
      console.log(
        "Browser: first paint, inline CSS, canonical favicon, keyboard theme persistence, 320/375/768/1440px both themes, reduced motion, author context, no-JS navigation passed.",
      );
    } finally {
      await browser?.close();
      if (server && server.exitCode === null) {
        const stopped = new Promise<void>((done) =>
          server!.once("exit", () => done()),
        );
        server.kill("SIGTERM");
        await stopped;
      }
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
