import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({
  config: {
    base: "/",
    directory: { pages: "" },
    assets: { inlineStyles: false as boolean | string[] },
  },
}));

vi.mock("./config.js", () => ({ BascikConfig: config }));

import {
  findInlinedStylesheetLinks,
  inlinedStylesheetLinkMessage,
} from "./inline-style-links.ts";

const root = mkdtempSync(join(tmpdir(), "bascik-inline-links-"));
const pages = join(root, "src", "pages");
mkdirSync(join(pages, "css"), { recursive: true });
mkdirSync(join(pages, "blog"), { recursive: true });
writeFileSync(join(pages, "css", "styles.css"), "body{color:red}");
writeFileSync(join(pages, "css", "print.css"), "body{color:black}");
writeFileSync(join(pages, "blog", "post.css"), "p{margin:0}");
const indexPage = join(pages, "index.html");
const blogPage = join(pages, "blog", "post.html");

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  config.base = "/";
  config.directory.pages = pages;
  config.assets.inlineStyles = [join(pages, "css", "styles.css")];
});

const hrefs = (html: string, fromFile?: string) =>
  findInlinedStylesheetLinks(html, fromFile).map((link) => link.href);

describe("findInlinedStylesheetLinks", () => {
  it("finds a root-relative link to an inlined stylesheet", () => {
    const html = `<head><link rel="stylesheet" href="/css/styles.css"></head>`;
    expect(findInlinedStylesheetLinks(html, indexPage)).toEqual([
      {
        href: "/css/styles.css",
        offset: 6,
        filePath: join(pages, "css", "styles.css"),
      },
    ]);
  });

  it("reads Prettier-wrapped tags, any attribute order and rel token lists", () => {
    const html = `<link\n  href="/css/styles.css?v=2"\n  rel="preload Stylesheet"\n/>`;
    expect(hrefs(html, indexPage)).toEqual(["/css/styles.css?v=2"]);
  });

  it("resolves a relative href against the page's folder", () => {
    config.assets.inlineStyles = true;
    expect(hrefs(`<link rel=stylesheet href=post.css>`, blogPage)).toEqual([
      "post.css",
    ]);
    expect(
      hrefs(`<link rel="stylesheet" href="../css/styles.css">`, blogPage),
    ).toEqual(["../css/styles.css"]);
    // In a component the page is unknown, so a relative href is not judged.
    expect(hrefs(`<link rel="stylesheet" href="post.css">`)).toEqual([]);
  });

  it("strips the configured base from a built page's href", () => {
    config.base = "/docs/";
    expect(
      hrefs(`<link rel="stylesheet" href="/docs/css/styles.css">`, indexPage),
    ).toEqual(["/docs/css/styles.css"]);
  });

  it("finds every css file of the pages folder with inlineStyles: true", () => {
    config.assets.inlineStyles = true;
    expect(
      hrefs(
        `<link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/print.css">`,
        indexPage,
      ),
    ).toEqual(["/css/styles.css", "/css/print.css"]);
  });

  it("ignores links that still work", () => {
    const html = [
      // Not inlined: listed stylesheets only.
      `<link rel="stylesheet" href="/css/print.css">`,
      // Not a stylesheet.
      `<link rel="preload" as="style" href="/css/styles.css">`,
      `<link rel="icon" href="/css/styles.css">`,
      // External.
      `<link rel="stylesheet" href="https://example.com/css/styles.css">`,
      `<link rel="stylesheet" href="//example.com/css/styles.css">`,
      // A file that does not exist is a different mistake.
      `<link rel="stylesheet" href="/css/missing.css">`,
      // Outside the pages folder.
      `<link rel="stylesheet" href="../../../css/styles.css">`,
      // Inert markup.
      `<template><link rel="stylesheet" href="/css/styles.css"></template>`,
      `<!-- <link rel="stylesheet" href="/css/styles.css"> -->`,
      `<script>"<link rel='stylesheet' href='/css/styles.css'>"</script>`,
    ].join("\n");
    expect(hrefs(html, indexPage)).toEqual([]);
  });

  it("finds nothing when inlineStyles is off", () => {
    config.assets.inlineStyles = false;
    expect(
      hrefs(`<link rel="stylesheet" href="/css/styles.css">`, indexPage),
    ).toEqual([]);
  });

  it("names the link and the fix in its message", () => {
    expect(inlinedStylesheetLinkMessage("/css/styles.css")).toMatch(
      /<link rel="stylesheet" href="\/css\/styles\.css">.*assets\.inlineStyles.*404.*Remove the <link>/,
    );
  });
});
