import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import {
  deepReadDir,
  deepReadDirFlat,
  listPages,
  getDirectoryPath,
  getDistPagePath,
  getRelativePath,
  toDistPath,
  deleteDistFile,
  deleteDistDir,
  createDir,
  copyReplicatePath,
  copyStaticAssets,
  isInlineStylesheet,
} from "./file-system.ts";
import { isStaticAssetPath } from "./asset-filter.ts";
import { BascikConfig } from "./config.ts";
import { readdir, rm, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";

const isDirMock = vi.fn().mockImplementation(() => false);

isDirMock.mockImplementationOnce(() => true);

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: {
      pages: "pages",
      components: "components",
      out: "dist",
    },
    minify: { css: false, js: false, html: false },
    logging: {
      level: "info",
      requests: true,
      copies: true,
      deletes: true,
      transpiles: true,
    },
    assets: {
      inlineStyles: false,
    },
  },
  shouldLog: (configuredLevel: string | undefined, eventLevel = "info") => {
    const levels = ["silent", "error", "warn", "info", "debug"] as const;
    return (levels.indexOf((configuredLevel ?? "info") as any) >= levels.indexOf(eventLevel as any));
  },
}));

vi.mock("./js-minifier.js", () => ({
  minifyJs: vi.fn(async (js: string) => js),
}));

vi.mock("./css-minifier.js", () => ({
  minifyCss: vi.fn((css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1").trim()),
}));

vi.mock("node:fs", () => {
  return {
    createReadStream: vi.fn((filePath: string) => {
      const stream = new EventEmitter() as EventEmitter & {
        on: EventEmitter["on"];
      };
      const content = filePath.includes("dist")
        ? "body { color: blue; }"
        : "body { color: red; }";
      queueMicrotask(() => {
        stream.emit("data", Buffer.from(content));
        stream.emit("end");
      });
      return stream;
    }),
  };
});

vi.mock("node:fs/promises", () => {
  return {
    readdir: vi.fn(async () => [
      {
        name: "./dir",
        isDirectory: isDirMock,
      },
      {
        name: "./dir/one.html",
        isDirectory: vi.fn(() => false),
      },
      {
        name: "./dir/one.css",
        isDirectory: vi.fn(() => false),
      },
    ]),
    rm: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
  };
});

vi.spyOn(console, "log");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.mocked(readdir).mockImplementation(async () => [
    {
      name: "./dir",
      isDirectory: isDirMock,
    },
    {
      name: "./dir/one.html",
      isDirectory: vi.fn(() => false),
    },
    {
      name: "./dir/one.css",
      isDirectory: vi.fn(() => false),
    },
  ] as any);
});

describe("deepReadDir", () => {
  it("Reads path", async () => {
    const paths = await deepReadDir("./");
    expect(paths).toEqual([
      ["dir/dir", "dir/dir/one.html", "dir/dir/one.css"],
      "dir/one.html",
      "dir/one.css",
    ]);
  });

  it("rejects when the configured root directory cannot be read", async () => {
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.mocked(readdir).mockRejectedValueOnce(error);

    await expect(deepReadDir("pages")).rejects.toBe(error);
  });

  it("warns and continues when a subdirectory disappears during recursion", async () => {
    const missingError = Object.assign(new Error("ENOENT: directory disappeared"), { code: "ENOENT" });
    vi.mocked(readdir).mockImplementation(async (path) => {
      if (`${path}` === "pages") {
        return [{ name: "removed", isDirectory: () => true }] as any;
      }
      throw missingError;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

    await expect(deepReadDir("pages")).resolves.toEqual([[]]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to read subdirectory %s",
      "pages/removed",
      missingError,
    );
    warnSpy.mockRestore();
  });
});

describe("deepReadDirFlat", () => {
  it("reads path and flattens array", async () => {
    const paths = await deepReadDirFlat("./");
    expect(paths ?? []).toEqual(["dir", "dir/one.html", "dir/one.css"]);
  });
});

describe("listPages", () => {
  it("uses BascikConfig.directory.pages (not a hardcoded path)", async () => {
    const paths = await listPages();
    // Paths should be rooted at the configured pages directory ("pages"),
    // not at a hardcoded relative path.
    expect(paths.every((p) => p.startsWith("pages"))).toBe(true);
    expect(paths).toEqual(["pages/dir/one.html"]);
  });
});

describe("getDirectoryPath", () => {
  it("should return directory path for given page path", () => {
    const pagePath = "/pages/myPage.html";
    const expectedDirPath = "pages";
    const result = getDirectoryPath(pagePath);
    expect(result).toEqual(expectedDirPath);
  });

  it("should handle root page path", () => {
    const pagePath = "/index.html";
    const expectedDirPath = "";
    const result = getDirectoryPath(pagePath);
    expect(result).toEqual(expectedDirPath);
  });
});

describe("getDistPagePath", () => {
  it("should return dist page path for given page path", () => {
    const pagePath = "/pages/myPage.html";
    const expectedDistPath = "dist/myPage.html";
    const result = getDistPagePath(pagePath);
    expect(result).toEqual(expectedDistPath);
  });

  it("should handle root page path", () => {
    const pagePath = "/index.html";
    const expectedDistPath = "dist/index.html";
    const result = getDistPagePath(pagePath);
    expect(result).toEqual(expectedDistPath);
  });

  it("handles Windows backslash paths", () => {
    expect(getDistPagePath("pages\\blog\\post.html")).toBe("dist/blog/post.html");
    expect(getDirectoryPath("pages\\blog\\post.html")).toBe("blog");
  });
});

describe("toDistPath", () => {
  it("getRelativePath returns the tail when the pages segment appears twice in the path", () => {
    expect(getRelativePath("/Users/x/my-pages/pages/assets/logo.png", "pages")).toBe(
      "pages/assets/logo.png",
    );
  });

  it.each([
    ["pages/x.html", "pages/x.html"],
    ["src/pages/x.html", "pages/x.html"],
    ["/p/src/pages/x.html", "pages/x.html"],
    ["C:\\p\\src\\pages\\x.html", "pages/x.html"],
    ["x.html", "pages/x.html"],
    ["/srv/pages/demo/src/pages/x.html", "pages/x.html"],
    ["pages/blog/", "pages/blog/"],
    ["pages/index/deep.html", "pages/index/deep.html"],
    ["pages/résumé #100%.html", "pages/résumé #100%.html"],
    ["pages//blog///post.html", "pages/blog/post.html"],
  ])("normalizes %s relative to the logical pages directory", (input, expected) => {
    expect(getRelativePath(input, "pages")).toBe(expected);
  });

  it("honors a custom configured pages directory", () => {
    const previousPages = BascikConfig.directory.pages;
    (BascikConfig.directory as { pages: string }).pages = "src/html";
    try {
      expect(getRelativePath("/project/src/html/blog/index.html", "pages")).toBe(
        "pages/blog/index.html",
      );
      expect(toDistPath("/project/src/html/blog/index.html")).toBe("dist/blog/index.html");
    } finally {
      (BascikConfig.directory as { pages: string }).pages = previousPages;
    }
  });

  it("maps a source inside an absolute configured pages directory", () => {
    const previousPages = BascikConfig.directory.pages;
    (BascikConfig.directory as { pages: string }).pages = "/workspace/project/src/pages";
    try {
      expect(toDistPath("/workspace/project/src/pages/blog/post.html")).toBe(
        "dist/blog/post.html",
      );
    } finally {
      (BascikConfig.directory as { pages: string }).pages = previousPages;
    }
  });

  it("resolves relative pages paths to dist paths", () => {
    expect(toDistPath("pages/about.html")).toBe("dist/about.html");
    expect(toDistPath("pages/css/styles.css")).toBe("dist/css/styles.css");
  });

  it.each([
    ["src/pages/x.html", "dist/x.html"],
    ["/srv/pages/demo/src/pages/x.html", "dist/x.html"],
    ["pages/blog/", "dist/blog/"],
    ["pages/résumé #100%.html", "dist/résumé #100%.html"],
    ["pages//blog///post.html", "dist/blog/post.html"],
  ])("maps supported source shape %s into the output directory", (input, expected) => {
    expect(toDistPath(input)).toBe(expected);
  });

  it("handles paths already starting with pages/ or components/ even when config directory differs", () => {
    expect(getRelativePath("pages/cli.html", "pages")).toBe("pages/cli.html");
    expect(getRelativePath("components/card/card.html", "components")).toBe("components/card/card.html");
  });

  it("resolves absolute pages paths to dist paths", () => {
    expect(toDistPath("/workspace/project/pages/about.html")).toBe("dist/about.html");
    expect(toDistPath("/workspace/project/pages/css/styles.css")).toBe("dist/css/styles.css");
  });

  it("does not treat an ancestor named dist as the configured output directory", () => {
    expect(toDistPath("/Users/dist/project/src/pages/blog.html")).toBe("dist/blog.html");
  });

  it("resolves Windows backslash paths to dist paths", () => {
    expect(toDistPath("pages\\css\\styles.css")).toBe("dist/css/styles.css");
    expect(toDistPath("C:\\workspace\\project\\pages\\about.html")).toBe("dist/about.html");
  });

  it("preserves paths that are already inside dist", () => {
    expect(toDistPath("dist/about.html")).toBe("dist/about.html");
    expect(toDistPath(resolve("dist/css/styles.css"))).toBe("dist/css/styles.css");
  });

  it.each([
    ["pages/../source.html"],
    ["../pages/source.html"],
    ["source.html"],
    ["/workspace/project/source.html"],
    ["C:\\workspace\\project\\source.html"],
    ["dist"],
  ])("refuses unsafe output target %s", (input) => {
    expect(() => toDistPath(input)).toThrow(/outside.*output directory/i);
  });
});

describe("deleteDistFile", () => {
  it("refuses a target outside the output directory", async () => {
    await expect(deleteDistFile("source.html")).rejects.toThrow(/outside.*output directory/i);
    expect(rm).not.toHaveBeenCalled();
  });

  it("logs relative Bascik paths for page deletions and calls rm on dist path", async () => {
    const pagePath = "/workspace/project/pages/about.html";
    await deleteDistFile(pagePath);
    expect(rm).toHaveBeenCalledWith("dist/about.html");
    expect(console.log).toHaveBeenCalledWith("deleted file: pages/about.html");
  });

  it("deletes dist files when passed Windows backslash paths", async () => {
    await deleteDistFile("pages\\about.html");
    expect(rm).toHaveBeenCalledWith("dist/about.html");
  });
});

describe("deleteDistDir", () => {
  it("refuses a target outside the output directory", async () => {
    await expect(deleteDistDir("pages")).rejects.toThrow(/outside.*output directory/i);
    expect(rm).not.toHaveBeenCalled();
  });

  it("logs relative Bascik paths for directory deletions and calls rm on dist dir", async () => {
    const dirPath = "/workspace/project/pages/assets";
    await deleteDistDir(dirPath);
    expect(rm).toHaveBeenCalledWith("dist/assets", { recursive: true, force: true });
    expect(console.log).toHaveBeenCalledWith("deleted dir: pages/assets");
  });
});

describe("copyReplicatePath", () => {
  it("logs relative Bascik paths for copied files", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("body { color: red; }" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("/workspace/project/pages/css/styles.css", "dist");

    expect(console.log).toHaveBeenCalledWith("copied:", "pages/css/styles.css");
  });
});

describe("copyStaticAssets", () => {
  it("does not copy built-in denied files from the pages directory", async () => {
    const file = (name: string) => ({
      name,
      isDirectory: vi.fn(() => false),
    });
    const directory = (name: string) => ({
      name,
      isDirectory: vi.fn(() => true),
    });
    vi.mocked(readdir).mockImplementation(async (path) => {
      if (`${path}` === "pages") {
        return [
          file(".env"),
          file("bundle.js.map"),
          file(".DS_Store"),
          file(".gitignore"),
          file("helper.mjs"),
          file("README.md"),
          file("logo.svg"),
          directory("node_modules"),
        ] as any;
      }
      if (`${path}` === "pages/node_modules") {
        return [directory("pkg")] as any;
      }
      if (`${path}` === "pages/node_modules/pkg") {
        return [file("index.js")] as any;
      }
      return [];
    });

    await copyStaticAssets();

    const copiedSources = vi.mocked(copyFile).mock.calls.map(([source]) => source);
    expect(copiedSources).toEqual(["pages/logo.svg"]);
  });

  it("applies assets.exclude relative to pages while allowing unknown extensions", () => {
    (BascikConfig as any).assets = {
      inlineStyles: false,
      exclude: ["private/**", "*.jsonc"],
    };

    try {
      expect(isStaticAssetPath("pages/templates/card.hbs", "pages")).toBe(true);
      expect(isStaticAssetPath("pages/private/card.hbs", "pages")).toBe(false);
      expect(isStaticAssetPath("pages/settings.jsonc", "pages")).toBe(false);
      expect(isStaticAssetPath("pages/public/settings.jsonc", "pages")).toBe(true);
      expect(isStaticAssetPath("pages/.hidden/allowed.svg", "pages")).toBe(false);
      expect(
        isStaticAssetPath(
          "/Users/example/.work/project/pages/logo.svg",
          "/Users/example/.work/project/pages",
        ),
      ).toBe(true);
    } finally {
      (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    }
  });

  it("copies non-HTML static assets and ignores HTML, TS, and test files", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("body { color: red; }" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyStaticAssets();

    expect(console.log).toHaveBeenCalledWith("copied:", "pages/dir/one.css");
    expect(console.log).not.toHaveBeenCalledWith("copied:", "pages/dir/one.html");
  });

  it("ignores inlined stylesheets specified in BascikConfig.assets.inlineStyles", async () => {
    (BascikConfig as any).assets = { inlineStyles: ["pages/dir/one.css"] };

    try {
      await copyStaticAssets();
      expect(console.log).not.toHaveBeenCalledWith("copied:", "pages/dir/one.css");
    } finally {
      (BascikConfig as any).assets = { inlineStyles: false };
    }
  });
});

describe("isInlineStylesheet", () => {
  it("returns false when inlineStyles is false or empty", () => {
    (BascikConfig as any).assets = { inlineStyles: false };
    expect(isInlineStylesheet("src/css/styles.css")).toBe(false);

    (BascikConfig as any).assets = { inlineStyles: [] };
    expect(isInlineStylesheet("src/css/styles.css")).toBe(false);
  });

  it("returns true when inlineStyles is boolean true and file is .css", () => {
    (BascikConfig as any).assets = { inlineStyles: true };
    expect(isInlineStylesheet("src/css/styles.css")).toBe(true);
    expect(isInlineStylesheet("src/css/main.js")).toBe(false);
    (BascikConfig as any).assets = { inlineStyles: false };
  });

  it("correctly matches relative and absolute path variants for configured inlineStyles", () => {
    (BascikConfig as any).assets = { inlineStyles: ["src/css/styles.css"] };
    expect(isInlineStylesheet("src/css/styles.css")).toBe(true);
    expect(isInlineStylesheet("/Users/project/src/css/styles.css")).toBe(true);
    expect(isInlineStylesheet("styles.css")).toBe(true);
    (BascikConfig as any).assets = { inlineStyles: false };
  });

  it("does not falsely match substring filenames like other-styles.css when configured with styles.css", () => {
    (BascikConfig as any).assets = { inlineStyles: ["styles.css"] };
    expect(isInlineStylesheet("src/css/other-styles.css")).toBe(false);
    expect(isInlineStylesheet("my-styles.css")).toBe(false);
    (BascikConfig as any).assets = { inlineStyles: false };
  });
});

describe("createDir", () => {
  it("test", async () => {
    const dirPath = '"./dir"';
    expect(await createDir(dirPath)).toBe(undefined);
  });
});

describe("copyReplicatePath – CSS minification", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
    (BascikConfig as any).minify = { css: true, js: false, html: false };
  });

  afterEach(() => {
    (BascikConfig as any).minify = { css: false, js: false, html: false };
  });

  it("writes minified CSS to dest when source and dest hashes differ", async () => {
    const rawCss = "/* comment */\n.foo {\n  color: red;\n}";
    vi.mocked(readFile)
      .mockResolvedValueOnce(rawCss as any)          // read src
      .mockRejectedValueOnce(new Error("ENOENT"));   // read dest → does not exist yet

    await copyReplicatePath("pages/css/styles.css", "dist");

    expect(writeFile).toHaveBeenCalledOnce();
    const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(writtenContent).not.toContain("/* comment */");
    expect(writtenContent).not.toContain("\n");
    expect(writtenContent).toContain(".foo");
  });

  it("skips writeFile when minified content already matches dest", async () => {
    // The mock minifyCss strips comments and collapses whitespace;
    // if the dest already contains the minified form, hashes match → no write.
    const rawCss = ".foo { color: red; }";
    const alreadyMinified = ".foo{color:red;}";
    vi.mocked(readFile)
      .mockResolvedValueOnce(rawCss as any)          // src
      .mockResolvedValueOnce(alreadyMinified as any); // dest already up to date

    await copyReplicatePath("pages/css/styles.css", "dist");

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("uses writeFile (not copyFile) for CSS files when minify.css is enabled", async () => {
    const { copyFile } = await import("node:fs/promises");
    vi.mocked(readFile)
      .mockResolvedValueOnce(".a { color: red; }" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("pages/css/styles.css", "dist");

    expect(writeFile).toHaveBeenCalledOnce();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("writes minified CSS using a custom minify function", async () => {
    (BascikConfig as any).minify = { css: async (code: string) => `/* custom */ ${code.trim()}`, js: false, html: false };
    vi.mocked(readFile)
      .mockResolvedValueOnce("  body { color: red; }  " as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("pages/css/styles.css", "dist");

    expect(writeFile).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(written).toBe("/* custom */ body { color: red; }");
  });
});

describe("copyReplicatePath – JS minification & fallback", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
    (BascikConfig as any).minify = { css: false, js: true, html: false };
  });

  afterEach(() => {
    (BascikConfig as any).minify = { css: false, js: false, html: false };
  });

  it("writes minified JS when minify.js is enabled", async () => {
    (BascikConfig as any).minify = {
      css: false,
      js: (code: string) => code.replace(/\/\/.*$/gm, "").trim(),
      html: false,
    };
    const rawJs = "const x = 1; // comment\nconsole.log(x);";
    vi.mocked(readFile)
      .mockResolvedValueOnce(rawJs as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("pages/js/app.js", "dist");

    expect(writeFile).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(written).not.toContain("// comment");
  });

  it("logs a failure message to console and throws an exception when JS minification throws an error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    (BascikConfig as any).minify = {
      css: false,
      js: () => { throw new Error("JS Syntax Error"); },
      html: false,
    };

    vi.mocked(readFile)
      .mockResolvedValueOnce("const bad = ;" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await expect(copyReplicatePath("pages/js/bad.js", "dist")).rejects.toThrow("JS Syntax Error");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("JS minification failed"),
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});

describe("getRelativePath — Windows separators", () => {
  it("matches when the configured directory uses backslashes", async () => {
    const original = BascikConfig.directory.pages;
    (BascikConfig.directory as any).pages = "C:\\proj\\src\\pages";
    try {
      expect(getRelativePath("C:/proj/src/pages/404.html", "pages")).toBe(
        "pages/404.html",
      );
    } finally {
      (BascikConfig.directory as any).pages = original;
    }
  });
});

describe("getRelativePath – additional branches", () => {
  it("uses components directory when parentDir is 'components'", () => {
    expect(getRelativePath("components/ui/button.html", "components")).toBe(
      "components/ui/button.html",
    );
  });

  it("returns parentDir-prefixed path when no prefix matches", () => {
    // path has no pages/ segment at all → else branch in the ternary
    expect(getRelativePath("about.html", "pages")).toBe("pages/about.html");
  });
});

describe("deepReadDir – error path", () => {
  it("propagates a configured root read failure", async () => {
    const error = new Error("EACCES");
    vi.mocked(readdir).mockRejectedValueOnce(error);

    await expect(deepReadDir("./secret")).rejects.toBe(error);
  });
});

describe("deleteDistFile – error handling", () => {
  it("silently swallows ENOENT", async () => {
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    vi.spyOn(console, "error").mockImplementation(() => { });
    await deleteDistFile("pages/missing.html");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs non-ENOENT errors", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    vi.mocked(rm).mockRejectedValueOnce(err);
    vi.spyOn(console, "error").mockImplementation(() => { });
    await deleteDistFile("pages/missing.html");
    expect(console.error).toHaveBeenCalledWith("Error Deleting Dist File", err);
  });

  it("does not log when deletes logging is disabled", async () => {
    (BascikConfig.logging as any).deletes = false;
    try {
      await deleteDistFile("pages/about.html");
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      (BascikConfig.logging as any).deletes = true;
    }
  });
});

describe("deleteDistFile – displayRelativePath branches", () => {
  it("displays path as-is when it starts with pagesDir/ (no leading segment)", async () => {
    await deleteDistFile("pages/styles.css");
    expect(console.log).toHaveBeenCalledWith("deleted file: pages/styles.css");
  });

  it("displays components-relative path when path includes /componentsDir/", async () => {
    await deleteDistFile("/project/components/btn.html");
    expect(console.log).toHaveBeenCalledWith("deleted file: components/btn.html");
  });

  it("displays components-relative path when path starts with componentsDir/", async () => {
    await deleteDistFile("components/btn.html");
    expect(console.log).toHaveBeenCalledWith("deleted file: components/btn.html");
  });

  it("strips dist/ prefix for paths that fall through to the final fallback", async () => {
    await deleteDistFile("dist/index.html");
    expect(console.log).toHaveBeenCalledWith("deleted file: index.html");
  });
});

describe("deleteDistDir – error handling", () => {
  it("silently swallows ENOENT", async () => {
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    vi.spyOn(console, "error").mockImplementation(() => { });
    await deleteDistDir("pages/assets");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs non-ENOENT errors", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    vi.mocked(rm).mockRejectedValueOnce(err);
    vi.spyOn(console, "error").mockImplementation(() => { });
    await deleteDistDir("pages/assets");
    expect(console.error).toHaveBeenCalledWith("Error Deleting Dist Directory", err);
  });
});

describe("createDir – error path", () => {
  it("logs error when mkdir rejects", async () => {
    const err = new Error("EPERM");
    vi.mocked(mkdir).mockRejectedValueOnce(err as any);
    vi.spyOn(console, "error").mockImplementation(() => { });
    await createDir("./bad-path");
    expect(console.error).toHaveBeenCalledWith("Error Creating Dist Directory", err);
  });
});

describe("copyReplicatePath – JS minification", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
  });

  afterEach(() => {
    (BascikConfig as any).minify = { css: false, js: false, html: false };
  });

  it("writes minified JS using a custom minify function", async () => {
    (BascikConfig as any).minify = { css: false, js: async (code: string) => code.replace(/\s+/g, ""), html: false };
    vi.mocked(readFile)
      .mockResolvedValueOnce("const x = 1 ;" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("pages/js/app.js", "dist");

    expect(writeFile).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(written).toBe("constx=1;");
  });

  it("skips write when minified JS already matches dest", async () => {
    (BascikConfig as any).minify = { css: false, js: async (code: string) => code.trim(), html: false };
    const content = "const x = 1;";
    vi.mocked(readFile)
      .mockResolvedValueOnce(content as any)
      .mockResolvedValueOnce(content as any);

    await copyReplicatePath("pages/js/app.js", "dist");

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("logs a failure message to console and throws an exception when JS minification throws an error (default onMinifyError: 'error')", async () => {
    (BascikConfig as any).minify = { css: false, js: async () => { throw new Error("JS syntax error"); }, html: false };
    vi.mocked(readFile).mockResolvedValueOnce("invalid js {{{" as any);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(copyReplicatePath("pages/js/app.js", "dist")).rejects.toThrow("JS syntax error");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("JS minification failed"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("logs a warning and falls back to unminified copy when onMinifyError is set to 'warn'", async () => {
    (BascikConfig as any).onMinifyError = "warn";
    (BascikConfig as any).minify = { css: false, js: async () => { throw new Error("JS syntax error"); }, html: false };
    vi.mocked(readFile).mockResolvedValue("const bad = ;" as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

    await copyReplicatePath("pages/js/app.js", "dist");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("JS minification failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
    (BascikConfig as any).onMinifyError = "error";
  });

  it("calls minifyJs when minify.js is true", async () => {
    (BascikConfig as any).minify = { css: false, js: true, html: false };
    vi.mocked(readFile)
      .mockResolvedValueOnce("const x = 1;" as any)
      .mockRejectedValueOnce(new Error("ENOENT"));

    await copyReplicatePath("pages/js/app.js", "dist");

    const { minifyJs } = await import("./js-minifier.ts");
    expect(vi.mocked(minifyJs)).toHaveBeenCalledWith("const x = 1;");
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

describe("copyReplicatePath – generic error path", () => {
  it("logs error and throws when copyFile rejects", async () => {
    const err = new Error("Disk full");
    vi.mocked(copyFile).mockRejectedValueOnce(err);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(copyReplicatePath("pages/image.png", "dist")).rejects.toThrow("Disk full");

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to copy file:",
      expect.any(String),
      err,
    );
    errorSpy.mockRestore();
  });
});
