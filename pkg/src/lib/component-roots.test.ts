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

import { findComponentRoot } from "./component-roots.ts";

describe("findComponentRoot", () => {
  it("returns the configured root that contains the path", () => {
    expect(findComponentRoot("/project/src/components/card/card.html")).toBe("/project/src/components");
    expect(findComponentRoot("/shared/components/site-nav.html")).toBe("/shared/components");
  });

  it("returns the root itself for the root path", () => {
    expect(findComponentRoot("/shared/components")).toBe("/shared/components");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(findComponentRoot("/project/src/components-shared/x.html")).toBeUndefined();
    expect(findComponentRoot("/shared/components2/x.html")).toBeUndefined();
  });

  it("returns undefined for a path under no root", () => {
    expect(findComponentRoot("/project/src/pages/index.html")).toBeUndefined();
    expect(findComponentRoot("/elsewhere/components/x.html")).toBeUndefined();
  });

  it("normalizes Windows separators before matching", () => {
    expect(findComponentRoot("\\project\\src\\components\\x.html")).toBe("/project/src/components");
  });
});
