import { describe, it, expect, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: {
      pages: "/project/src/pages",
      components: ["/shared/components", "/project/src/components"],
      out: "/project/dist",
    },
  },
}));

import { posix, win32 } from "node:path";
import { displayComponentRoot, findComponentRoot } from "./component-roots.ts";

describe("findComponentRoot", () => {
  it("returns the configured root that contains the path", () => {
    expect(findComponentRoot("/project/src/components/card/card.html")).toBe(
      "/project/src/components",
    );
    expect(findComponentRoot("/shared/components/site-nav.html")).toBe(
      "/shared/components",
    );
  });

  it("returns the root itself for the root path", () => {
    expect(findComponentRoot("/shared/components")).toBe("/shared/components");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(
      findComponentRoot("/project/src/components-shared/x.html"),
    ).toBeUndefined();
    expect(findComponentRoot("/shared/components2/x.html")).toBeUndefined();
  });

  it("returns undefined for a path under no root", () => {
    expect(findComponentRoot("/project/src/pages/index.html")).toBeUndefined();
    expect(findComponentRoot("/elsewhere/components/x.html")).toBeUndefined();
  });

  it("normalizes Windows separators before matching", () => {
    expect(findComponentRoot("\\project\\src\\components\\x.html")).toBe(
      "/project/src/components",
    );
  });
});

describe("displayComponentRoot", () => {
  it.each([
    ["the project folder itself", "/a/b", "/a/b", "components"],
    [
      "a folder inside the project",
      "/a/b/src/components",
      "/a/b",
      "components",
    ],
    ["the project's parent folder", "/a", "/a/b", ".."],
    ["a grandparent folder", "/a", "/a/b/c", "../.."],
    [
      "a sibling folder",
      "/a/shared/components",
      "/a/b",
      "../shared/components",
    ],
    [
      "a folder whose name starts with two dots, inside the project",
      "/a/b/..components",
      "/a/b",
      "components",
    ],
  ])("shows %s by where it is", (_case, root, cwd, expected) => {
    expect(displayComponentRoot(root, cwd, posix)).toBe(expected);
  });

  it("shows a root on another Windows drive by its path, the only form that locates it", () => {
    expect(
      displayComponentRoot("D:\\shared\\components", "C:\\proj", win32),
    ).toBe("D:/shared/components");
  });

  it("shows the parent of a Windows project as ..", () => {
    expect(displayComponentRoot("C:\\proj", "C:\\proj\\app", win32)).toBe("..");
  });
});
