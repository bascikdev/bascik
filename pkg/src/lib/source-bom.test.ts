/**
 * Findings 21 and 138: editors on Windows (Notepad, Visual Studio,
 * PowerShell `Set-Content`) save UTF-8 with a byte order mark. U+FEFF is not
 * HTML whitespace, so a BOM copied out of a component used in `<head>` closes
 * the head and moves the meta charset, stylesheet link, and title into
 * `<body>`; one copied out of a page puts text before the doctype, which
 * `bascik --check` then reports as a missing doctype.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

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
    minify: { html: false, css: false, js: false, identifiers: false },
    assets: { inlineStyles: false, exclude: [] },
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
import { invalidateComponentListCache, listComponents } from "./components.ts";
import { BascikConfig } from "./config.ts";

const BOM = "\ufeff";
type Element = DefaultTreeAdapterTypes.Element;

const childElement = (parent: { childNodes: unknown[] }, tag: string) =>
  (parent.childNodes as Element[]).find((n) => n.nodeName === tag)!;

describe("UTF-8 byte order mark in source files", () => {
  let root: string;
  let distHtml: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-bom-"));
    const pages = join(root, "src", "pages");
    const components = join(root, "src", "components");
    await mkdir(join(components, "site-head"), { recursive: true });
    await mkdir(join(components, "hello-card"), { recursive: true });
    await mkdir(pages, { recursive: true });
    await writeFile(
      join(components, "site-head", "site-head.html"),
      `${BOM}<meta charset="utf-8" />\n<title>bom</title>\n<style>.head-style { color: blue; }</style>\n`,
    );
    await writeFile(
      join(components, "hello-card", "hello-card.html"),
      `${BOM}<p class="hi">hello</p>\n<script>console.log("hi");</script>\n`,
    );
    await writeFile(
      join(components, "hello-card", "hello-card.css"),
      `${BOM}.hi { color: red; }\n`,
    );
    await writeFile(
      join(pages, "index.html"),
      `${BOM}<!doctype html>\n<html lang="en">\n<head>\n<site-head />\n</head>\n<body>\n<hello-card />\n<hello-card />\n</body>\n</html>\n`,
    );
    (BascikConfig as any).directory = {
      pages,
      components: [components],
      out: join(root, "dist"),
    };
    invalidateComponentListCache();
    const list = await listComponents([components]);
    const result = await transpilePage(join(pages, "index.html"), list, "");
    distHtml = result!.distHtml;
  });

  afterAll(async () => {
    invalidateComponentListCache();
    await rm(root, { recursive: true, force: true });
  });

  it("emits no U+FEFF anywhere in the page", () => {
    expect(distHtml.includes(BOM)).toBe(false);
  });

  it("starts the page with its doctype, so --check finds it", () => {
    // Only HTML whitespace: JavaScript's trim() would also drop U+FEFF.
    expect(distHtml).toMatch(/^[ \t\n\f\r]*<!doctype html>/i);
  });

  it("keeps a BOM component used in <head> inside <head>", () => {
    const html = childElement(parse(distHtml), "html");
    const head = childElement(html, "head");
    const body = childElement(html, "body");
    const headTags = (head.childNodes as Element[]).map((n) => n.nodeName);
    expect(headTags).toContain("meta");
    expect(headTags).toContain("title");
    const bodyTags = (body.childNodes as Element[]).map((n) => n.nodeName);
    expect(bodyTags).not.toContain("meta");
    expect(bodyTags).not.toContain("title");
  });

  it("scopes the first rule of a BOM companion stylesheet", () => {
    // A BOM left in front of `.hi` makes the selector `\ufeff.hi`, a type
    // selector that matches nothing.
    expect(distHtml).toMatch(/\.bascik__hello-card__hi\s*\{\s*color:\s*red/);
  });
});
