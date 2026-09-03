import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: "components" },
    generate: {
      manifest: true,
      sitemap: true,
      robots: true,
      sitemapLastmod: false,
      cspHashes: false,
    },
    logging: { copies: true, deletes: true, level: "info", requests: true, transpiles: true },
    minify: { css: false, html: false, js: false },
    base: "/",
  },
}));

import { manifestCollector } from "./manifest.ts";
import { BascikConfig } from "./config.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("manifestCollector", () => {
  beforeEach(() => {
    manifestCollector.clear();
    (BascikConfig as any).directory.out = "dist";
    (BascikConfig as any).generate = {
      manifest: true,
      sitemap: true,
      robots: true,
      sitemapLastmod: false,
      cspHashes: false,
    };
  });

  it("generate.manifest: false writes no manifest", async () => {
    BascikConfig.generate.manifest = false;
    const outDir = join(tmpdir(), `bascik-manifest-test-${Date.now()}`);
    BascikConfig.directory.out = outDir;

    await manifestCollector.writeManifest("1.0.0");
    await expect(readFile(join(outDir, ".bascik", "manifest.json"))).rejects.toThrow();
    await rm(outDir, { recursive: true, force: true });
  });

  it("generate.manifest: true writes dist/.bascik/manifest.json", async () => {
    const outDir = join(tmpdir(), `bascik-manifest-test-${Date.now()}`);
    BascikConfig.directory.out = outDir;

    manifestCollector.recordFile(join(outDir, "index.html"), "<h1>Home</h1>");
    manifestCollector.recordFile(join(outDir, "styles.css"), "body{color:red;}");

    await manifestCollector.writeManifest("1.0.0");

    const manifestContent = await readFile(join(outDir, ".bascik", "manifest.json"), "utf8");
    const parsed = JSON.parse(manifestContent);

    expect(parsed.version).toBe("1.0.0");
    expect(parsed.files["index.html"]).toBeDefined();
    expect(parsed.files["index.html"].size).toBe(Buffer.byteLength("<h1>Home</h1>"));
    expect(parsed.files["index.html"].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.files["styles.css"]).toBeDefined();

    await rm(outDir, { recursive: true, force: true });
  });

  it("excludes the manifest file itself from manifest entries", async () => {
    const outDir = join(tmpdir(), `bascik-manifest-test-${Date.now()}`);
    BascikConfig.directory.out = outDir;

    manifestCollector.recordFile(join(outDir, ".bascik", "manifest.json"), "{}");
    manifestCollector.recordFile(join(outDir, "page.html"), "<div>content</div>");

    const files = manifestCollector.getFiles();
    expect(files[".bascik/manifest.json"]).toBeUndefined();
    expect(files["page.html"]).toBeDefined();

    await rm(outDir, { recursive: true, force: true });
  });

  it("normalizes paths relative to outDir with forward slashes on every platform", () => {
    BascikConfig.directory.out = "dist";
    manifestCollector.recordFile("dist/blog/post.html", "post");
    manifestCollector.recordFile("dist\\about\\team.html", "team");

    const files = manifestCollector.getFiles();
    expect(files["blog/post.html"]).toBeDefined();
    expect(files["about/team.html"]).toBeDefined();
  });

  it("sorts manifest entries byte-wise by path", () => {
    BascikConfig.directory.out = "dist";
    manifestCollector.recordFile("dist/zebra.html", "z");
    manifestCollector.recordFile("dist/apple.html", "a");
    manifestCollector.recordFile("dist/B_dir/item.html", "B");
    manifestCollector.recordFile("dist/a_dir/item.html", "a");

    const keys = Object.keys(manifestCollector.getFiles());
    expect(keys).toEqual([
      "B_dir/item.html",
      "a_dir/item.html",
      "apple.html",
      "zebra.html",
    ]);
  });

  it("produces byte-identical manifest output across two identical builds without timestamps", async () => {
    const outDir = join(tmpdir(), `bascik-manifest-test-${Date.now()}`);
    BascikConfig.directory.out = outDir;

    manifestCollector.recordFile(join(outDir, "index.html"), "<h1>Home</h1>");
    await manifestCollector.writeManifest("1.0.0");
    const run1 = await readFile(join(outDir, ".bascik", "manifest.json"), "utf8");

    // Wait briefly and write again
    await new Promise((r) => setTimeout(r, 10));
    await manifestCollector.writeManifest("1.0.0");
    const run2 = await readFile(join(outDir, ".bascik", "manifest.json"), "utf8");

    expect(run1).toBe(run2);
    expect(run1).not.toContain("timestamp");
    expect(run1).not.toContain("date");
    expect(run1).not.toContain("buildTime");

    await rm(outDir, { recursive: true, force: true });
  });
});
