import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  chromium,
  expect as browserExpect,
  type Browser,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FAVICON_SVG, scaffold } from "../scaffold.ts";
import { DASHBOARD_TEMPLATE } from "./dashboard.ts";

// Every browser test here opens a page on a production server. The default 5s
// is too short on a loaded Windows runner; tests that need longer say so.
vi.setConfig({ testTimeout: 30_000 });

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const exec = promisify(execFile);
const files = new Map(DASHBOARD_TEMPLATE.files({ siteName: "dashboard" }));
const source = (path: string): string => String(files.get(path) ?? "");
const canonicalIcon = readFileSync(
  join(root, "docs/src/pages/assets/favicon.svg"),
  "utf8",
);

describe("dashboard feedback source regressions", () => {
  it("keeps the canonical Bascik favicon unmodified", () => {
    expect(FAVICON_SVG).toBe(canonicalIcon);
  });
  it("inlines global CSS with the existing compiler option", () => {
    expect(source("bascik.config.ts")).toContain(
      'assets: { inlineStyles: ["src/pages/css/styles.css"] }',
    );
  });
  it("uses accessible icons instead of visible theme text or a check mark", () => {
    const toggle = source("src/components/theme-toggle/theme-toggle.html");
    expect(toggle).toContain('aria-label="Dark theme"');
    expect(toggle).toContain('data-testid="theme-toggle-sun"');
    expect(toggle).toContain('data-testid="theme-toggle-moon"');
    expect(toggle).not.toContain('content: "✓ ');
  });
  it("does not animate the initial main content but retains pressed feedback", () => {
    const styles = source("src/pages/css/styles.css");
    expect(styles).not.toContain("content-enter");
    expect(styles).toContain("scale(0.97)");
    expect(styles).toContain("prefers-reduced-motion: reduce");
  });
  it("keeps resting navigation deliberately non-underlined", () => {
    for (const component of ["app-header", "app-sidebar"])
      expect(source(`src/components/${component}/${component}.html`)).toContain(
        "text-decoration: none",
      );
  });
  it("does not invent customers or ownership for real people", () => {
    const data = source("data/racing.sql") + source("src/lib/racing-db.ts");
    expect(data).not.toMatch(
      /Hurley Haywood|Jacky Ickx|Vern Schuppan|Jordan Taylor|Paul Newman|Ross Bentley|Stirling Moss|Jo Siffert|Brian Redman|Rolf Stommelen|Hans Herrmann|Jean Behra/,
    );
    expect(data).toContain("Demo customer 01");
    expect(data).toContain("Demo inventory");
  });
  it("uses a plain dashboard name in settings, not a claimed company identity", () => {
    expect(
      source("src/components/settings-form/settings-form.ts"),
    ).not.toContain("Porsche Motorsport");
    expect(source("src/lib/settings.ts")).not.toContain("Porsche Motorsport");
  });
});

describe("fresh dashboard production browser regressions on 43932", () => {
  let parent: string;
  let project: string;
  let server: ChildProcess;
  let browser: Browser;
  const url = "http://127.0.0.1:43932";

  beforeAll(async () => {
    parent = await mkdtemp(join(root, ".dashboard-feedback-"));
    await scaffold("dashboard", parent, { template: DASHBOARD_TEMPLATE });
    project = join(parent, "dashboard");
    await mkdir(join(project, "node_modules/@bascik"), { recursive: true });
    await symlink(
      join(root, "pkg"),
      join(project, "node_modules/@bascik/bascik"),
    );
    await exec(process.execPath, ["scripts/seed-database.ts"], {
      cwd: project,
    });
    const build = await exec(
      process.execPath,
      [join(root, "pkg/bin/bascik.js"), "--build"],
      {
        cwd: project,
        env: { ...process.env, BASCIK_SITE_URL: url },
        timeout: 90_000,
      },
    );
    console.info(
      build.stdout.match(/.*(?:Build complete|Transpile).*/g)?.join("\n"),
    );
    const check = await exec(
      process.execPath,
      [join(root, "pkg/bin/bascik.js"), "--check"],
      {
        cwd: project,
        timeout: 90_000,
        env: { ...process.env, BASCIK_SITE_URL: url },
      },
    );
    console.info(check.stdout.trim());
    const audit = await exec(
      process.execPath,
      [join(root, ".agents/skills/bascik/scripts/audit-components.mjs")],
      { cwd: project, timeout: 90_000 },
    ).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    });
    console.info(`Component audit:\n${audit.stdout}${audit.stderr}`);
    server = spawn(
      process.execPath,
      [
        join(root, "pkg/bin/bascik.js"),
        "--server",
        "--host",
        "127.0.0.1",
        "--port",
        "43932",
      ],
      { cwd: project, stdio: "pipe" },
    );
    let output = "";
    server.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    server.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(url)).ok) break;
      } catch {}
      if (attempt === 99) throw new Error(`Server not ready: ${output}`);
      await new Promise((done) => setTimeout(done, 100));
    }
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (server && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    if (parent) await rm(parent, { recursive: true, force: true });
  });

  it("ships inline CSS and the canonical icon in compiled output", async () => {
    const html = await readFile(join(project, "dist/index.html"), "utf8");
    expect(html).not.toMatch(/<link[^>]+href="\/css\/styles\.css"/);
    expect(html).toContain("<style");
    expect(
      await readFile(join(project, "dist/assets/favicon.svg"), "utf8"),
    ).toBe(canonicalIcon);
  });

  it("shows an icon-only keyboard toggle with persistent theme and plain slug branding", async () => {
    const page = await browser.newPage({ colorScheme: "light" });
    try {
      await page.goto(url);
      const toggle = page.getByTestId("theme-toggle");
      await browserExpect(toggle).toHaveAccessibleName("Dark theme");
      expect((await toggle.innerText()).trim()).toBe("");
      expect((await toggle.textContent())!.trim()).toBe("");
      await browserExpect(toggle).toHaveAttribute("aria-pressed", "false");
      await browserExpect(page.getByTestId("app-header-brand")).toHaveText(
        "dashboard",
      );
      await toggle.focus();
      await page.keyboard.press("Space");
      await browserExpect(toggle).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await browserExpect(toggle).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.getByTestId("theme-toggle-sun")).toBeVisible();
      await toggle.click();
      await browserExpect(page.getByTestId("theme-toggle-moon")).toBeVisible();
      await page.reload();
      await browserExpect(toggle).toHaveAttribute("aria-pressed", "false");
      await browserExpect(page.locator("html")).toHaveAttribute(
        "data-theme",
        "light",
      );
    } finally {
      await page.close();
    }
  });

  it("paints above-fold content immediately on every route in both themes and at phone/tablet/desktop widths", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({
          colorScheme,
          reducedMotion: "no-preference",
        });
        for (const width of [375, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          for (const [route, testId] of [
            ["/", "overview-main"],
            ["/orders", "orders-main"],
            ["/titles", "titles-main"],
            ["/settings", "settings-main"],
          ] as const) {
            await page.goto(url + route, { waitUntil: "domcontentloaded" });
            expect(await page.locator('link[rel="stylesheet"]').count()).toBe(
              0,
            );
            expect(
              await page.evaluate(`(() => Array.from(document.body.querySelectorAll("*"))
              .filter(element => { const box = element.getBoundingClientRect(); return box.height > 0 && box.top < innerHeight && box.bottom > 0; })
              .filter(element => getComputedStyle(element).animationName !== "none")
              .map(element => element.tagName))()`),
            ).toEqual([]);
            const main = page.getByTestId(testId);
            await browserExpect(main).toHaveCSS("animation-name", "none");
            await browserExpect(main).toHaveCSS("opacity", "1");
            expect(
              await main.evaluate(
                (element) =>
                  element.ownerDocument.documentElement.scrollWidth <=
                  element.ownerDocument.defaultView!.innerWidth,
              ),
            ).toBe(true);
            await browserExpect(page.getByTestId("app-header-brand")).toHaveCSS(
              "text-decoration-line",
              "none",
            );
            for (const link of await page
              .getByTestId("app-sidebar")
              .getByRole("link")
              .all())
              await browserExpect(link).toHaveCSS(
                "text-decoration-line",
                "none",
              );
          }
        }
      }
      expect(errors).toEqual([]);
      expect(
        requests.filter((url) => /\/styles\.css(?:\?|$)/.test(url)),
      ).toEqual([]);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await browserExpect(page.getByTestId("theme-toggle")).toHaveCSS(
        "transition-duration",
        "0s",
      );
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps the core dashboard and navigation usable without JavaScript", async () => {
    const page = await browser.newPage({ javaScriptEnabled: false });
    try {
      await page.goto(url);
      await browserExpect(page.getByTestId("overview-main")).toBeVisible();
      await browserExpect(page.getByTestId("theme-toggle")).toBeHidden();
      await page
        .getByTestId("app-sidebar")
        .getByRole("link", { name: "Orders" })
        .click();
      await browserExpect(page.getByTestId("orders-table")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it("passes the generated production E2E suite against this fresh scaffold", async () => {
    await writeFile(
      join(project, "feedback.tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ESNext",
          module: "NodeNext",
          moduleDetection: "force",
          allowImportingTsExtensions: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          types: ["node"],
        },
        include: ["src/**/*.ts", "e2e/**/*.ts", "bascik.config.ts"],
      }),
    );
    for (const args of [
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        "feedback.tsconfig.json",
      ],
      [join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=dot"],
    ]) {
      const result = await exec(process.execPath, args, {
        cwd: project,
        timeout: 60_000,
      });
      console.info(
        result.stdout
          .split("\n")
          .filter((line) => /Tests |Test Files|failed/.test(line))
          .join("\n"),
      );
    }
    const config = join(project, "feedback.playwright.config.ts");
    await writeFile(
      config,
      `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "${url}", headless: true },
  workers: 1,
});
`,
    );
    const result = await exec(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        config,
        "--reporter=dot",
      ],
      { cwd: project, timeout: 120_000, maxBuffer: 1024 * 1024 },
    ).catch((error: unknown) => {
      const failure = error as {
        stdout?: string;
        stderr?: string;
        message: string;
      };
      throw new Error(
        `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
      );
    });
    console.info(result.stdout.trim());
  }, 130_000);
});
