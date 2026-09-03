import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./paths.js", () => ({
  getHttpPath: vi.fn((p: string) => p),
}));

vi.mock("./file-system.js", () => ({
  getRelativePath: vi.fn((p: string) => p),
}));

// ─────────────────────────────────────────────────────────────────────────────

// Use dynamic imports so each test gets a fresh MemoryStore instance
let mem: Awaited<typeof import("./mem.ts")>["mem"];

beforeEach(async () => {
  vi.resetModules();
  // Re-import mem; the mocked paths/file-system factories are called fresh
  const memMod = await import("./mem.ts");
  mem = memMod.mem;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const storeSample = async (key = "test-page", components: string[] = []) => {
  // With identity mocks, relativePagePath == absolutePagePath == httpPath
  await mem.storePage({
    relativePagePath: key,
    absolutePagePath: key,
    pageContent: `<html><body>Page: ${key}</body></html>`,
    usedComponentsNames: components,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// storePage / getPage round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("storePage + getPage round-trip", () => {
  it("returns the stored page for the correct httpPath", async () => {
    await storeSample("rt-test");
    const page = mem.getPage("rt-test");
    expect(page).toBeDefined();
    expect(page?.relativePagePath).toBe("rt-test");
    expect(page?.absolutePagePath).toBe("rt-test");
  });

  it("page content is stored as a Buffer", async () => {
    await storeSample("buf-test");
    const page = mem.getPage("buf-test");
    expect(Buffer.isBuffer(page?.content)).toBe(true);
  });

  it("page compressedContent is eventually populated as a Buffer (background compression)", async () => {
    await storeSample("br-test");
    await vi.waitFor(() => {
      const page = mem.getPage("br-test");
      expect(Buffer.isBuffer(page?.compressedContent)).toBe(true);
    });
  });

  it("stores usedComponentsSet as a Set", async () => {
    await storeSample("comp-test", ["my-nav", "my-footer"]);
    const page = mem.getPage("comp-test");
    expect(page?.usedComponentsSet).toBeInstanceOf(Set);
    expect(page?.usedComponentsSet.has("my-nav")).toBe(true);
    expect(page?.usedComponentsSet.has("my-footer")).toBe(true);
  });

  it("pre-computes etag property on StoredPage", async () => {
    await storeSample("etag-test");
    const page = mem.getPage("etag-test");
    expect(page?.etag).toBeDefined();
    expect(typeof page?.etag).toBe("string");
    expect(page?.etag?.startsWith('"')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPage fallback to 404
// ─────────────────────────────────────────────────────────────────────────────

describe("getPage fallback to /404", () => {
  it("returns undefined when path not found and no /404 page stored", () => {
    const page = mem.getPage("/definitely-not-stored");
    expect(page).toBeUndefined();
  });

  it("returns the /404 page as a fallback for unknown paths", async () => {
    await storeSample("/404");
    const fallback = mem.getPage("/this-does-not-exist");
    expect(fallback).toBeDefined();
    expect(fallback?.relativePagePath).toBe("/404");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removePage
// ─────────────────────────────────────────────────────────────────────────────

describe("removePage", () => {
  it("removes the page so getPage returns undefined", async () => {
    await storeSample("remove-me");
    expect(mem.getPage("remove-me")).toBeDefined();
    mem.removePage("remove-me");
    expect(mem.getPage("remove-me")).toBeUndefined();
  });

  it("does nothing when the page does not exist", () => {
    // Should not throw
    expect(() => mem.removePage("nonexistent-key")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component reverse-index (pagesThisComponentIsUsedOn)
// ─────────────────────────────────────────────────────────────────────────────

describe("pagesThisComponentIsUsedOn", () => {
  it("returns pages that use the given component", async () => {
    await storeSample("page-a", ["my-nav"]);
    await storeSample("page-b", ["my-nav", "my-footer"]);
    const pages = mem.pagesThisComponentIsUsedOn("my-nav");
    expect(pages).toContain("page-a");
    expect(pages).toContain("page-b");
  });

  it("returns an empty array for a component that has no pages", () => {
    expect(mem.pagesThisComponentIsUsedOn("unused-comp")).toEqual([]);
  });

  it("removes a page from the component index when the page is removed", async () => {
    await storeSample("comp-page", ["my-widget"]);
    expect(mem.pagesThisComponentIsUsedOn("my-widget")).toContain("comp-page");
    mem.removePage("comp-page");
    expect(mem.pagesThisComponentIsUsedOn("my-widget")).not.toContain(
      "comp-page",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Update (store same page twice)
// ─────────────────────────────────────────────────────────────────────────────

describe("storePage update", () => {
  it("overwrites an existing page with new content", async () => {
    await mem.storePage({
      relativePagePath: "update-test",
      absolutePagePath: "update-test",
      pageContent: "<html>v1</html>",
    });
    await mem.storePage({
      relativePagePath: "update-test",
      absolutePagePath: "update-test",
      pageContent: "<html>v2</html>",
    });
    const page = mem.getPage("update-test");
    // The content buffer should contain v2
    expect(page?.content.toString()).toContain("v2");
    expect(page?.content.toString()).not.toContain("v1");
  });

  it("updates the component index when a page drops a component", async () => {
    // First store with two components
    await mem.storePage({
      relativePagePath: "upd-comp",
      absolutePagePath: "upd-comp",
      pageContent: "<html></html>",
      usedComponentsNames: ["comp-a", "comp-b"],
    });
    expect(mem.pagesThisComponentIsUsedOn("comp-b")).toContain("upd-comp");

    // Re-store with only comp-a (comp-b dropped)
    await mem.storePage({
      relativePagePath: "upd-comp",
      absolutePagePath: "upd-comp",
      pageContent: "<html></html>",
      usedComponentsNames: ["comp-a"],
    });
    expect(mem.pagesThisComponentIsUsedOn("comp-a")).toContain("upd-comp");
    expect(mem.pagesThisComponentIsUsedOn("comp-b")).not.toContain("upd-comp");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fileDependencies / pagesDependentOnFile
// ─────────────────────────────────────────────────────────────────────────────

describe("fileDependencies and pagesDependentOnFile", () => {
  it("returns empty array for an unknown file path", () => {
    expect(mem.pagesDependentOnFile("content/unknown.md")).toEqual([]);
  });

  it("returns the list of pages that depend on a specific file", async () => {
    await mem.storePage({
      relativePagePath: "pages/cli.html",
      absolutePagePath: "pages/cli.html",
      pageContent: "<html></html>",
      fileDependencies: ["content/cli.md", "scripts/md-renderer.ts"],
    });

    await mem.storePage({
      relativePagePath: "pages/testing.html",
      absolutePagePath: "pages/testing.html",
      pageContent: "<html></html>",
      fileDependencies: ["content/testing.md", "scripts/md-renderer.ts"],
    });

    expect(mem.pagesDependentOnFile("content/cli.md")).toEqual(["pages/cli.html"]);
    expect(mem.pagesDependentOnFile("content/testing.md")).toEqual(["pages/testing.html"]);
    expect(mem.pagesDependentOnFile("scripts/md-renderer.ts")).toContain("pages/cli.html");
    expect(mem.pagesDependentOnFile("scripts/md-renderer.ts")).toContain("pages/testing.html");
  });

  it("normalizes path strings so absolute, relative, and ./ paths match", async () => {
    await mem.storePage({
      relativePagePath: "pages/cli.html",
      absolutePagePath: "pages/cli.html",
      pageContent: "<html></html>",
      fileDependencies: ["./content/cli.md"],
    });

    expect(mem.pagesDependentOnFile("content/cli.md")).toEqual(["pages/cli.html"]);
    expect(mem.pagesDependentOnFile(`${process.cwd()}/content/cli.md`)).toEqual(["pages/cli.html"]);
  });

  it("updates file dependencies when a page is updated", async () => {
    await mem.storePage({
      relativePagePath: "pages/dynamic.html",
      absolutePagePath: "pages/dynamic.html",
      pageContent: "<html></html>",
      fileDependencies: ["content/old.md"],
    });
    expect(mem.pagesDependentOnFile("content/old.md")).toEqual(["pages/dynamic.html"]);

    await mem.storePage({
      relativePagePath: "pages/dynamic.html",
      absolutePagePath: "pages/dynamic.html",
      pageContent: "<html></html>",
      fileDependencies: ["content/new.md"],
    });
    expect(mem.pagesDependentOnFile("content/old.md")).toEqual([]);
    expect(mem.pagesDependentOnFile("content/new.md")).toEqual(["pages/dynamic.html"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-flight rebuilds & dirty page tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("dirty page tracking and pending in-flight rebuilds", () => {
  it("marks a page dirty when dependencies change and resolves getPage after rebuild", async () => {
    await storeSample("doc-page");
    expect(mem.isDirty("doc-page")).toBe(false);

    mem.markDirty("doc-page");
    expect(mem.isDirty("doc-page")).toBe(true);

    let resolved = false;
    const rebuildPromise = mem.waitForFreshPage("doc-page").then((page) => {
      resolved = true;
      return page;
    });

    expect(resolved).toBe(false);

    // Now store fresh rebuild
    await mem.storePage({
      relativePagePath: "doc-page",
      absolutePagePath: "doc-page",
      pageContent: "<html><body>Fresh Version</body></html>",
    });

    const freshPage = await rebuildPromise;
    expect(resolved).toBe(true);
    expect(mem.isDirty("doc-page")).toBe(false);
    expect(freshPage?.content.toString("utf8")).toContain("Fresh Version");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Open-page tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("openPages tracking", () => {
  it("starts empty", () => {
    expect(mem.openPages).toEqual([]);
  });

  it("trackOpenPage adds an http path", () => {
    mem.trackOpenPage("/about");
    expect(mem.openPages).toContain("/about");
  });

  it("untrackOpenPage removes the path", () => {
    mem.trackOpenPage("/about");
    mem.untrackOpenPage("/about");
    expect(mem.openPages).not.toContain("/about");
  });

  it("tracks multiple pages independently", () => {
    mem.trackOpenPage("/about");
    mem.trackOpenPage("/faq");
    expect(mem.openPages).toContain("/about");
    expect(mem.openPages).toContain("/faq");
  });

  it("untracking one page does not affect others", () => {
    mem.trackOpenPage("/about");
    mem.trackOpenPage("/faq");
    mem.untrackOpenPage("/about");
    expect(mem.openPages).not.toContain("/about");
    expect(mem.openPages).toContain("/faq");
  });

  it("tracking the same path twice does not duplicate it", () => {
    mem.trackOpenPage("/about");
    mem.trackOpenPage("/about");
    expect(mem.openPages.filter(p => p === "/about")).toHaveLength(1);
  });

  it("untracking a path that was never tracked is a no-op", () => {
    expect(() => mem.untrackOpenPage("/never-tracked")).not.toThrow();
    expect(mem.openPages).toEqual([]);
  });

  it("untracking one connection for a path does not remove it when another is open", () => {
    mem.trackOpenPage("/about");
    mem.trackOpenPage("/about");
    mem.untrackOpenPage("/about");
    expect(mem.openPages).toContain("/about");
  });

  it("untracking all connections for a path removes it", () => {
    mem.trackOpenPage("/about");
    mem.trackOpenPage("/about");
    mem.untrackOpenPage("/about");
    mem.untrackOpenPage("/about");
    expect(mem.openPages).not.toContain("/about");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot state: isBooting / setBootingDone
// ─────────────────────────────────────────────────────────────────────────────

describe("boot state", () => {
  it("isBooting is true on a fresh MemoryStore", () => {
    expect(mem.isBooting).toBe(true);
  });

  it("setBootingDone sets isBooting to false", () => {
    mem.setBootingDone();
    expect(mem.isBooting).toBe(false);
  });
});
