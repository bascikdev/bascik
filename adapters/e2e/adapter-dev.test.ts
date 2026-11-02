import { test, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { availableDevPort } from "../../pkg/dist/lib/adapter-dev-platform.js";
import { stopAdapterChild } from "../../pkg/dist/lib/adapter-dev.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

for (const target of ["cloudflare", "cloudflare-pages", "netlify"]) {
  test(`${target} dev rebuilds source and reloads the browser inside the real platform runtime`, async ({
    page,
    request,
  }) => {
    const root = await mkdtemp(join(tmpdir(), `bascik-${target}-dev-`));
    let child: ChildProcess | undefined;
    let log = "";
    try {
      await mkdir(join(root, "src/pages"), { recursive: true });
      await mkdir(join(root, "src/api"), { recursive: true });
      await mkdir(join(root, "src/components/demo-card"), { recursive: true });
      await mkdir(join(root, "netlify/functions"), { recursive: true });
      await symlink(
        join(repo, "node_modules"),
        join(root, "node_modules"),
        "dir",
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "adapter-dev-browser",
          private: true,
          type: "module",
        }),
      );
      await writeFile(
        join(root, "bascik.config.ts"),
        `export default {
        generate: { sitemap: false, robots: false },
        contentSecurityPolicy: { directives: { "default-src": ["'self'"], "script-src": ["'self'"], "connect-src": ["'self'"] } }
      };`,
      );
      await writeFile(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
          name: "adapter-dev-browser",
          compatibility_date: "2026-08-01",
          ...(target === "cloudflare" && {
            kv_namespaces: [
              {
                binding: "STATE",
                id: "0123456789abcdef0123456789abcdef",
              },
            ],
          }),
        }),
      );
      await writeFile(
        join(root, "netlify.toml"),
        '[build]\npublish = "publish"\n[functions]\ndirectory = "netlify/functions"\n',
      );
      await writeFile(join(root, "src/value.ts"), 'export default "first";');
      await writeFile(
        join(root, "src/components/demo-card/demo-card.html"),
        '<p data-testid="component">Component first</p>',
      );
      await writeFile(
        join(root, "src/components/demo-card/demo-card.css"),
        "p { color: rgb(11, 22, 33); }",
      );
      await writeFile(
        join(root, "src/pages/index.html"),
        `<!doctype html><html><head><title>Adapter dev</title></head><body>
        <h1 data-testid="value"><script data-bascik-server type="text/typescript">
          import value from "../value.ts"; export default () => value;
        </script></h1>
        <p data-testid="platform"><script data-bascik-server>
          export default (_request, context) => context.platform.name;
        </script></p>
        </body></html>`,
      );
      await writeFile(
        join(root, "src/pages/static.html"),
        '<!doctype html><html><head><title>Static</title></head><body><h1 data-testid="static">Static first</h1><demo-card /></body></html>',
      );
      await writeFile(
        join(root, "src/pages/stream.html"),
        `<!doctype html><html><head><title>Stream</title></head><body><h1>Early shell</h1><div><script data-bascik-stream>
        export default async () => { await new Promise(resolve => setTimeout(resolve, 2500)); return "Late result"; };
        </script></div></body></html>`,
      );
      await writeFile(
        join(root, "src/api/ping.ts"),
        'export const GET = () => Response.json({ value: "first" });',
      );
      if (target === "cloudflare") {
        await writeFile(
          join(root, "src/api/state.ts"),
          `export const GET = async (_request, context) => {
  const state = context.platform.env.STATE;
  const reads = Number(await state.get("reads") ?? "0") + 1;
  await state.put("reads", String(reads));
  return Response.json({ reads });
};`,
        );
      }
      const port = await availableDevPort();
      const url = `http://127.0.0.1:${port}`;
      child = spawn(
        process.execPath,
        [
          join(repo, "pkg/dist/index.js"),
          "--target",
          target,
          "--port",
          String(port),
        ],
        {
          cwd: root,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            NETLIFY_TELEMETRY_DISABLED: "1",
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
      child.stdout!.on("data", (chunk) => {
        log += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        log += chunk;
      });
      await expect
        .poll(
          async () => {
            try {
              const response = await request.get(url);
              return response.status();
            } catch {
              return 0;
            }
          },
          { timeout: 90_000, message: "Platform startup" },
        )
        .toBe(200);
      await page.goto(url);
      await expect(page.getByTestId("value")).toHaveText("first");
      await expect(page.getByTestId("platform")).toHaveText(
        target.startsWith("cloudflare") ? "cloudflare" : target,
      );
      await expect(page.locator("script[data-bascik-live-reload]")).toHaveCount(
        1,
      );
      if (target === "cloudflare") {
        const state = await request.get(`${url}/api/state`);
        expect(state.status()).toBe(200);
        expect(await state.json()).toEqual({ reads: 1 });
      }
      const stream = await fetch(`${url}/stream`, {
        signal: AbortSignal.timeout(2000),
      });
      const reader = stream.body!.getReader();
      let shell = "";
      try {
        while (!shell.includes("Early shell")) {
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          shell += new TextDecoder().decode(chunk.value);
        }
        expect(shell).toContain("__bascik_adapter_dev");
        expect(shell).not.toContain("Late result");
      } finally {
        await reader.cancel();
      }
      if (target.startsWith("cloudflare")) {
        const build = spawn(
          process.execPath,
          [join(repo, "pkg/dist/index.js"), "--build", "--target", target],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        build.stdout.on("data", (chunk) => {
          log += chunk;
        });
        build.stderr.on("data", (chunk) => {
          log += chunk;
        });
        const [code] = await once(build, "exit");
        expect(code, log).toBe(0);
      }
      await writeFile(join(root, "src/value.ts"), 'export default "second";');
      await expect(page.getByTestId("value")).toHaveText("second", {
        timeout: 60_000,
      });
      if (target === "cloudflare") {
        const state = await request.get(`${url}/api/state`);
        expect(state.status()).toBe(200);
        expect(await state.json()).toEqual({ reads: 2 });
      }
      await page.goto(`${url}/static`);
      await expect(page.getByTestId("static")).toHaveText("Static first");
      await expect(page.getByTestId("component")).toHaveText("Component first");
      await expect(page.getByTestId("component")).toHaveCSS(
        "color",
        "rgb(11, 22, 33)",
      );
      await writeFile(
        join(root, "src/components/demo-card/demo-card.html"),
        '<p data-testid="component">Component second</p>',
      );
      await expect(page.getByTestId("component")).toHaveText(
        "Component second",
        { timeout: 60_000 },
      );
      await writeFile(
        join(root, "src/components/demo-card/demo-card.css"),
        "p { color: rgb(44, 55, 66); }",
      );
      await expect(page.getByTestId("component")).toHaveCSS(
        "color",
        "rgb(44, 55, 66)",
        { timeout: 60_000 },
      );
      await writeFile(
        join(root, "src/pages/static.html"),
        '<!doctype html><html><head><title>Static</title></head><body><h1 data-testid="static">Static second</h1></body></html>',
      );
      await expect(page.getByTestId("static")).toHaveText("Static second", {
        timeout: 60_000,
      });
      await writeFile(
        join(root, "src/api/ping.ts"),
        'export const GET = () => Response.json({ value: "second" });',
      );
      await expect
        .poll(
          async () => {
            const response = await request.get(`${url}/api/ping`);
            return response.status() === 200
              ? (await response.json()).value
              : "";
          },
          { timeout: 60_000 },
        )
        .toBe("second");
      await writeFile(
        join(root, "src/pages/static.html"),
        '<!doctype html><html><head><title>Static</title></head><body><script data-bascik-build>throw new Error("recoverable dev error");</script></body></html>',
      );
      await expect(page.getByRole("alertdialog")).toContainText(
        "Build failed",
        { timeout: 60_000 },
      );
      await writeFile(
        join(root, "src/pages/static.html"),
        '<!doctype html><html><head><title>Static</title></head><body><h1 data-testid="static">Recovered</h1></body></html>',
      );
      await expect(page.getByTestId("static")).toHaveText("Recovered", {
        timeout: 60_000,
      });
      expect(
        await readFile(join(root, "dist/static.html"), "utf8"),
      ).not.toContain("__bascik_adapter_dev");
      expect(log).not.toContain("getcwd(): No such file or directory");
      if (target === "netlify")
        expect(log).not.toContain("Static server listening to 3999");
      await stopAdapterChild(child);
      child = undefined;
      const ports = new Set([
        String(port),
        ...[...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/g)].map(
          (match) => match[1],
        ),
      ]);
      for (const stoppedPort of ports) {
        await expect
          .poll(async () => {
            try {
              await request.get(`http://127.0.0.1:${stoppedPort}`);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nAdapter dev output:\n${log}`,
        { cause: error },
      );
    } finally {
      await stopAdapterChild(child);
      await rm(root, { recursive: true, force: true });
    }
  });
}
