import { describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    base: "/",
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    scoping: {
      attributes: { class: true, id: true, name: true },
      scriptBlocks: true,
      inheritAttributes: true,
      deduplicateCss: true,
      preserve: ["code"],
    },
    isBuild: true,
    minify: {
      html: false,
      css: false,
      js: false,
      identifiers: false,
    },
    assets: {
      inlineStyles: false,
      exclude: [],
    },
    logging: {
      level: "info",
      requests: true,
      copies: true,
      deletes: true,
      transpiles: true,
    },
  },
}));

import { transpilePage } from "./processing.ts";
import { BascikConfig } from "./config.ts";

describe("Build determinism", () => {
  it("transpiling pages with components, scoped IDs, and attributes produces byte-identical output across runs", async () => {
    const testDir = join(tmpdir(), `bascik-determinism-${Date.now()}`);
    const pagesDir = join(testDir, "src", "pages");
    const componentsDir = join(testDir, "src", "components");
    const outDir = join(testDir, "dist");

    await mkdir(pagesDir, { recursive: true });
    await mkdir(componentsDir, { recursive: true });

    (BascikConfig as any).directory = {
      pages: pagesDir,
      components: componentsDir,
      out: outDir,
    };
    (BascikConfig as any).scoping = {
      attributes: { class: true, id: true, name: true },
      scriptBlocks: true,
      inheritAttributes: true,
      deduplicateCss: true,
      preserve: ["code"],
    };
    (BascikConfig as any).isBuild = true;

    const pageFile = join(pagesDir, "index.html");
    const pageHtml = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <my-card class="primary" id="first-card"></my-card>
  <my-card class="secondary" id="second-card"></my-card>
</body>
</html>`;
    await writeFile(pageFile, pageHtml, "utf8");

    const componentList = {
      "my-card": {
        name: "my-card",
        fileName: join(componentsDir, "my-card.html"),
        fileContent: `<div class="card" id="card-inner" name="card-item"><p class="text">Card</p></div>`,
        cssFileContent: `.card { color: red; } #card-inner { font-weight: bold; }`,
      },
    };

    const run1 = await transpilePage(pageFile, componentList, "");
    const run2 = await transpilePage(pageFile, componentList, "");

    expect(run1).not.toBeNull();
    expect(run2).not.toBeNull();
    expect(run1!.distHtml).toBe(run2!.distHtml);
    expect(run1!.distHtml).toContain('id="bascik__my-card__');
    expect(run1!.distHtml).toContain('name="bascik__my-card__');

    // Regression test for production builds with minify.identifiers = true
    (BascikConfig as any).minify = { identifiers: true };
    const runMinified = await transpilePage(pageFile, componentList, "");
    expect(runMinified).not.toBeNull();
    // The distHtml contains the component's <style> block where #card-inner was converted to a minified class (b...)
    const cardInnerClassMatch = runMinified!.distHtml.match(/<style[^>]*>[\s\S]*?\.(b[0-9a-zA-Z]{11})[\s\S]*?font-weight:\s*bold/);
    expect(cardInnerClassMatch).not.toBeNull();
    const minifiedScopedClass = cardInnerClassMatch![1];
    // And that class was injected into the matching element tag
    expect(runMinified!.distHtml).toMatch(new RegExp(`<div[^>]*class="[^"]*\\b${minifiedScopedClass}\\b[^"]*"`));
    (BascikConfig as any).minify = { identifiers: false };

    await rm(testDir, { recursive: true, force: true });
  });
});
