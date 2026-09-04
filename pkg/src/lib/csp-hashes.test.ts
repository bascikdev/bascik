import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: ["components"] },
    generate: { cspHashes: true, manifest: true },
    isBuild: true,
  },
}));

import { cspHashCollector } from "./csp-hashes.ts";
import { BascikConfig } from "./config.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

describe("csp-hashes manifest", () => {
  beforeEach(() => {
    cspHashCollector.clear();
    (BascikConfig as any).generate.cspHashes = true;
  });

  it("generate.cspHashes: false writes no file", async () => {
    (BascikConfig as any).generate.cspHashes = false;
    const res = await cspHashCollector.writeCspHashes();
    expect(res).toBeNull();
  });

  it("generate.cspHashes: true writes dist/.bascik/csp-hashes.json with correct format and post-minification hashes", async () => {
    const outDir = join(tmpdir(), `bascik-csp-test-${Date.now()}`);
    (BascikConfig as any).directory.out = outDir;

    const html =
      `<!DOCTYPE html><html><head><style>.card{color:red;}</style></head>` +
      `<body><script>console.log("hello");</script></body></html>`;

    cspHashCollector.recordPage("/index", html);
    const writtenPath = await cspHashCollector.writeCspHashes();
    expect(writtenPath).not.toBeNull();

    const content = await readFile(writtenPath!, "utf8");
    const manifest = JSON.parse(content);

    const expectedStyleHash = `sha256-${createHash("sha256").update(Buffer.from(".card{color:red;}", "utf8")).digest("base64")}`;
    const expectedScriptHash = `sha256-${createHash("sha256").update(Buffer.from('console.log("hello");', "utf8")).digest("base64")}`;

    expect(manifest["/index"]).toBeDefined();
    expect(manifest["/index"].styles).toContain(expectedStyleHash);
    expect(manifest["/index"].scripts).toContain(expectedScriptHash);

    await rm(outDir, { recursive: true, force: true });
  });

  it("deduplicates identical inline script/style blocks within a page", () => {
    const html =
      `<style>body{}</style><style>body{}</style>` +
      `<script>run();</script><script>run();</script>`;

    cspHashCollector.recordPage("/dup", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/dup"].styles).toHaveLength(1);
    expect(manifest["/dup"].scripts).toHaveLength(1);
  });

  it("excludes external scripts and stylesheets", () => {
    const html = `<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>`;
    cspHashCollector.recordPage("/external", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/external"].styles).toEqual([]);
    expect(manifest["/external"].scripts).toEqual([]);
  });

  it("excludes inert server-script placeholders from script hashes", () => {
    const html = `<script type="text/bascik-server" data-bascik-server-id="123"></script>`;
    cspHashCollector.recordPage("/server-placeholder", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/server-placeholder"].scripts).toEqual([]);
  });

  it("produces deterministic, byte-identical manifest across runs", async () => {
    const outDir = join(tmpdir(), `bascik-csp-test-${Date.now()}`);
    (BascikConfig as any).directory.out = outDir;

    const html = `<style>.a{}</style><script>console.log(1);</script>`;
    cspHashCollector.recordPage("/a", html);
    cspHashCollector.recordPage("/b", html);

    await cspHashCollector.writeCspHashes();
    const run1 = await readFile(join(outDir, ".bascik", "csp-hashes.json"), "utf8");

    await cspHashCollector.writeCspHashes();
    const run2 = await readFile(join(outDir, ".bascik", "csp-hashes.json"), "utf8");

    expect(run1).toBe(run2);
    await rm(outDir, { recursive: true, force: true });
  });
});
