// End-to-end tests for the adapter's build(): a graph in, a bundled Netlify
// Function out, imported and invoked like Netlify would.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterBuildContext } from "@bascik/bascik/adapter";
import adapter from "./index.js";
import { FUNCTION_DIR, FUNCTION_FILE, PUBLISH_DIR } from "./paths.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bascik-netlify-adapter-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function context(
  pages: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const distDir = join(root, "dist");
  const outDir = join(distDir, ".bascik", "netlify");
  await mkdir(join(distDir, ".bascik"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<h1>Home</h1>");
  await writeFile(join(distDir, ".bascik", "server-scripts.json"), "{}");
  const logs: string[] = [];
  const ctx = {
    graph: {
      apiRoutes: [],
      publicFiles: ["index.html", ".bascik/server-scripts.json"],
      base: "/",
      scriptTimeoutMs: 1000,
      onServerScriptError: "error",
      pages,
      ...extra,
    },
    distDir,
    outDir,
    projectRoot: root,
    log: (message: string) => logs.push(message),
    runtimeEntry: "",
  } as unknown as AdapterBuildContext;
  return { ctx, outDir, logs };
}

describe("adapter", () => {
  it("is the netlify hosting adapter", () => {
    expect(adapter.name).toBe("netlify");
    expect(typeof adapter.build).toBe("function");
  });

  it("builds a function that renders server scripts for every page alias", async () => {
    const script = join(root, "hello.mjs");
    await writeFile(
      script,
      "export default (request) => `<p>${new URL(request.url).pathname}</p>`;",
    );
    const { ctx, outDir, logs } = await context({
      "/hello": {
        is404: false,
        segments: [
          { kind: "static", text: "<h1>" },
          { kind: "script", id: "a" },
          { kind: "static", text: "</h1>" },
        ],
        jobs: {
          a: { mode: "server", source: { kind: "module", path: script } },
        },
      },
    });

    const result = await adapter.build(ctx);

    expect(result.publicDir).toBe(join(outDir, PUBLISH_DIR));
    expect(existsSync(join(result.publicDir, "index.html"))).toBe(true);
    expect(existsSync(join(result.publicDir, ".bascik"))).toBe(false);
    expect(result.workerPath).toBe(join(outDir, FUNCTION_DIR, FUNCTION_FILE));
    expect(result.components).toBe(true);
    expect(logs.join("\n")).toContain("/hello.html");

    const fn = await import(pathToFileURL(result.workerPath!).href);
    expect(fn.config.path).toEqual(
      expect.arrayContaining(["/hello", "/hello.html"]),
    );
    const response: Response = await fn.default(
      new Request("https://example.com/hello"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-bascik-handler")).toBe("bascik-pages");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("<h1><p>/hello</p></h1>");
  });

  it("writes only static files when no page is dynamic", async () => {
    const { ctx } = await context({});
    const result = await adapter.build(ctx);
    expect(result.workerPath).toBeUndefined();
    expect(result.notes).toEqual([
      "no dynamic pages or API routes: no function written",
    ]);
    expect(existsSync(join(result.publicDir, "index.html"))).toBe(true);
  });

  it("writes security headers for static files, and keeps an authored _headers", async () => {
    const { ctx, logs } = await context({});
    const result = await adapter.build(ctx);
    const generated = await readFile(
      join(result.publicDir, "_headers"),
      "utf8",
    );
    expect(generated).toContain("/*\n  X-Content-Type-Options: nosniff");

    const authored = await context({});
    await writeFile(
      join(authored.ctx.distDir, "_headers"),
      "/*\n  X-Mine: yes\n",
    );
    (authored.ctx.graph.publicFiles as string[]).push("_headers");
    const kept = await adapter.build(authored.ctx);
    expect(await readFile(join(kept.publicDir, "_headers"), "utf8")).toBe(
      "/*\n  X-Mine: yes\n",
    );
    expect(authored.logs.join("\n")).toContain("has its own _headers file");
    expect(logs.join("\n")).not.toContain("_headers");
  });
});
