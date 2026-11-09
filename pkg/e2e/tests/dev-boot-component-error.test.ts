/**
 * Audit 159 findings 43 and 48: a component with a TypeScript syntax error
 * when `bascik` (dev) starts used to end the process with exit code 1, so a
 * user who saved a half-written component and ran `npm run dev` had no server
 * and no overlay. The dev server now starts anyway, shows the located error
 * in the browser overlay, and loads the page once the component is fixed.
 *
 * The project is a temporary folder of its own, so this spec edits no source
 * of the shared e2e fixture.
 */
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";

const pkgDir = fileURLToPath(new URL("../..", import.meta.url));
const entryPath = join(pkgDir, "bin/bascik.js");
const port = "44031";
const base = `http://localhost:${port}`;

const PAGE = `<!doctype html><html lang="en"><head><title>Counter</title></head><body>
<my-counter></my-counter>
</body></html>`;
const BROKEN = `<div data-testid="my-counter"><button>+</button><output>0</output></div>
<script type="text/typescript">
let count: number = 0;
document.querySelector("button")!.addEventListener("click", () => { count++;
</script>
`;
const FIXED = `<div data-testid="my-counter"><button>+</button><output data-testid="count">0</output></div>
<script type="text/typescript">
let count: number = 0;
document.querySelector("button")!.addEventListener("click", () => { count++; });
</script>
`;

test.describe("dev boot with a component that does not compile", () => {
  test("starts the server, shows the error overlay, and loads the page after the fix", async ({
    page,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-dev-boot-error-"));
    const componentPath = join(
      root,
      "src/components/my-counter/my-counter.html",
    );
    await mkdir(join(root, "src/pages"), { recursive: true });
    await mkdir(join(root, "src/components/my-counter"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}', "utf8");
    await writeFile(join(root, "src/pages/index.html"), PAGE, "utf8");
    await writeFile(componentPath, BROKEN, "utf8");

    const child = spawn(process.execPath, [entryPath, "--no-pin"], {
      cwd: root,
      env: { ...process.env, BASCIK_SERVER_PORT: port },
    });
    let output = "";
    let exitCode: number | null = null;
    const capture = (data: Buffer): void => {
      output += stripVTControlCharacters(data.toString("utf8"));
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("exit", (code) => {
      exitCode = code;
    });

    try {
      await expect
        .poll(() => exitCode !== null || output.includes("Server running at"), {
          timeout: 20_000,
        })
        .toBe(true);
      expect(exitCode, `dev server exited. Output:\n${output}`).toBeNull();

      // The terminal shows the located message once, without Bascik's frames.
      expect(output).toContain("[bascik] TypeScript transformation failed");
      expect(output).toContain("my-counter.html");
      expect(output).not.toMatch(/at locatedError|at listComponents|\[cause\]/);

      await page.goto(base);
      const overlay = page.getByTestId("bascik-build-error-overlay");
      await expect(overlay).toBeVisible({ timeout: 15_000 });
      await expect(overlay).toContainText("my-counter.html");

      await writeFile(componentPath, FIXED, "utf8");
      await expect(page.getByTestId("count")).toBeVisible({ timeout: 20_000 });
      await expect(overlay).toHaveCount(0);
      expect(exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) {
        await new Promise<void>((done) => {
          child.once("exit", () => done());
          child.kill("SIGINT");
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
