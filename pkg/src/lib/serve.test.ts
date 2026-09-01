import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mem } from "./mem.ts";
import { serveProduction } from "./serve.ts";

const { startServerMock } = vi.hoisted(() => ({
  startServerMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./server.js", () => ({
  startServer: startServerMock,
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    get BascikConfig() {
      return {
        ...actual.BascikConfig,
        directory: {
          ...actual.BascikConfig.directory,
          out: join(process.cwd(), "dist"),
        },
      };
    },
  };
});

describe("serveProduction", () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    startServerMock.mockClear();
    originalCwd = process.cwd();
    workDir = join(originalCwd, `.serve-test-${process.pid}-${Date.now()}`);
    await mkdir(join(workDir, "dist"), { recursive: true });
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws a helpful error when dist/ does not exist", async () => {
    await rm(join(workDir, "dist"), { recursive: true, force: true });
    await expect(serveProduction()).rejects.toThrow(
      /could not read .*dist\/ directory/,
    );
    await expect(serveProduction()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("warns but still serves when dist/ contains no HTML pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await serveProduction();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no HTML pages found"),
    );
    expect(startServerMock).toHaveBeenCalledOnce();
    warn.mockRestore();
    log.mockRestore();
  });

  it("loads dist pages into memory and starts the HTTP/2 server", async () => {
    await mkdir(join(workDir, "dist", "blog"));
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(join(workDir, "dist", "about.html"), "<h1>about</h1>");
    await writeFile(
      join(workDir, "dist", "blog", "post.html"),
      "<h1>post</h1>",
    );
    // Non-HTML files must be ignored
    await writeFile(join(workDir, "dist", "styles.css"), "body{}");
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await serveProduction();

    expect(startServerMock).toHaveBeenCalledOnce();

    const home = mem.getPageExact("/");
    const about = mem.getPageExact("/about");
    const post = mem.getPageExact("/blog/post");
    expect(home?.content.toString("utf8")).toBe("<h1>home</h1>");
    expect(about?.content.toString("utf8")).toBe("<h1>about</h1>");
    expect(post?.content.toString("utf8")).toBe("<h1>post</h1>");

    // dist/ pages record their path in the "pages/..." format
    expect(home?.relativePagePath).toBe("pages/index.html");
    expect(post?.relativePagePath).toBe("pages/blog/post.html");
    // No component tracking at serve time
    expect(about?.usedComponentsSet.size).toBe(0);

    expect(log).toHaveBeenCalledWith("Loaded 3 pages from dist/");
    log.mockRestore();
  });

  it("does not clean existing output when starting the production server", async () => {
    const sentinelPath = join(workDir, "dist", "keep-me.txt");
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(sentinelPath, "preserved");
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await serveProduction();

    await expect(import("node:fs/promises").then(({ readFile }) => readFile(sentinelPath, "utf8")))
      .resolves.toBe("preserved");
    log.mockRestore();
  });

  it("uses singular 'page' in the log message when exactly one page is loaded", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>only</h1>");
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await serveProduction();

    expect(log).toHaveBeenCalledWith("Loaded 1 page from dist/");
    log.mockRestore();
  });
});
