import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractCustomTags, checkProject } from "./check.ts";

const { listPagesMock, listComponentsMock } = vi.hoisted(() => ({
  listPagesMock: vi.fn(),
  listComponentsMock: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  // Spread into a fresh, writable object — the module namespace is frozen.
  return {
    BascikConfig: {
      ...original.BascikConfig,
      skipTranspilingElementContents: ["code"],
    },
  };
});

vi.mock("./file-system.js", () => ({
  listPages: listPagesMock,
  getRelativePath: (filePath: string) => filePath,
}));

vi.mock("./components.js", () => ({
  listComponents: listComponentsMock,
}));

describe("extractCustomTags", () => {
  it("extracts hyphenated tag names, lowercased", () => {
    const tags = extractCustomTags(
      '<My-Card></My-Card><site-nav /><input type="text"><br>',
    );
    expect([...tags]).toEqual(["my-card", "site-nav"]);
  });

  it("ignores non-hyphenated tags and closing-only matches", () => {
    const tags = extractCustomTags("<div><span>hi</span></div>");
    expect(tags.size).toBe(0);
  });

  it("ignores tags inside HTML comments", () => {
    const tags = extractCustomTags("<!-- <ghost-tag> --><real-tag></real-tag>");
    expect([...tags]).toEqual(["real-tag"]);
  });

  it("ignores tags inside raw-text element content", () => {
    // Script/style/textarea bodies are stripped even when they contain raw
    // markup or `<` characters (JS comparisons, demo strings, etc.).
    const html =
      '<script type="module">const s = "<demo-tag>"; if (a < b) {}</script>' +
      '<style media="all">.x { color: red; }</style>' +
      '<code class="demo">&lt;example-tag&gt;</code>';
    expect(extractCustomTags(html).size).toBe(0);
  });

  it("ignores escaped markup inside skipTranspilingElementContents (code) elements", () => {
    const html =
      '<code class="demo">use &lt;example-tag&gt; here</code><used-tag></used-tag>';
    expect([...extractCustomTags(html)]).toEqual(["used-tag"]);
  });

  it("ignores raw markup inside <code> (strip is not limited to escaped samples)", () => {
    const html =
      '<code class="demo"><example-tag></example-tag></code><used-tag></used-tag>';
    expect([...extractCustomTags(html)]).toEqual(["used-tag"]);
  });
});

describe("checkProject", () => {
  let workDir: string;
  let originalCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const setupProject = async (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(workDir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    workDir = join(originalCwd, `.check-test-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    process.chdir(workDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns true and logs success when all tags are known components", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card>",
      "components/my-card/my-card.html": "<div>card</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
    });

    await expect(checkProject()).resolves.toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("no errors"),
    );
  });

  it("returns false and reports unknown component tags as errors", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card><ghost-tag></ghost-tag>",
      "components/my-card/my-card.html": "<div>card</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
    });

    await expect(checkProject()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("<ghost-tag>"),
    );
  });

  it("warns (without failing) about unused components", async () => {
    await setupProject({
      "pages/index.html": "<my-card></my-card>",
      "components/my-card/my-card.html": "<div>card</div>",
      "components/lonely-widget/lonely-widget.html": "<div>widget</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-card": { fileName: join(workDir, "components/my-card/my-card.html") },
      "lonely-widget": {
        fileName: join(workDir, "components/lonely-widget/lonely-widget.html"),
      },
    });

    await expect(checkProject()).resolves.toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("<lonely-widget>"),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("detects component usage inside other component files", async () => {
    await setupProject({
      "pages/index.html": "<outer-comp></outer-comp>",
      "components/outer-comp/outer-comp.html": "<inner-comp></inner-comp>",
      "components/inner-comp/inner-comp.html": "<div>inner</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "outer-comp": {
        fileName: join(workDir, "components/outer-comp/outer-comp.html"),
      },
      "inner-comp": {
        fileName: join(workDir, "components/inner-comp/inner-comp.html"),
      },
    });

    await expect(checkProject()).resolves.toBe(true);
    // inner-comp is used by outer-comp — no unused warning
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("treats files with build scripts as potentially using every component", async () => {
    await setupProject({
      "pages/index.html":
        '<script data-bascik-build>console.log("x")</script>',
      "components/maybe-used/maybe-used.html": "<div>m</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "maybe-used": {
        fileName: join(workDir, "components/maybe-used/maybe-used.html"),
      },
    });

    await expect(checkProject()).resolves.toBe(true);
    // No unused warning: the build script might generate the usage
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still reports unknown tags in files that contain build scripts", async () => {
    await setupProject({
      "pages/index.html":
        '<script data-bascik-build>console.log("x")</script><ghost-tag></ghost-tag>',
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({});

    await expect(checkProject()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("<ghost-tag>"),
    );
  });

  it("skips unreadable files without failing the whole check", async () => {
    listPagesMock.mockResolvedValue([join(workDir, "pages/missing.html")]);
    listComponentsMock.mockResolvedValue({});

    await expect(checkProject()).resolves.toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses plural 'Unknown components' when multiple unknown tags appear in one file", async () => {
    await setupProject({
      "pages/index.html": "<ghost-one></ghost-one><ghost-two></ghost-two>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({});

    await expect(checkProject()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown components"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("<ghost-one>"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("<ghost-two>"));
  });

  it("uses plural 'Unused components' when multiple components are unused", async () => {
    await setupProject({
      "pages/index.html": "<p>no components used</p>",
      "components/widget-a/widget-a.html": "<div>a</div>",
      "components/widget-b/widget-b.html": "<div>b</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "widget-a": { fileName: join(workDir, "components/widget-a/widget-a.html") },
      "widget-b": { fileName: join(workDir, "components/widget-b/widget-b.html") },
    });

    await expect(checkProject()).resolves.toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unused components"),
    );
  });

  it("includes unused-count note in success log when there are unused components", async () => {
    await setupProject({
      "pages/index.html": "<my-used></my-used>",
      "components/my-used/my-used.html": "<div>used</div>",
      "components/not-used/not-used.html": "<div>not used</div>",
    });
    listPagesMock.mockResolvedValue([join(workDir, "pages/index.html")]);
    listComponentsMock.mockResolvedValue({
      "my-used": { fileName: join(workDir, "components/my-used/my-used.html") },
      "not-used": { fileName: join(workDir, "components/not-used/not-used.html") },
    });

    await expect(checkProject()).resolves.toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("unused"),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
