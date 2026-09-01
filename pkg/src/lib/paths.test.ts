import { describe, it, expect } from "vitest";
import { getHttpPath } from "./paths.ts";

describe("getHttpPath", () => {
  it("converts pages/index.html to /", () => {
    expect(getHttpPath("pages/index.html")).toBe("/");
  });

  it("converts pages/about.html to /about", () => {
    expect(getHttpPath("pages/about.html")).toBe("/about");
  });

  it("converts pages/blog/post.html to /blog/post", () => {
    expect(getHttpPath("pages/blog/post.html")).toBe("/blog/post");
  });

  it("converts pages/sub/index.html to /sub/", () => {
    expect(getHttpPath("pages/sub/index.html")).toBe("/sub/");
  });

  it("converts a deeply nested page", () => {
    expect(getHttpPath("pages/a/b/c.html")).toBe("/a/b/c");
  });

  it("converts a deeply nested index page", () => {
    expect(getHttpPath("pages/a/b/index.html")).toBe("/a/b/");
  });

  it("strips only the leading pages segment", () => {
    // path containing 'pages' elsewhere should not be affected
    expect(getHttpPath("pages/pages-about.html")).toBe("/pages-about");
  });

  it("handles Windows backslash path separators", () => {
    expect(getHttpPath("pages\\index.html")).toBe("/");
    expect(getHttpPath("pages\\about.html")).toBe("/about");
    expect(getHttpPath("pages\\blog\\post.html")).toBe("/blog/post");
    expect(getHttpPath("pages\\sub\\index.html")).toBe("/sub/");
  });

  it("handles paths starting with src/pages or absolute paths", () => {
    expect(getHttpPath("src/pages/cli.html")).toBe("/cli");
    expect(getHttpPath("/project/src/pages/cli.html")).toBe("/cli");
    expect(getHttpPath("src/pages/index.html")).toBe("/");
    expect(getHttpPath("src/pages/sub/index.html")).toBe("/sub/");
  });

  it("handles bare filenames or paths missing pages prefix", () => {
    expect(getHttpPath("cli.html")).toBe("/cli");
    expect(getHttpPath("/cli.html")).toBe("/cli");
  });

  it("handles mixed backslashes, leading slashes, and 'pages' segment in directory names", () => {
    expect(getHttpPath("C:\\my-project\\src\\pages\\docs\\pages-guide.html")).toBe("/docs/pages-guide");
    expect(getHttpPath("///src/pages/deeply//nested///index.html")).toBe("/deeply/nested/");
    expect(getHttpPath("pages/sub-pages/index.html")).toBe("/sub-pages/");
  });

  it("honors a custom pages directory", () => {
    expect(getHttpPath("/project/src/html/blog/index.html", "src/html")).toBe("/blog/");
  });

  it.each([
    ["pages/index/deep.html", "/index/deep"],
    ["pages/résumé #100%.html", "/résumé #100%"],
    ["pages//blog///index.html", "/blog/"],
    ["/srv/src/pages/demo/src/pages/post.html", "/post"],
    ["pages/blog/", "/blog/"],
  ])("canonicalizes %s", (input, expected) => {
    expect(getHttpPath(input)).toBe(expected);
  });
});

