import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  chromium,
  expect as browserExpect,
  type Browser,
} from "@playwright/test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { scaffold, FAVICON_SVG } from "../scaffold.js";
import { REPORTS_TEMPLATE } from "./reports.js";

// Every browser test here opens a page on a production server. The default 5s
// is too short on a loaded Windows runner; tests that need longer say so.
vi.setConfig({ testTimeout: 30_000 });

const repo = resolve(import.meta.dirname, "../../..");
const url = "http://127.0.0.1:43933";
let parent: string;
let server: ChildProcess;
let browser: Browser;

it("uses the canonical docs favicon without recoloring or animation", async () => {
  expect(FAVICON_SVG).toBe(
    await readFile(join(repo, "docs/src/pages/assets/favicon.svg"), "utf8"),
  );
});

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "bascik-reports-feedback-"));
  await scaffold("reports", parent, { template: REPORTS_TEMPLATE });
  const root = join(parent, "reports");
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  execFileSync(process.execPath, ["scripts/seed-database.ts"], { cwd: root });
  execFileSync(process.execPath, [join(repo, "pkg/bin/bascik.js"), "--build"], {
    cwd: root,
    env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
  });
  server = spawn(
    process.execPath,
    [
      join(repo, "pkg/bin/bascik.js"),
      "--server",
      "--port",
      "43933",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  let output = "";
  server.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* Server is still starting. */
    }
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((done) => setTimeout(done, 100));
  }
  expect((await fetch(url)).status, output).toBe(200);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((done) => server.once("exit", () => done()));
  }
  if (parent) await rm(parent, { recursive: true, force: true });
});

it("ships inline CSS on every production route", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const path of ["/", "/compare", "/reports/2026-08", "/missing"]) {
    await page.goto(url + path, { waitUntil: "domcontentloaded" });
    expect(await page.locator('link[rel="stylesheet"]').count(), path).toBe(0);
  }
  expect(
    requests.filter((request) => /\/styles\.css(?:\?|$)/.test(request)),
  ).toEqual([]);
  await page.close();
});

it("has no computed above-fold animations on fresh production loads", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  for (const path of ["/", "/compare", "/reports/2026-08", "/missing"]) {
    await page.goto(url + path, { waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(`(() =>
      Array.from(document.body.querySelectorAll("*")).filter((element) => {
        const box = element.getBoundingClientRect();
        return box.height > 0 && box.top < innerHeight && box.bottom > 0;
      }).filter((element) => getComputedStyle(element).animationName !== "none")
        .map((element) => element.outerHTML.slice(0, 150)))()
    `),
    ).toEqual([]);
  }
  await page.close();
});

it("has an icon-only accessible toggle and persists both themes after reload", async () => {
  const page = await browser.newPage();
  await page.goto(url);
  const toggle = page.getByTestId("site-header-theme");
  await browserExpect(toggle).toBeVisible();
  expect((await toggle.textContent())?.trim()).toBe("");
  expect(await toggle.locator("svg").count()).toBeGreaterThan(0);
  await browserExpect(toggle).toHaveAttribute(
    "aria-label",
    /Switch to (light|dark) theme/,
  );
  for (const theme of ["dark", "light"]) {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme)
      await toggle.click();
    await page.reload();
    await browserExpect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme,
    );
    expect(
      await page.evaluate(
        "getComputedStyle(document.documentElement).colorScheme",
      ),
    ).toBe(theme);
  }
  expect(await page.getByTestId("site-header-brand").textContent()).toBe(
    "reports",
  );
  expect(
    await page
      .getByTestId("site-header-brand")
      .evaluate(
        (element) =>
          element.ownerDocument.defaultView!.getComputedStyle(
            element,
            "::before",
          ).content,
      ),
  ).toBe("none");
  expect(
    await page
      .getByTestId("site-header-compare")
      .evaluate(
        (element) =>
          element.ownerDocument.defaultView!.getComputedStyle(element)
            .textDecorationLine,
      ),
  ).toBe("none");
  const favicon = await page.request.get(url + "/assets/favicon.svg");
  expect(await favicon.text()).toBe(FAVICON_SVG);
  await page.close();
});

it("navigates the whole linked row without pinning, and pins only chart-month controls", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(url + "/compare");
  const chart = page.getByTestId("chart-explorer");
  // Accessible labels identify the month without depending on minified identifiers.
  const september = chart.getByRole("button", { name: /^Sep 2026:/ });
  const row = chart.getByRole("row", { name: /^September 2026/ });
  expect(await row.getByRole("button").count()).toBe(0);
  await september.click();
  await browserExpect(september).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await browserExpect(september).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await browserExpect(september).toHaveAttribute("aria-pressed", "false");
  await september.focus();
  await page.keyboard.press("Enter");
  await browserExpect(september).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await row.hover();
  await browserExpect(row).toHaveAttribute("data-active", "true");
  const box = (await row.boundingBox())!;
  await row.click({ position: { x: box.width - 12, y: box.height / 2 } });
  await browserExpect(page).toHaveURL(url + "/reports/2026-09");
  await page.close();
});

it("passes the fresh scaffold's typecheck, unit tests, checks and complete production browser suite", async () => {
  const root = join(parent, "reports");
  // The starter intentionally ships no tsconfig. This test-only project checks
  // its erasable TypeScript against both the Node and browser APIs it uses.
  await writeFile(
    join(root, "feedback.tsconfig.json"),
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
      include: [
        "src/**/*.ts",
        "scripts/**/*.ts",
        "e2e/**/*.ts",
        "bascik.config.ts",
      ],
    }),
  );
  for (const args of [
    [
      join(repo, "node_modules/typescript/bin/tsc"),
      "-p",
      "feedback.tsconfig.json",
    ],
    [join(repo, "node_modules/vitest/vitest.mjs"), "run", "--reporter=dot"],
    [join(repo, "pkg/bin/bascik.js"), "--check"],
    [join(repo, ".agents/skills/bascik/scripts/audit-components.mjs")],
  ]) {
    let output: string;
    try {
      output = execFileSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
      );
    }
    console.log(
      output
        .split("\n")
        .filter((line) => /Tests |Test Files|error|warning|check/i.test(line))
        .join("\n"),
    );
  }
  await writeFile(
    join(root, "feedback.playwright.config.ts"),
    `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", workers: 1, use: { baseURL: "${url}", headless: true } });`,
  );
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [
        join(repo, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        "feedback.playwright.config.ts",
        "--reporter=line",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 90_000,
      },
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    );
  }
  console.log(
    output
      .split("\n")
      .filter((line) => /passed|failed/.test(line))
      .join("\n"),
  );
}, 120_000);
