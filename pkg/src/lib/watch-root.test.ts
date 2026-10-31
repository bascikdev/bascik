import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createSourceWatchIgnore, sourceWatchRoot } from "./watch-root.ts";
import { execWatchCoversPath } from "./exec.ts";

describe("sourceWatchRoot", () => {
  it.each([
    ["content/**/*.md", "content"],
    ["content/", "content/"],
    ["src/data/site.json", "src/data/site.json"],
    ["**/*.md", "."],
    ["*.json", "."],
    ["/abs/content/*.md", "/abs/content"],
    ["/**/*.md", "/"],
    ["content\\docs\\*.md", "content/docs"],
    ["content/{a,b}/*.md", "content"],
    ["content/@(a|b)/*.md", "content"],
    ["content/!(draft)/*.md", "content"],
  ])("%s starts in %s", (pattern, root) => {
    expect(sourceWatchRoot(pattern)).toBe(root);
  });

  // `@`, `+` and `!` are extglob operators only before `(`; a scoped package
  // folder such as `@milk` is a literal name.
  it.each([
    [
      "node_modules/@milk/frother-ui/dist/*.css",
      "node_modules/@milk/frother-ui/dist",
    ],
    [
      "node_modules/@milk/frother-ui/dist",
      "node_modules/@milk/frother-ui/dist",
    ],
    ["content/c++/*.md", "content/c++"],
  ])("%s starts in %s (literal @ and +)", (pattern, root) => {
    expect(sourceWatchRoot(pattern)).toBe(root);
  });
});

describe("execWatchCoversPath with literal @ and + folders", () => {
  it("a folder watch path inside a scoped package covers the files below it", () => {
    expect(
      execWatchCoversPath(
        ["node_modules/@milk/frother-ui/dist"],
        resolve("node_modules/@milk/frother-ui/dist/a.css"),
      ),
    ).toBe(true);
    expect(
      execWatchCoversPath(
        ["node_modules/@milk/frother-ui/dist/*.css"],
        resolve("node_modules/@milk/frother-ui/dist/a.css"),
      ),
    ).toBe(true);
    expect(
      execWatchCoversPath(["content/c++"], resolve("content/c++/a.md")),
    ).toBe(true);
  });

  it("extglob operators still match as globs", () => {
    expect(
      execWatchCoversPath(["content/@(a|b)/*.md"], resolve("content/a/x.md")),
    ).toBe(true);
    expect(
      execWatchCoversPath(["content/@(a|b)/*.md"], resolve("content/c/x.md")),
    ).toBe(false);
  });
});

describe("createSourceWatchIgnore", () => {
  const ignored = createSourceWatchIgnore(
    [".", "src/pages", "node_modules/@milk/frother-ui/dist"],
    ["dist", ".bascik/dist"],
  );

  it.each([
    "node_modules",
    "node_modules/pkg/index.js",
    ".git",
    ".git/objects/ab/cdef",
    "src/pages/node_modules/x/a.html",
    "packages/app/node_modules/x/a.json",
    "dist",
    "dist/data/x.json",
    ".bascik/dist/server-scripts.json",
    "node_modules/@milk/frother-ui/dist/node_modules/x/a.css",
  ])("ignores %s", (path) => {
    expect(ignored(resolve(path))).toBe(true);
    expect(ignored(path)).toBe(true);
  });

  it.each([
    ".",
    "README.md",
    "src/pages/index.html",
    "content/node_modules.md",
    "content/.gitkeep",
    "node_modules/@milk/frother-ui/dist",
    "node_modules/@milk/frother-ui/dist/a.css",
  ])("watches %s", (path) => {
    expect(ignored(resolve(path))).toBe(false);
  });

  it("ignores nothing outside the output folders when no root is the project root", () => {
    const narrow = createSourceWatchIgnore(["content"], ["dist"]);
    expect(narrow(resolve("content/a.md"))).toBe(false);
    expect(narrow(resolve("content/node_modules/a.md"))).toBe(true);
    expect(narrow(resolve("dist/a.md"))).toBe(true);
  });
});
