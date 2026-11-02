// Build-time tests for the Netlify adapter: function path aliases, the
// generated entry module and the file:// esbuild plugin.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  apiRoutePattern,
  entrySource,
  fileUrlPlugin,
  functionPaths,
} from "./build.js";

describe("functionPaths", () => {
  it("answers the clean URL, the .html URL and the trailing slash", () => {
    const paths = functionPaths({
      pages: { "/dashboard": {} } as never,
      base: "/",
    });
    assert.ok(paths.includes("/dashboard"));
    assert.ok(paths.includes("/dashboard.html"));
    assert.deepEqual(paths, [...paths].sort());
  });

  it("returns nothing without dynamic pages", () => {
    assert.deepEqual(functionPaths({ pages: {} as never, base: "/" }), []);
  });

  it("adds API routes after the pages, as URLPattern paths", () => {
    const paths = functionPaths({
      pages: { "/dashboard": {} } as never,
      base: "/",
      apiRoutes: [
        { path: "/api/hello" },
        { path: "/api/items/[id]" },
        { path: "/api/files/[...path]" },
      ] as never,
    });
    assert.deepEqual(paths.slice(-3), [
      "/api/hello",
      "/api/items/:id",
      "/api/files/*",
    ]);
  });
});

describe("apiRoutePattern", () => {
  it("maps params and catch-alls, and escapes URLPattern syntax", () => {
    assert.equal(
      apiRoutePattern("/api/users/[id]/posts"),
      "/api/users/:id/posts",
    );
    assert.equal(apiRoutePattern("/docs/api/[...rest]"), "/docs/api/*");
    assert.equal(apiRoutePattern("/api/v1:beta/(x)"), "/api/v1\\:beta/\\(x\\)");
    assert.equal(apiRoutePattern("/api/[user-id]"), "/api/:user_id");
  });

  it("matches the request paths Netlify must route", () => {
    const match = (pattern: string, pathname: string) =>
      new URLPattern({ pathname: pattern }).test({ pathname });
    assert.ok(match(apiRoutePattern("/api/items/[id]"), "/api/items/42"));
    assert.ok(!match(apiRoutePattern("/api/items/[id]"), "/api/items/42/x"));
    assert.ok(match(apiRoutePattern("/api/files/[...path]"), "/api/files/a/b"));
    assert.ok(match(apiRoutePattern("/api/v1:beta"), "/api/v1:beta"));
  });
});

describe("entrySource", () => {
  it("generates lazy loaders and the function config", () => {
    const source = entrySource(
      {
        scriptTimeoutMs: 5000,
        onServerScriptError: "warn",
        pages: {
          "/dashboard": {
            is404: false,
            segments: [{ kind: "script", id: "a" }],
            jobs: {
              a: {
                mode: "stream",
                outputScope: "x",
                source: { kind: "staged", stagedPath: "/tmp/a.mjs" },
              },
            },
          },
        },
      } as never,
      ["/dashboard", "/dashboard.html"],
    );
    assert.ok(source.includes('load: () => import("/tmp/a.mjs")'));
    assert.ok(source.includes('outputScope: "x"'));
    assert.ok(source.includes("scriptTimeoutMs: 5000"));
    assert.ok(source.includes('event: "module.loaded"'));
    assert.ok(
      source.includes(
        'export const config = { path: ["/dashboard","/dashboard.html"], preferStatic: false };',
      ),
    );
    assert.ok(!source.includes("custom500"));
  });
});

describe("fileUrlPlugin", () => {
  it("lets esbuild bundle file:// imports from staged script modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-netlify-"));
    try {
      const dep = join(dir, "dep.mjs");
      await writeFile(dep, "export const value = 42;");
      const entry = join(dir, "entry.mjs");
      await writeFile(
        entry,
        `export { value } from ${JSON.stringify(pathToFileURL(dep).href)};`,
      );
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        plugins: [fileUrlPlugin],
        logLevel: "silent",
      });
      assert.ok(result.outputFiles[0]!.text.includes("42"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
