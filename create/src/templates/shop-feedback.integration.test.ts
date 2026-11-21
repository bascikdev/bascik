import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  scaffold,
  FAVICON_SVG,
  FAVICON_ICO_B64,
  FAVICON_32_PNG_B64,
} from "../scaffold.ts";
import { SHOP_TEMPLATE } from "./shop.ts";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const baseURL = "http://127.0.0.1:43931";
const cli = join(root, "pkg/bin/bascik.js");
const require = createRequire(import.meta.url);

it("uses the canonical docs favicon without recoloring or animation", async () => {
  expect(FAVICON_SVG).toBe(
    await readFile(join(root, "docs/src/pages/assets/favicon.svg"), "utf8"),
  );
});

async function run(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? done(output) : reject(new Error(output)),
    );
  });
}

it("fresh production shop: first paint, theme, product detail, mobile and cart", async () => {
  // Keep the fresh scaffold inside the assigned worktree, never in another site.
  await mkdir(join(root, "test-results"), { recursive: true });
  const parent = await mkdtemp(join(root, "test-results/shop-feedback-"));
  let server: ChildProcess | undefined;
  const browser = await chromium.launch();
  try {
    await scaffold("shop", parent, { template: SHOP_TEMPLATE });
    const cwd = join(parent, "shop");
    await mkdir(join(cwd, "node_modules/@bascik"), { recursive: true });
    await symlink(
      join(root, "pkg"),
      join(cwd, "node_modules/@bascik/bascik"),
      "dir",
    );
    for (const dependency of ["@playwright", "@types", "vitest", "vite"]) {
      await symlink(
        join(root, "node_modules", dependency),
        join(cwd, "node_modules", dependency),
        "dir",
      );
    }
    await run(cwd, [cli, "--build"]);
    console.log((await run(cwd, [cli, "--check"])).trim());
    const unitOutput = await run(cwd, [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--reporter=dot",
    ]);
    console.log(
      unitOutput
        .split("\n")
        .filter((line) => /Test Files|Tests /.test(line))
        .join("\n"),
    );
    await run(cwd, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]);
    const index = await readFile(join(cwd, "dist/index.html"), "utf8");
    expect(index).not.toMatch(/<link[^>]*href=["']\/css\/styles.css/);
    expect(index.split("</head>")[0]).toContain("shop-theme");
    expect(
      await readFile(join(cwd, "src/pages/assets/favicon.svg"), "utf8"),
    ).toBe(FAVICON_SVG);
    expect(await readFile(join(cwd, "dist/assets/favicon.svg"), "utf8")).toBe(
      FAVICON_SVG,
    );
    expect(await readFile(join(cwd, "dist/favicon.ico"))).toEqual(
      Buffer.from(FAVICON_ICO_B64, "base64"),
    );
    expect(await readFile(join(cwd, "dist/assets/favicon-32x32.png"))).toEqual(
      Buffer.from(FAVICON_32_PNG_B64, "base64"),
    );
    expect(
      await fetch(baseURL)
        .then(() => true)
        .catch(() => false),
      "43931 must be free, not an unrelated server",
    ).toBe(false);
    server = spawn(
      process.execPath,
      [cli, "--server", "--port", "43931", "--host", "127.0.0.1"],
      { cwd, stdio: "ignore" },
    );
    await expect
      .poll(
        async () =>
          fetch(baseURL)
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 15000 },
      )
      .toBe(200);
    const response = await fetch(baseURL).then((r) => r.text());
    expect(response.match(/data-testid="book-card"/g)).toHaveLength(8);
    expect(response).toContain("All products");
    expect(response).not.toContain('href="/books/');
    await run(cwd, [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/racing.db");
db.exec("UPDATE products SET price_cents = 24123 WHERE slug = 'pit-lane-coach-jacket'");
db.close();`,
    ]);
    expect(await fetch(baseURL).then((r) => r.text())).toContain("$241.23");
    await run(cwd, ["scripts/seed-database.ts"]);
    for (const width of [1440, 390]) {
      const stable = await browser.newContext({
        viewport: { width, height: 900 },
      });
      await stable.addInitScript(() => {
        localStorage.setItem(
          "cart",
          JSON.stringify([{ id: "pit-lane-coach-jacket", quantity: 2 }]),
        );
      });
      const paint = await stable.newPage();
      let release!: () => void;
      const modules = new Promise<void>((resolve) => {
        release = resolve;
      });
      await paint.route("**/js/*.js", async (route) => {
        await modules;
        await route.continue();
      });
      try {
        await paint.goto(baseURL, { waitUntil: "commit" });
        // Navigation commit precedes HTML parsing, especially on Windows.
        await expect
          .poll(() => paint.getByTestId("book-card").count(), {
            timeout: 15000,
          })
          .toBe(8);
        await expect
          .poll(() => paint.getByTestId("site-header-theme").isVisible())
          .toBe(true);
        await expect
          .poll(() => paint.getByTestId("book-catalog-controls").isVisible())
          .toBe(true);
        const layout = () =>
          paint.evaluate(`(() => {
            return ["site-header-nav", "site-header-theme", "book-catalog-controls", "book-card"]
              .flatMap(id => Array.from(document.querySelectorAll('[data-testid="' + id + '"]')).map(element => ({
                id,
                box: element.getBoundingClientRect().toJSON(),
                text: id === "book-card" ? element.querySelector("h3").textContent : null,
              })));
          })()`);
        const initial = await layout();
        release();
        await paint.waitForLoadState("load");
        await expect
          .poll(() => paint.getByTestId("site-header-cart-count").textContent())
          .toBe("2");
        expect(await layout()).toEqual(initial);
      } finally {
        release();
        await stable.close();
      }
    }
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const stable = await browser.newContext({ viewport });
      const paint = await stable.newPage();
      let modules = Promise.withResolvers<void>();
      try {
        await paint.goto(`${baseURL}/products/pit-lane-coach-jacket`);
        await paint.route("**/js/*.js", async (route) => {
          await modules.promise;
          await route.continue();
        });
        const layout = () =>
          paint.evaluate(`(() => ({
            scroll: scrollY,
            height: document.documentElement.scrollHeight,
            boxes: ["site-header-nav", "site-header-theme", "site-header-cart-count", "book-detail", "product-art", "book-detail-price", "book-detail-add", "book-detail-view-cart"]
              .map(id => document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect().toJSON()),
          }))()`);
        for (const position of ["top", "bottom", "saved-cart"]) {
          if (position === "saved-cart") {
            const badge = paint.getByTestId("site-header-cart-count");
            const before = await badge.evaluate(
              (el) =>
                el.ownerDocument.defaultView!.getComputedStyle(el)
                  .backgroundColor,
            );
            await paint.getByTestId("book-detail-add").click();
            await expect.poll(() => badge.textContent()).toBe("1");
            expect(
              await badge.evaluate(
                (el) =>
                  el.ownerDocument.defaultView!.getComputedStyle(el)
                    .backgroundColor,
              ),
            ).toBe(before);
          }
          await paint.evaluate(
            position === "top"
              ? "scrollTo(0, 0)"
              : "scrollTo(0, document.documentElement.scrollHeight)",
          );
          await paint.reload({ waitUntil: "commit" });
          await paint.getByRole("contentinfo").waitFor({ state: "attached" });
          await paint.evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          const initial = await layout();
          expect(await paint.getByTestId("book-detail-add").isDisabled()).toBe(
            true,
          );
          expect(
            await paint.getByTestId("book-detail-view-cart").isVisible(),
          ).toBe(true);
          if (viewport.width > 640) {
            expect(
              await paint.getByTestId("site-header-cart-count").isVisible(),
            ).toBe(true);
            expect(
              await paint.getByTestId("site-header-cart-count").textContent(),
            ).toBe("0");
          }
          modules.resolve();
          await paint.waitForLoadState("load");
          await expect
            .poll(() => paint.getByTestId("book-detail-add").isEnabled())
            .toBe(true);
          await expect
            .poll(() =>
              paint.getByTestId("site-header-cart-count").textContent(),
            )
            .toBe(position === "saved-cart" ? "1" : "0");
          expect(await layout()).toEqual(initial);
          modules = Promise.withResolvers<void>();
        }
      } finally {
        modules.resolve();
        await stable.close();
      }
    }
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    expect(await page.getByTestId("site-header-logo").innerText()).toBe("shop");
    const toggle = page.getByTestId("site-header-theme");
    expect(await toggle.getAttribute("aria-label")).toBe("Switch to dark mode");
    expect(await toggle.innerText()).toBe("");
    expect((await toggle.textContent())!.trim()).toBe("");
    expect(await toggle.locator("svg").count()).toBeGreaterThan(0);
    expect(await page.locator('link[rel="stylesheet"]').count()).toBe(0);
    expect(
      await page.evaluate(`(() => Array.from(document.body.querySelectorAll("*"))
      .filter(el => { const box = el.getBoundingClientRect(); return box.height > 0 && box.top < innerHeight && box.bottom > 0; })
      .filter(el => getComputedStyle(el).animationName !== "none").map(el => el.tagName))()`),
    ).toEqual([]);
    expect(
      await page
        .getByTestId("site-header-books")
        .evaluate(
          (el) =>
            el.ownerDocument.defaultView!.getComputedStyle(el)
              .textDecorationLine,
        ),
    ).toBe("none");
    expect(
      await page.getByTestId("book-catalog").evaluate((el) => ({
        opacity: el.ownerDocument.defaultView!.getComputedStyle(el).opacity,
        animations: el.getAnimations({ subtree: true }).length,
      })),
    ).toEqual({ opacity: "1", animations: 0 });
    await toggle.focus();
    expect(
      await toggle.evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el).outlineStyle,
      ),
    ).not.toBe("none");
    await page.keyboard.press("Enter");
    expect(await toggle.getAttribute("aria-label")).toBe(
      "Switch to light mode",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(
        "getComputedStyle(document.documentElement).colorScheme",
      ),
    ).toBe("dark");
    await toggle.click();
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(
        "getComputedStyle(document.documentElement).colorScheme",
      ),
    ).toBe("light");
    await page.goto(`${baseURL}/products/pit-lane-coach-jacket`);
    expect(await page.locator('link[rel="stylesheet"]').count()).toBe(0);
    const detail = page.getByTestId("book-detail");
    const box = await detail.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(650);
    expect(box!.width).toBeGreaterThan(950);
    expect(await detail.innerText()).toMatch(
      /Material[\s\S]*Fit[\s\S]*Specification[\s\S]*Availability/,
    );
    expect(await detail.innerText()).toContain("Illustrative product");
    expect(
      await detail.evaluate(
        (el) =>
          el
            .getAnimations({ subtree: true })
            .filter((a: { playState: string }) => a.playState === "running")
            .length,
      ),
    ).toBe(0);
    await page.getByTestId("book-detail-add").click();
    await expect
      .poll(() => page.getByTestId("site-header-cart-count").innerText())
      .toBe("1");
    await page.getByTestId("book-detail-view-cart").click();
    await page
      .getByTestId("cart-list-line")
      .filter({ hasText: "Pit Lane Coach Jacket" })
      .waitFor({ state: "visible" });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (
        (await toggle.getAttribute("aria-label")) !==
        `Switch to ${colorScheme === "light" ? "dark" : "light"} mode`
      )
        await toggle.click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${baseURL}/products/pit-lane-coach-jacket`);
      expect(
        await page.evaluate(
          "getComputedStyle(document.documentElement).colorScheme",
        ),
      ).toBe(colorScheme);
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.getByTestId("site-header-nav-toggle").click();
      expect(
        await page
          .getByTestId("site-header-nav-toggle")
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(await page.getByTestId("site-header-nav-menu").isVisible()).toBe(
        true,
      );
    }
    const noJS = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const fallback = await noJS.newPage();
    await fallback.goto(baseURL);
    expect(await fallback.getByTestId("book-card").count()).toBe(8);
    expect(await fallback.getByTestId("site-header-books").isVisible()).toBe(
      true,
    );
    await fallback.getByLabel("Category").selectOption("Parts");
    await fallback.getByTestId("book-catalog-apply").click();
    expect(await fallback.getByTestId("book-card").count()).toBe(4);
    await fallback.goto(`${baseURL}/products/pit-lane-coach-jacket`);
    expect(await fallback.getByTestId("book-detail").innerText()).toContain(
      "Material",
    );
    expect(await fallback.getByTestId("book-detail-add").isVisible()).toBe(
      true,
    );
    expect(await fallback.getByTestId("book-detail-add").isDisabled()).toBe(
      true,
    );
    expect(
      await fallback.getByTestId("book-detail-view-cart").isVisible(),
    ).toBe(true);
    expect(
      await fallback.getByTestId("site-header-cart-count").textContent(),
    ).toBe("0");
    expect(await fallback.getByTestId("site-header-theme").isVisible()).toBe(
      false,
    );
    await noJS.close();
    // A blocked storage API must not break the theme button or module execution.
    const blocked = await browser.newContext({ colorScheme: "dark" });
    await blocked.addInitScript(
      `Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage blocked"); } });`,
    );
    const blockedPage = await blocked.newPage();
    blockedPage.on("pageerror", (error) => errors.push(error.message));
    await blockedPage.goto(baseURL);
    const blockedToggle = blockedPage.getByTestId("site-header-theme");
    await expect
      .poll(() => blockedToggle.getAttribute("aria-label"))
      .toBe("Switch to light mode");
    await blockedToggle.click();
    expect(
      await blockedPage.evaluate(
        "getComputedStyle(document.documentElement).colorScheme",
      ),
    ).toBe("light");
    await blocked.close();
    expect(requests.some((url) => url.endsWith("/css/styles.css"))).toBe(false);
    expect(errors).toEqual([]);
    // Run the complete generated checkout/cart/filter suite against this same
    // unique-port production server, without editing its shipped default config.
    const config = join(cwd, "feedback.playwright.config.ts");
    await writeFile(
      config,
      `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", testMatch: "app.spec.ts", workers: 1, use: { baseURL: "${baseURL}", headless: true } });`,
    );
    const e2eOutput = await run(cwd, [
      require.resolve("@playwright/test/cli"),
      "test",
      "--config",
      config,
      "--reporter=line",
    ]);
    console.log(
      e2eOutput
        .split("\n")
        .filter((line) => /passed \(/.test(line))
        .join("\n"),
    );
    for (const width of [768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${baseURL}/products/pit-lane-coach-jacket`);
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
    }
    const auditScript = join(
      root,
      "skills/bascik/scripts/audit-components.mjs",
    );
    let auditOutput: string;
    try {
      auditOutput = await run(cwd, [auditScript, "--json", "--root", cwd]);
    } catch (error) {
      auditOutput = (error as Error).message;
    }
    const findings = (
      JSON.parse(auditOutput) as {
        findings: { rule: string; file: string; line: number }[];
      }
    ).findings;
    const semantic = [
      "clickable-element",
      "generic-root",
      "skipped-heading",
      "missing-alt",
      "unlabeled-control",
      "missing-main",
    ];
    expect(findings.filter((f) => semantic.includes(f.rule))).toEqual([]);
    console.log(
      "Component audit findings:",
      findings.map((f) => `${f.rule} ${f.file}:${f.line}`).join(", ") || "none",
    );
    console.log(
      "Production browser: desktop, phone, both themes, keyboard toggle, saved theme, reduced motion, no-JS, cart, no CSS request, no page errors.",
    );
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise<void>((done) => server!.once("exit", () => done()));
    }
    await browser.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 5 });
  }
}, 120000);
