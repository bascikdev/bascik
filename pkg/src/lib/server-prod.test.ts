import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mem } from "./mem.ts";
import { startProdServer } from "./server-prod.ts";

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

describe("startProdServer", () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    startServerMock.mockClear();
    originalCwd = process.cwd();
    workDir = join(originalCwd, `.server-prod-test-${process.pid}-${Date.now()}`);
    await mkdir(join(workDir, "dist"), { recursive: true });
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws a helpful error when dist/ does not exist", async () => {
    await rm(join(workDir, "dist"), { recursive: true, force: true });
    await expect(startProdServer()).rejects.toThrow(
      /could not read .*dist\/ directory/,
    );
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("warns but still serves when dist/ contains no HTML pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await startProdServer();

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

    await startProdServer();

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

    await startProdServer();

    await expect(import("node:fs/promises").then(({ readFile }) => readFile(sentinelPath, "utf8")))
      .resolves.toBe("preserved");
    log.mockRestore();
  });

  it("uses singular 'page' in the log message when exactly one page is loaded", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>only</h1>");
    const log = vi.spyOn(console, "log").mockImplementation(() => { });

    await startProdServer();

    expect(log).toHaveBeenCalledWith("Loaded 1 page from dist/");
    log.mockRestore();
  });

  it("fails startup with an actionable diagnostic when the sidecar is malformed", async () => {
    await mkdir(join(workDir, "dist", ".bascik"), { recursive: true });
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(
      join(workDir, "dist", ".bascik", "server-scripts.json"),
      "{corrupt",
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(startProdServer()).rejects.toThrow(/Failed to load server scripts sidecar/);
    // A required runtime artifact that cannot be parsed must never bind.
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup when a present sidecar cannot resolve a placeholder reference", async () => {
    await mkdir(join(workDir, "dist", ".bascik"), { recursive: true });
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(workDir, "dist", "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
    );
    // A present but entry-less sidecar means no script can back the placeholder.
    await writeFile(
      join(workDir, "dist", ".bascik", "server-scripts.json"),
      JSON.stringify({ version: "1", schema: 2, scripts: {} }),
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(startProdServer()).rejects.toThrow(/production startup validation failed/);
    await expect(startProdServer()).rejects.toThrow(/unresolvable or stale server-script placeholder/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup when a placeholder page has no sidecar at all", async () => {
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(
      join(workDir, "dist", "index.html"),
      '<script type="text/bascik-server" data-bascik-server-id="missing"></script>',
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(startProdServer()).rejects.toThrow(/production startup validation failed/);
    await expect(startProdServer()).rejects.toThrow(/sidecar .*is missing/);
    await expect(startProdServer()).rejects.toThrow(/bascik --build/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails startup on an incompatible sidecar schema", async () => {
    await mkdir(join(workDir, "dist", ".bascik"), { recursive: true });
    await writeFile(join(workDir, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(
      join(workDir, "dist", ".bascik", "server-scripts.json"),
      JSON.stringify({ version: "1", schema: 99, scripts: {} }),
      "utf8",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(startProdServer()).rejects.toThrow(/schema 99/);
    expect(startServerMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("still serves a genuinely static release with no sidecar", async () => {
    await writeFile(join(workDir, "dist", "index.html"), "<h1>static</h1>");
    const log = vi.spyOn(console, "log").mockImplementation(() => { });
    const error = vi.spyOn(console, "error").mockImplementation(() => { });

    await startProdServer();

    expect(startServerMock).toHaveBeenCalledOnce();
    // No sidecar exists, but the release is static and stays valid.
    expect(mem.getPageExact("/")?.content.toString("utf8")).toBe("<h1>static</h1>");
    log.mockRestore();
    error.mockRestore();
  });
});
