import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "./config-validation.ts";
import {
  rewriteCssBasePaths,
  rewriteHtmlBasePaths,
  rewriteManifestBasePaths,
  rewriteSrcsetBasePaths,
  shouldRewriteBasePath,
} from "./base-path.ts";

describe("base path normalization", () => {
  it.each([
    ["/", "/"],
    ["/sub", "/sub/"],
    ["sub", "/sub/"],
    ["/sub/", "/sub/"],
    ["/a/b", "/a/b/"],
    ["", "/"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe("shouldRewriteBasePath", () => {
  it.each([
    ["/x", true],
    ["//cdn.example.com/x.js", false],
    ["https://example.com/x", false],
    ["http://example.com/x", false],
    ["data:image/svg+xml;base64,PHN2Zy8+", false],
    ["blob:https://example.com/id", false],
    ["mailto:a@b.c", false],
    ["tel:+15551212", false],
    ["sms:+15551212", false],
    ["javascript:void(0)", false],
    ["#top", false],
    ["./x", false],
    ["../x", false],
    ["x", false],
    ["", false],
    ["/sub/x", false],
  ])("classifies %j", (value, expected) => {
    expect(shouldRewriteBasePath(value, "/sub/")).toBe(expected);
  });
});

describe("rewriteSrcsetBasePaths", () => {
  it.each([
    ["/image.png", "/sub/image.png"],
    ["/small.png 320w, /large.png 1280w", "/sub/small.png 320w, /sub/large.png 1280w"],
    ["/one.png 1x, /two.png 2x", "/sub/one.png 1x, /sub/two.png 2x"],
    ["https://cdn.example.com/x.png 1x, /x.png 2x", "https://cdn.example.com/x.png 1x, /sub/x.png 2x"],
    ["data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, /x.png 2x", "data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, /sub/x.png 2x"],
    [" /one.png 1x ,  /two.png 2x,", " /sub/one.png 1x ,  /sub/two.png 2x,"],
  ])("rewrites %j", (input, expected) => {
    expect(rewriteSrcsetBasePaths(input, "/sub/")).toBe(expected);
  });
});

describe("rewriteHtmlBasePaths", () => {
  it("is byte-identical for the root base", () => {
    const html = `<a href="/about">A</a><style>.x { background: url('/x.png') }</style>`;
    expect(rewriteHtmlBasePaths(html, "/")).toBe(html);
  });

  it("rewrites URL-bearing attributes and known social metadata", () => {
    const html = [
      `<a href="/about">About</a>`,
      `<img src='/logo.png' srcset="/small.png 1x, /large.png 2x">`,
      `<link rel="preload" href="/font.woff2" imagesrcset="/small.png 320w, /large.png 1280w">`,
      `<video poster="/poster.jpg"></video>`,
      `<object data="/movie.swf"></object>`,
      `<button formaction="/save">Save</button>`,
      `<form action="/submit"></form>`,
      `<meta property="og:image" content="/share.png">`,
      `<meta property="og:url" content="/about">`,
      `<meta name="twitter:image" content="/twitter.png">`,
      `<meta name="description" content="/not-a-url">`,
      `<div style="background: url(/inline.png)"></div>`,
      `<style>@import '/theme.css'; .x { background: image-set(url('/one.png') 1x, '/two.png' 2x) }</style>`,
    ].join("");

    const result = rewriteHtmlBasePaths(html, "/sub/");
    expect(result).toContain(`href="/sub/about"`);
    expect(result).toContain(`src='/sub/logo.png'`);
    expect(result).toContain(`srcset="/sub/small.png 1x, /sub/large.png 2x"`);
    expect(result).toContain(`imagesrcset="/sub/small.png 320w, /sub/large.png 1280w"`);
    expect(result).toContain(`poster="/sub/poster.jpg"`);
    expect(result).toContain(`data="/sub/movie.swf"`);
    expect(result).toContain(`formaction="/sub/save"`);
    expect(result).toContain(`action="/sub/submit"`);
    expect(result).toContain(`content="/sub/share.png"`);
    expect(result).toContain(`content="/sub/twitter.png"`);
    expect(result).toContain(`name="description" content="/not-a-url"`);
    expect(result).toContain(`url(/sub/inline.png)`);
    expect(result).toContain(`@import '/sub/theme.css'`);
    expect(result).toContain(`url('/sub/one.png')`);
    expect(result).toContain(`'/sub/two.png' 2x`);
  });

  it("leaves fragments for ID-reference rewriting and transforms paths once", () => {
    const html = `<a href="#local-id">Local</a><a href="/about">About</a>`;
    const once = rewriteHtmlBasePaths(html, "/sub/");
    expect(once).toBe(`<a href="#local-id">Local</a><a href="/sub/about">About</a>`);
    expect(rewriteHtmlBasePaths(once, "/sub/")).toBe(once);
  });
});

describe("rewriteCssBasePaths", () => {
  it("rewrites url, import, and image-set strings", () => {
    const css = `@import "/theme.css"; a{background:url(/a.png)} b{background-image:image-set('/b.png' 1x, url("/c.png") 2x)}`;
    expect(rewriteCssBasePaths(css, "/sub/")).toBe(
      `@import "/sub/theme.css"; a{background:url(/sub/a.png)} b{background-image:image-set('/sub/b.png' 1x, url("/sub/c.png") 2x)}`,
    );
  });

  it("leaves excluded CSS values byte-identical", () => {
    const css = `a{mask:url(#icon);background:url(data:image/svg+xml,%3Csvg/%3E)}b{background:url(https://cdn.example.com/x.png)}c{background:url(../x.png)}`;
    expect(rewriteCssBasePaths(css, "/sub/")).toBe(css);
    expect(rewriteCssBasePaths(css, "/")).toBe(css);
  });

  it("is idempotent and preserves replacement tokens", () => {
    const css = `a{background:url('/$&/$1/%24.png')}`;
    const once = rewriteCssBasePaths(css, "/sub/");
    expect(once).toBe(`a{background:url('/sub/$&/$1/%24.png')}`);
    expect(rewriteCssBasePaths(once, "/sub/")).toBe(once);
  });
});

describe("rewriteManifestBasePaths", () => {
  it("rewrites start_url, scope, and icon sources", () => {
    const manifest = JSON.stringify({
      name: "App",
      start_url: "/",
      scope: "/app/",
      icons: [{ src: "/icon.png" }, { src: "https://cdn.example.com/icon.png" }],
    });
    expect(JSON.parse(rewriteManifestBasePaths(manifest, "/sub/"))).toEqual({
      name: "App",
      start_url: "/sub/",
      scope: "/sub/app/",
      icons: [{ src: "/sub/icon.png" }, { src: "https://cdn.example.com/icon.png" }],
    });
  });

  it("warns and preserves malformed manifests", () => {
    const malformed = `{ "start_url": "/"`;
    expect(rewriteManifestBasePaths(malformed, "/sub/")).toBe(malformed);
  });
});