/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, symlink, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import {
  scaffold,
  FAVICON_SVG,
  FAVICON_ICO_B64,
  FAVICON_32_PNG_B64,
  APPLE_TOUCH_ICON_PNG_B64,
} from "../scaffold.ts";
import { PORTFOLIO_TEMPLATE } from "./portfolio.ts";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const url = "http://localhost:19441";
let directory: string;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let serverOutput = "";

const stopTestProcess = async (
  child: ChildProcess,
  graceMs = 1500,
): Promise<void> => {
  // Signal termination leaves exitCode null. Its exit event may already be gone.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
    };
    const exited = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once("exit", exited);
    child.once("error", failed);
    timer = setTimeout(() => {
      timer = setTimeout(
        () =>
          failed(
            new Error("Owned portfolio test server did not exit after SIGKILL"),
          ),
        1500,
      );
      try {
        child.kill("SIGKILL");
      } catch (error) {
        failed(error as Error);
      }
    }, graceMs);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      failed(error as Error);
    }
  });
};

beforeAll(async () => {
  await mkdir(join(root, "my-site"), { recursive: true });
  directory = await mkdtemp(join(root, "my-site", "portfolio-browser-"));
  await scaffold("portfolio", directory, { template: PORTFOLIO_TEMPLATE });
  const project = join(directory, "portfolio");
  await mkdir(join(project, "node_modules", "@bascik"), { recursive: true });
  await symlink(
    join(root, "pkg"),
    join(project, "node_modules", "@bascik", "bascik"),
  );
  await symlink(
    join(root, "node_modules", "vitest"),
    join(project, "node_modules", "vitest"),
  );
  await promisify(execFile)(
    process.execPath,
    [join(root, "pkg/bin/bascik.js"), "--build"],
    {
      cwd: project,
      timeout: 90_000,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
    },
  );
  await promisify(execFile)(
    process.execPath,
    [join(root, "pkg/bin/bascik.js"), "--check"],
    {
      cwd: project,
      timeout: 90_000,
    },
  );
  const generatedTests = await promisify(execFile)(
    process.execPath,
    [join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=dot"],
    {
      cwd: project,
      timeout: 90_000,
    },
  );
  console.info(
    generatedTests.stdout
      .split("\n")
      .filter((line) => /Test Files|Tests\s+\d/.test(line))
      .join("\n"),
  );
  // Fail rather than attach to somebody else's server.
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(19441, () => probe.close(() => resolve()));
  });
  server = spawn(
    process.execPath,
    [join(root, "pkg/bin/bascik.js"), "--server", "--port", "19441"],
    {
      cwd: project,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1000),
        headers: { Connection: "close" },
      });
      await response.arrayBuffer();
      ready = response.ok;
    } catch {
      /* Wait for readiness. */
    }
    if (ready) break;
    if (server.exitCode !== null) throw new Error(serverOutput);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(ready, serverOutput).toBe(true);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  try {
    try {
      await browser?.close();
    } finally {
      if (server) await stopTestProcess(server);
    }
  } finally {
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("portfolio harness process cleanup", () => {
  it("does not wait for an exit event that already occurred after signal termination", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: "SIGTERM",
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    await stopTestProcess(child);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("exit")).toBe(0);
  }, 250);

  it("bounds graceful shutdown, then reaps an unresponsive owned child", async () => {
    const events = new EventEmitter();
    const kill = vi.fn((signal: string) => {
      if (signal === "SIGKILL")
        queueMicrotask(() => events.emit("exit", null, signal));
      return true;
    });
    const child = Object.assign(events, {
      exitCode: null,
      signalCode: null,
      kill,
    }) as unknown as ChildProcess;
    await stopTestProcess(child, 5);
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(child.listenerCount("exit")).toBe(0);
  }, 250);
});

describe("fresh portfolio production browser", () => {
  it("has inline global CSS, the canonical favicon, and a plain portfolio brand", async () => {
    const page = await browser!.newPage();
    const stylesheetRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/styles.css"))
        stylesheetRequests.push(request.url());
    });
    for (const path of [
      "/",
      "/work",
      "/work/field-notes-identity",
      "/about",
      "/contact",
    ]) {
      const response = await page.goto(`${url}${path}`);
      expect(response?.status(), path).toBe(200);
      expect(await page.locator('link[href*="styles.css"]').count(), path).toBe(
        0,
      );
      expect(
        await page.evaluate(() =>
          [...document.body.querySelectorAll("*")].every((element) => {
            const rect = element.getBoundingClientRect();
            if (
              rect.bottom <= 0 ||
              rect.top >= innerHeight ||
              !rect.width ||
              !rect.height
            )
              return true;
            return getComputedStyle(element).animationName === "none";
          }),
        ),
        path,
      ).toBe(true);
    }
    expect(stylesheetRequests).toEqual([]);
    expect(await page.getByTestId("site-header-logo").innerText()).toBe(
      "portfolio",
    );
    expect(
      await page.locator('link[rel="stylesheet"][href*="styles.css"]').count(),
    ).toBe(0);
    expect(
      await readFile(
        join(directory, "portfolio/dist/assets/favicon.svg"),
        "utf8",
      ),
    ).toBe(FAVICON_SVG);
    const fetchedFavicon = await page.evaluate(async () => {
      const response = await fetch("/assets/favicon.svg");
      return { status: response.status, text: await response.text() };
    });
    expect(fetchedFavicon.status).toBe(200);
    expect(fetchedFavicon.text).toBe(FAVICON_SVG);
    expect(fetchedFavicon.text).toContain(
      '<polygon points="10,3 28,3 23,29 4,29" fill="#d3ff8d" />',
    );
    expect(fetchedFavicon.text).toContain('fill="#0e0f10"');
    for (const [path, data] of [
      ["favicon.ico", FAVICON_ICO_B64],
      ["assets/favicon-32x32.png", FAVICON_32_PNG_B64],
      ["assets/apple-touch-icon.png", APPLE_TOUCH_ICON_PNG_B64],
    ])
      expect(await readFile(join(directory, "portfolio/dist", path))).toEqual(
        Buffer.from(data, "base64"),
      );
    await page.close();
  });

  it("supports keyboard theme switching, persistence, and accessible responsive navigation", async () => {
    const page = await browser!.newPage();
    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const theme = page.getByTestId("site-header-theme-toggle");
      expect(await theme.count()).toBe(1);
      expect(
        await theme.evaluate((element) => element.textContent?.trim()),
      ).toBe("");
      expect(await theme.locator("svg").count()).toBeGreaterThan(0);
      expect(await theme.getAttribute("aria-label")).toBe("Dark theme");
      await theme.focus();
      await theme.press("Space");
      expect(await theme.getAttribute("aria-pressed")).toBe("true");
      await page.reload();
      expect(await theme.getAttribute("aria-pressed")).toBe("true");
      expect(
        await page.evaluate(() => document.documentElement.dataset.theme),
      ).toBe("dark");
      expect(
        await page.evaluate(() => localStorage.getItem("portfolio-theme")),
      ).toBe("dark");
      await theme.click();
      expect(await theme.getAttribute("aria-pressed")).toBe("false");
      await page.reload();
      expect(await theme.getAttribute("aria-pressed")).toBe("false");
      expect(
        await page.evaluate(() => document.documentElement.dataset.theme),
      ).toBe("light");
      expect(
        await page.evaluate(() => localStorage.getItem("portfolio-theme")),
      ).toBe("light");
      const menu = page.getByTestId("site-header-nav-menu");
      if (width <= 640) {
        const toggle = page.getByTestId("site-header-nav-toggle");
        await toggle.click();
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        await toggle.press("Escape");
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(
          await toggle.evaluate(
            (element) => element === document.activeElement,
          ),
        ).toBe(true);
        await toggle.click();
      }
      expect(await menu.isVisible()).toBe(true);
      expect(
        await page
          .getByTestId("site-header-work")
          .evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("none");
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBe(0);
    }
    await page.close();
  });

  it("shows static first-paint content and sample labels even without JavaScript", async () => {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const context = await browser!.newContext({
        javaScriptEnabled: false,
        reducedMotion,
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      expect(await page.getByTestId("featured-projects").innerText()).toContain(
        "Sample work",
      );
      expect(
        await page.getByTestId("home-intro").evaluate((element) => {
          return [element, ...element.querySelectorAll("*")].every((node) => {
            const style = getComputedStyle(node);
            return (
              Number(style.opacity) === 1 && style.animationName === "none"
            );
          });
        }),
      ).toBe(true);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.getByTestId("site-header-work").isVisible()).toBe(true);
      await context.close();
    }
  });

  it("preserves project routes and form behavior across themes and widths", async () => {
    const page = await browser!.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`);
    });
    await mkdir(join(root, "my-site", "portfolio-review"), { recursive: true });
    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto(url);
        await page.evaluate(() => localStorage.removeItem("portfolio-theme"));
        await page.reload({ waitUntil: "domcontentloaded" });
        expect(
          await page
            .getByTestId("site-header-theme-toggle")
            .getAttribute("aria-pressed"),
        ).toBe(String(colorScheme === "dark"));
        expect(
          await page.evaluate(
            () => getComputedStyle(document.documentElement).colorScheme,
          ),
        ).toBe("light dark");
        const first = page.getByTestId("project-card-link").first();
        const href = await first.getAttribute("href");
        for (const path of ["/", "/work", href!, "/about", "/contact"]) {
          await page.goto(`${url}${path}`);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
            `${width} ${colorScheme} ${path}`,
          ).toBe(0);
          expect(await page.locator("h1").count()).toBe(1);
          if (path === href)
            expect(
              await page.getByTestId("project-detail").innerText(),
            ).toContain("Sample project");
          if (path === "/" && width !== 320)
            await page.screenshot({
              path: join(
                root,
                "my-site",
                "portfolio-review",
                `${width}-${colorScheme}.png`,
              ),
              fullPage: true,
            });
        }
      }
    }
    await page.getByTestId("contact-form-submit").click();
    expect(await page.getByTestId("contact-form-status").innerText()).toContain(
      "Name:",
    );
    await page.getByTestId("contact-form-name").fill("Sample Visitor");
    await page.getByTestId("contact-form-email").fill("sample@example.com");
    await page
      .getByTestId("contact-form-message")
      .fill("I would like to discuss a visual identity project.");
    await page.getByTestId("contact-form-submit").click();
    expect(await page.getByTestId("contact-form-status").innerText()).toContain(
      "Thanks",
    );
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("runs component, token, and built-link audits on the fresh scaffold", async () => {
    const project = join(directory, "portfolio");
    const skills = join(root, "skills");
    for (const script of [
      "bascik/scripts/verify.mjs",
      "bascik/scripts/audit-components.mjs",
      "bascik/scripts/check-links.mjs",
      "bascik-components/scripts/check-tokens.mjs",
    ]) {
      const result = await promisify(execFile)(
        process.execPath,
        [join(skills, script)],
        {
          cwd: project,
          timeout: 90_000,
        },
      ).then(
        ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
        (error: { stdout?: string; stderr?: string }) => ({
          code: 1,
          output: (error.stdout ?? "") + (error.stderr ?? ""),
        }),
      );
      expect(result.code, `${script}\n${result.output}`).toBe(0);
    }
  }, 120_000);
});
