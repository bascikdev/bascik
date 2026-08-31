import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import {
  executeBuildScripts,
  extractScriptDeps,
  collectAllScriptDeps,
  cleanStackTrace,
  SCRIPT_CACHE_VERSION,
  clearBuildScriptCaches,
} from "./build-scripts.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => { }),
  unlink: vi.fn(async () => { }),
  mkdir: vi.fn(async () => { }),
  // readFile: cache reads + dep-file reads always miss in tests (no disk state).
  readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    isBuild: false,
    buildScriptCache: true,
    directory: { pages: "src/pages", components: "src/components" },
  },
}));

import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { BascikConfig } from "./config.ts";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Helper: make execFile resolve with given stdout
// Signature: execFile(cmd, args, opts, cb) where cb = (err, stdout, stderr)
const resolveWith = (stdout: string) =>
  mockExecFile.mockImplementation(
    (
      _cmd: unknown,
      _args: unknown,
      _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, stdout, "");
    },
  );

const rejectWith = (message: string) =>
  mockExecFile.mockImplementation(
    (
      _cmd: unknown,
      _args: unknown,
      _opts: unknown,
      cb: (err: Error) => void,
    ) => {
      cb(new Error(message));
    },
  );

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearBuildScriptCaches();
});

describe("executeBuildScripts", () => {
  it("returns html unchanged when there are no data-bascik-build scripts", async () => {
    const html = "<p>no build scripts here</p>";
    const result = await executeBuildScripts(html);
    expect(result).toBe(html);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("replaces a data-bascik-build script tag with script stdout", async () => {
    resolveWith("<h1>Generated heading</h1>\n");
    const html =
      "<header><script data-bascik-build>console.log('<h1>Generated heading</h1>');</script></header>";
    const result = await executeBuildScripts(html);
    expect(result).toContain("<h1>Generated heading</h1>");
    expect(result).not.toContain("data-bascik-build");
    expect(result).toContain("<header>");
  });

  it("writes the script content to a temp .mjs file", async () => {
    resolveWith("");
    const scriptContent = "console.log('hi');";
    await executeBuildScripts(
      `<script data-bascik-build>${scriptContent}</script>`,
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.mjs$/),
      scriptContent,
      "utf8",
    );
  });

  it("writes temp scripts inside the project tree so ESM can resolve node_modules", async () => {
    resolveWith("");
    await executeBuildScripts("<script data-bascik-build>x</script>");
    const [tmpPath] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tmpPath).toMatch(process.cwd());
    expect(tmpPath).not.toMatch(/^\/tmp\//);
    expect(tmpPath).not.toMatch(/os\.tmpdir|bascik-build-scripts/);
  });

  it("appends //# sourceURL comment to temp script when filePath is provided", async () => {
    resolveWith("");
    await executeBuildScripts("<script data-bascik-build>x()</script>", "src/pages/index.html");
    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain("//# sourceURL=src/pages/index.html");
  });

  it("removes the temp file after execution", async () => {
    resolveWith("output");
    await executeBuildScripts("<script data-bascik-build>x</script>");
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("replaces the script tag with empty string on execution error when onScriptError is 'warn'", async () => {
    (BascikConfig as any).onScriptError = "warn";
    rejectWith("syntax error");
    const html =
      "<p>before</p><script data-bascik-build>bad code</script><p>after</p>";
    const result = await executeBuildScripts(html);
    expect(result).toContain("<p>before</p>");
    expect(result).toContain("<p>after</p>");
    expect(result).not.toContain("data-bascik-build");
    (BascikConfig as any).onScriptError = undefined;
  });

  it("still removes the temp file when execution fails", async () => {
    (BascikConfig as any).onScriptError = "warn";
    rejectWith("error");
    await executeBuildScripts("<script data-bascik-build>bad</script>");
    expect(unlink).toHaveBeenCalledTimes(1);
    (BascikConfig as any).onScriptError = undefined;
  });

  it("processes multiple build scripts in order", async () => {
    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<p>first</p>" },
        { id: 1, ok: true, stdout: "<p>second</p>" },
      ]),
    );

    const html =
      "<script data-bascik-build>a</script><script data-bascik-build>b</script>";
    const result = await executeBuildScripts(html);
    expect(result).toContain("<p>first</p>");
    expect(result).toContain("<p>second</p>");
  });

  it("substitutes script output in place within a container element", async () => {
    resolveWith("<li>item-1</li><li>item-2</li>");
    const html = "<ul><script data-bascik-build>makeList()</script></ul>";
    const result = await executeBuildScripts(html);
    // Output should be inside <ul>, not after </ul>
    expect(result).toBe("<ul><li>item-1</li><li>item-2</li></ul>");
    expect(result).not.toMatch(/<\/ul>.*<li>/s);
  });

  it("substitutes script output in place within a deeply nested container", async () => {
    resolveWith("<p>Generated</p>");
    const html =
      '<aside class="sidebar"><nav><script data-bascik-build>gen()</script></nav></aside>';
    const result = await executeBuildScripts(html);
    expect(result).toBe('<aside class="sidebar"><nav><p>Generated</p></nav></aside>');
  });

  it("passes BASCIK_BUILD=0 to child process env when not in build mode", async () => {
    resolveWith("");
    (BascikConfig as { isBuild: boolean }).isBuild = false;
    await executeBuildScripts("<script data-bascik-build>x</script>");
    const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.BASCIK_BUILD).toBe("0");
  });

  it("passes BASCIK_BUILD=1 to child process env when in build mode", async () => {
    resolveWith("");
    (BascikConfig as { isBuild: boolean }).isBuild = true;
    await executeBuildScripts("<script data-bascik-build>x</script>");
    const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.BASCIK_BUILD).toBe("1");
  });

  it("passes page-context env vars to child process", async () => {
    resolveWith("");
    await executeBuildScripts(
      "<script data-bascik-build>x</script>",
      "/abs/project/src/pages/guides/intro.html",
    );
    const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.BASCIK_PAGE_FILE).toBe("/abs/project/src/pages/guides/intro.html");
    expect(opts.env?.BASCIK_SITE_URL).toBe("");
    expect(opts.env?.BASCIK_PAGES_DIR).toBe(`${process.cwd()}/src/pages`);
  });

  it("passes a timeout to execFile so hung scripts don't hang the build", async () => {
    resolveWith("");
    await executeBuildScripts("<script data-bascik-build>x</script>");
    const opts = mockExecFile.mock.calls[0][2] as {
      timeout?: number;
      killSignal?: string;
    };
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.killSignal).toBeTruthy();
  });

  it("handles a timeout kill gracefully: warns and removes the tag when onScriptError is 'warn'", async () => {
    (BascikConfig as any).onScriptError = "warn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockExecFile.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error & { killed?: boolean; signal?: string }) => void,
      ) => {
        // Simulate what execFile does on timeout: callback with a killed error
        cb(Object.assign(new Error("Command timed out"), {
          killed: true,
          signal: "SIGTERM",
        }));
      },
    );
    const html =
      "<p>before</p><script data-bascik-build>while(true){}</script><p>after</p>";
    const result = await executeBuildScripts(html);
    expect(result).toContain("<p>before</p>");
    expect(result).toContain("<p>after</p>");
    expect(result).not.toContain("data-bascik-build");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    (BascikConfig as any).onScriptError = undefined;
  });

  it("matches a script tag when an attribute value contains `>`", async () => {
    resolveWith("<p>generated</p>");
    const html =
      '<script data-bascik-build data-x="a>b">gen()</script>';
    const result = await executeBuildScripts(html);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(result).toBe("<p>generated</p>");
  });

  it("does NOT execute when data-bascik-build only appears inside an attribute value", async () => {
    const html =
      '<script data-desc="data-bascik-build">console.log("hi")</script>';
    const result = await executeBuildScripts(html);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result).toBe(html);
  });

  it("does NOT execute when data-bascik-build appears inside a single-quoted attribute value", async () => {
    const html =
      "<script data-desc='data-bascik-build'>console.log('hi')</script>";
    const result = await executeBuildScripts(html);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result).toBe(html);
  });

  it("replaces two identical build-script blocks each with their own output", async () => {
    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<p>first</p>" },
        { id: 1, ok: true, stdout: "<p>second</p>" },
      ]),
    );

    const tag = "<script data-bascik-build>same()</script>";
    const result = await executeBuildScripts(`<div>${tag}</div><div>${tag}</div>`);
    expect(result).toBe("<div><p>first</p></div><div><p>second</p></div>");
  });

  it("handles `$` patterns in output safely with index splicing", async () => {
    resolveWith("price: $& and $1");
    const html = "<script data-bascik-build>x</script>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("price: $& and $1");
  });

  it("strips ANSI color escape codes from script stdout before injecting HTML", async () => {
    resolveWith("\u001B[33m2026\u001B[39m Built with Bascik");
    const html = "<span>&copy; <script data-bascik-build>console.log(1)</script></span>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("<span>&copy; 2026 Built with Bascik</span>");
  });

  it("forwards stderr output to process.stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, "<p>out</p>", "warning: something unusual");
      },
    );
    await executeBuildScripts("<script data-bascik-build>x</script>");
    expect(stderrSpy).toHaveBeenCalledWith("warning: something unusual");
    stderrSpy.mockRestore();
  });

  it("includes file path and line/column in the error message when filePath is provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    rejectWith("syntax error");
    const html =
      '<p>first</p>\n<script data-bascik-build>bad()</script>';
    await expect(executeBuildScripts(html, "src/pages/test-page.html")).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-page.html"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("line"),
    );
    errorSpy.mockRestore();
  });

  it("throws when both data-bascik-build and data-bascik-server are on the same tag", async () => {
    const html = "<script data-bascik-build data-bascik-server>x</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(
      /both data-bascik-build and data-bascik-server/,
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("throws for both-attribute conflict regardless of attribute order", async () => {
    const html = "<script data-bascik-server data-bascik-build>x</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(
      /both data-bascik-build and data-bascik-server/,
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("includes file and line number in the both-attributes error", async () => {
    const html = '<p>intro</p>\n<script data-bascik-build data-bascik-server>x</script>';
    await expect(
      executeBuildScripts(html, "src/pages/my-page.html"),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.stringMatching(/my-page\.html.*line 2/) }),
    );
  });

  it("does not treat quoted data-bascik-server text as a conflicting attribute", async () => {
    resolveWith("<p>ok</p>");
    const html = '<script data-note="data-bascik-server" data-bascik-build>x</script>';
    const result = await executeBuildScripts(html);
    expect(result).toBe("<p>ok</p>");
  });

  it("respects onScriptError: halt", async () => {
    (BascikConfig as any).onScriptError = "halt";
    rejectWith("failed script execution");
    const html = "<script data-bascik-build>bad()</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(/build script error/);
    (BascikConfig as any).onScriptError = undefined;
  });

  it("respects onScriptError: warn", async () => {
    (BascikConfig as any).onScriptError = "warn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-build>bad()</script>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    (BascikConfig as any).onScriptError = undefined;
  });

  it("reads script content from src file when script tag body is empty", async () => {
    mockReadFile.mockResolvedValueOnce('console.log("<h1>External Build Header</h1>");');
    resolveWith("<h1>External Build Header</h1>");

    const html = '<script data-bascik-build src="helper.ts"></script>';
    const result = await executeBuildScripts(html, "src/components/my-comp.html");

    expect(mockReadFile).toHaveBeenCalled();
    expect(result).toBe("<h1>External Build Header</h1>");
  });

  it("respects onScriptError: error", async () => {
    (BascikConfig as any).onScriptError = "error";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-build>bad()</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(/build script error/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    (BascikConfig as any).onScriptError = undefined;
  });

  it("formats the error messages cleanly, removing command failure and node internals", async () => {
    (BascikConfig as any).onScriptError = "error";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    mockExecFile.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: Error) => void,
      ) => {
        const err = new Error("Command failed: node ...\nnode:internal/modules/esm/resolve:271\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\nError [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist'");
        cb(err);
      },
    );

    const html = "<script data-bascik-build>import './does-not-exist'</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(/Error \[ERR_MODULE_NOT_FOUND\]/);
    await expect(executeBuildScripts(html)).rejects.not.toThrow(/Command failed/);
    await expect(executeBuildScripts(html)).rejects.not.toThrow(/node:internal/);

    expect(errorSpy).toHaveBeenCalled();
    const errorLog = errorSpy.mock.calls[0][0];
    expect(errorLog).toContain("Error [ERR_MODULE_NOT_FOUND]");
    expect(errorLog).not.toContain("Command failed");
    expect(errorLog).not.toContain("node:internal");

    errorSpy.mockRestore();
    (BascikConfig as any).onScriptError = undefined;
  });
});

// ─── extractScriptDeps ───────────────────────────────────────────────────────

describe("extractScriptDeps", () => {
  it("returns an empty array for a script with no recognizable file references", () => {
    expect(extractScriptDeps("console.log('hello world')")).toEqual([]);
  });

  it("extracts a ./content/*.md reference in single quotes", () => {
    const script = "const { renderMd } = await import(r); console.log(await renderMd('./content/foo.md'));";
    expect(extractScriptDeps(script)).toContain("./content/foo.md");
  });

  it("extracts a scripts/*.mjs reference without a leading ./", () => {
    const script = "pathToFileURL(join(cwd, 'scripts/md-renderer.mjs')).href";
    expect(extractScriptDeps(script)).toContain("scripts/md-renderer.mjs");
  });

  it("extracts references in double quotes", () => {
    expect(extractScriptDeps(`renderMd("./content/bar.md")`)).toContain("./content/bar.md");
  });

  it("deduplicates identical references", () => {
    const script = "renderMd('./content/dup.md'); renderMd('./content/dup.md')";
    const deps = extractScriptDeps(script);
    expect(deps.filter(d => d === "./content/dup.md")).toHaveLength(1);
  });

  it("extracts multiple distinct references from the same script", () => {
    const script = `
      const { renderMd } = await import(pathToFileURL(join(cwd, 'scripts/md-renderer.mjs')).href);
      console.log(await renderMd('./content/intro.md'));
    `;
    const deps = extractScriptDeps(script);
    expect(deps).toContain("scripts/md-renderer.mjs");
    expect(deps).toContain("./content/intro.md");
  });

  it("extracts non-content/scripts paths like json, yaml, ts, and css files in other directories", () => {
    const script = `
      import data from './data/items.json';
      import config from '../shared/config.yaml';
      import utils from 'src/utils/helpers.ts';
    `;
    const deps = extractScriptDeps(script);
    expect(deps).toContain("./data/items.json");
    expect(deps).toContain("../shared/config.yaml");
    expect(deps).toContain("src/utils/helpers.ts");
  });

  it("resolves relative dependencies when baseDir is a subfolder", () => {
    const fileContent = "import { NAV } from './nav.ts';";
    const baseDir = resolve(process.cwd(), "docs/scripts");
    const deps = extractScriptDeps(fileContent, baseDir);
    expect(deps).toContain("docs/scripts/nav.ts");
  });
});

// ─── collectAllScriptDeps ───────────────────────────────────────────────────

describe("collectAllScriptDeps", () => {
  it("returns an empty array when html has no build scripts", async () => {
    const deps = await collectAllScriptDeps("<div>Hello world</div>");
    expect(deps).toEqual([]);
  });

  it("collects file dependencies from <script data-bascik-build> tags in html", async () => {
    const html = `
      <script data-bascik-build>
        import { renderMd } from './scripts/md-renderer.ts';
        console.log(await renderMd('./content/cli.md'));
      </script>
    `;
    const deps = await collectAllScriptDeps(html);
    expect(deps).toContain("scripts/md-renderer.ts");
    expect(deps).toContain("content/cli.md");
  });
});

// ─── script output cache ─────────────────────────────────────────────────────

const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>;

describe("build-script output cache", () => {
  it("writes a .json cache entry after a successful script execution", async () => {
    resolveWith("<p>result</p>");
    await executeBuildScripts("<script data-bascik-build>nodeps()</script>");
    const jsonCall = mockWriteFile.mock.calls.find(
      ([path]) => String(path).endsWith(".json"),
    );
    expect(jsonCall).toBeDefined();
    const [, content] = jsonCall as [string, string];
    const entry = JSON.parse(content);
    expect(entry.output).toBe("<p>result</p>");
    expect(entry.v).toBeGreaterThan(0);
  });

  it("does not write a cache entry when the script fails", async () => {
    (BascikConfig as any).onScriptError = "warn";
    rejectWith("syntax error");
    await executeBuildScripts("<script data-bascik-build>bad()</script>");
    const jsonCall = mockWriteFile.mock.calls.find(
      ([path]) => String(path).endsWith(".json"),
    );
    expect(jsonCall).toBeUndefined();
    (BascikConfig as any).onScriptError = undefined;
  });

  it("returns cached output and skips execFile on a cache hit", async () => {
    // Return a valid cache entry on the first readFile call (the cache-file read).
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ v: SCRIPT_CACHE_VERSION, output: "<p>from-cache</p>" }),
    );
    const result = await executeBuildScripts(
      "<script data-bascik-build>nodeps()</script>",
    );
    expect(result).toBe("<p>from-cache</p>");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("ignores a cache entry whose version does not match", async () => {
    resolveWith("<p>fresh</p>");
    // Stale version — should be treated as a miss.
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ v: 0, output: "<p>stale</p>" }),
    );
    const result = await executeBuildScripts(
      "<script data-bascik-build>nodeps()</script>",
    );
    expect(result).toBe("<p>fresh</p>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("treats malformed cache JSON as a miss and runs the script normally", async () => {
    resolveWith("<p>fresh</p>");
    mockReadFile.mockResolvedValueOnce("not valid json{{{");
    const result = await executeBuildScripts(
      "<script data-bascik-build>nodeps()</script>",
    );
    expect(result).toBe("<p>fresh</p>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("two scripts with identical content produce the same cache key and share cached output", async () => {
    // First call: cache miss — execFile runs and writes the cache.
    resolveWith("<p>executed</p>");
    const tag = "<script data-bascik-build>nodeps()</script>";
    const result1 = await executeBuildScripts(tag);
    expect(result1).toBe("<p>executed</p>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Second call with the same script: mock a cache hit (same key, same file).
    mockExecFile.mockClear();
    mockReadFile.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ v: SCRIPT_CACHE_VERSION, output: "<p>executed</p>" }),
    );
    const result2 = await executeBuildScripts(tag);
    expect(result2).toBe("<p>executed</p>");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("different filePath produces a different cache key so page-specific scripts (canonical, OG) are not reused across pages", async () => {
    resolveWith("<link rel='canonical' href='/a'>");
    // Same script content, different filePath — must produce different keys,
    // so execFile is called for both rather than the second page hitting the first page's cached canonical URL.
    mockReadFile
      .mockRejectedValue(new Error("ENOENT")); // always cache miss

    await executeBuildScripts(
      "<script data-bascik-build>canonical()</script>",
      "src/pages/page-a.html",
    );
    mockExecFile.mockClear();
    mockReadFile.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    resolveWith("<link rel='canonical' href='/b'>");

    await executeBuildScripts(
      "<script data-bascik-build>canonical()</script>",
      "src/pages/page-b.html",
    );
    // Both pages must have spawned their own child process.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // And the cache write path for both must use a .json file (different keys, so two distinct writes).
    const jsonWrites = mockWriteFile.mock.calls.filter(([p]) => String(p).endsWith(".json"));
    expect(jsonWrites.length).toBe(1);
  });

  it("invalidates cache when a transitively imported dependency file changes", async () => {
    // Mock readFile behavior for script cache misses and transitive dependency reads:
    // When reading script-cache json -> return ENOENT (cache miss)
    // When reading docs/scripts/render-nav.ts -> returns import statement referencing ./nav.ts
    // When reading docs/scripts/nav.ts -> returns version 1 or version 2
    let navVersion = "v1";
    mockReadFile.mockImplementation((path: string) => {
      const p = String(path);
      if (p.includes(".cache")) return Promise.reject(new Error("ENOENT"));
      if (p.includes("render-nav.ts")) return Promise.resolve("import { NAV } from './nav.ts';");
      if (p.includes("nav.ts")) return Promise.resolve(`export const NAV = '${navVersion}';`);
      return Promise.reject(new Error("ENOENT"));
    });

    resolveWith("<p>rendered-v1</p>");
    const script = "<script data-bascik-build>import 'docs/scripts/render-nav.ts'</script>";

    await executeBuildScripts(script, "src/pages/test.html");

    const jsonWrite1 = mockWriteFile.mock.calls.find(([p]) => String(p).endsWith(".json"));
    expect(jsonWrite1).toBeDefined();
    const cacheKey1 = jsonWrite1![0];

    // Change transitive dependency nav.ts
    navVersion = "v2";
    clearBuildScriptCaches("docs/scripts/nav.ts");
    mockExecFile.mockClear();
    mockWriteFile.mockClear();
    resolveWith("<p>rendered-v2</p>");

    await executeBuildScripts(script, "src/pages/test.html");

    const jsonWrite2 = mockWriteFile.mock.calls.find(([p]) => String(p).endsWith(".json"));
    expect(jsonWrite2).toBeDefined();
    const cacheKey2 = jsonWrite2![0];

    // Cache keys MUST be different when transitive dependency changed
    expect(cacheKey1).not.toEqual(cacheKey2);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("skips cache reads and writes entirely when buildScriptCache is false", async () => {
    (BascikConfig as Record<string, unknown>).buildScriptCache = false;
    resolveWith("<p>no-cache</p>");
    const result = await executeBuildScripts(
      "<script data-bascik-build>nodeps()</script>",
    );
    expect(result).toBe("<p>no-cache</p>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const jsonWrites = mockWriteFile.mock.calls.filter(([p]) => String(p).endsWith(".json"));
    expect(jsonWrites.length).toBe(0);
    (BascikConfig as Record<string, unknown>).buildScriptCache = true;
  });

  it("handles batch execution when one script fails and onScriptError is 'warn'", async () => {
    (BascikConfig as any).onScriptError = "warn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<span>Success</span>" },
        { id: 1, ok: false, error: "ReferenceError: foo is not defined" },
      ]),
    );

    const html =
      "<div><script data-bascik-build>good()</script><script data-bascik-build>bad()</script></div>";
    const result = await executeBuildScripts(html);

    expect(result).toBe("<div><span>Success</span></div>");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    (BascikConfig as any).onScriptError = undefined;
  });

  it("throws and identifies the failed script in a batch when onScriptError is 'error'", async () => {
    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<span>Success</span>" },
        { id: 1, ok: false, error: "SyntaxError: Unexpected token" },
      ]),
    );

    const html =
      "<div><script data-bascik-build>good()</script><script data-bascik-build>bad()</script></div>";
    await expect(executeBuildScripts(html)).rejects.toThrow(/build script error/);
  });

  it("forwards stderr per script in a batch execution", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<p>ok</p>", stderr: "warning from script 0\n" },
        { id: 1, ok: true, stdout: "<p>ok2</p>", stderr: "warning from script 1\n" },
      ]),
    );

    const html =
      "<script data-bascik-build>a()</script><script data-bascik-build>b()</script>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("<p>ok</p><p>ok2</p>");
    expect(stderrSpy).toHaveBeenCalledWith("warning from script 0\n");
    expect(stderrSpy).toHaveBeenCalledWith("warning from script 1\n");
    stderrSpy.mockRestore();
  });

  it("handles mixed cached and uncached scripts on the same page", async () => {
    let callCount = 0;
    const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith(".json") && ++callCount === 1) {
        // Only return cached output for first key
        return JSON.stringify({ v: SCRIPT_CACHE_VERSION, output: "<p>cached-1</p>" });
      }
      throw new Error("ENOENT");
    });

    resolveWith(
      JSON.stringify([
        { id: 0, ok: true, stdout: "<p>batch-2</p>" },
        { id: 1, ok: true, stdout: "<p>batch-3</p>" },
      ]),
    );

    const html =
      "<script data-bascik-build>c1()</script><script data-bascik-build>u2()</script><script data-bascik-build>u3()</script>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("<p>cached-1</p><p>batch-2</p><p>batch-3</p>");
    // Only 1 batch call for the 2 uncached scripts
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("different route params produce a different cache key so generated pages are not reused", async () => {
    resolveWith("<p>page-1</p>");
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // always cache miss

    const template = "<script data-bascik-build>makeArticle()</script>";
    const templatePath = "src/pages/blog/[slug].html";

    await executeBuildScripts(template, templatePath, {
      params: { slug: "post-1" },
    });

    const jsonWrite1 = mockWriteFile.mock.calls.find(([p]) => String(p).endsWith(".json"));
    expect(jsonWrite1).toBeDefined();
    const cacheKey1 = jsonWrite1![0];

    mockExecFile.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    resolveWith("<p>page-2</p>");

    await executeBuildScripts(template, templatePath, {
      params: { slug: "post-2" },
    });

    const jsonWrite2 = mockWriteFile.mock.calls.find(([p]) => String(p).endsWith(".json"));
    expect(jsonWrite2).toBeDefined();
    const cacheKey2 = jsonWrite2![0];

    expect(cacheKey1).not.toEqual(cacheKey2);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("passes BASCIK_ROUTE to child process when route is provided and omits it for ordinary pages", async () => {
    resolveWith("");
    const template = "<script data-bascik-build>x()</script>";
    const route = { params: { slug: "hello" }, data: { title: "Hello World" } };

    await executeBuildScripts(template, "src/pages/blog/[slug].html", route);
    const optsWithRoute = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(optsWithRoute.env?.BASCIK_ROUTE).toBe(JSON.stringify(route));

    mockExecFile.mockClear();
    await executeBuildScripts(template, "src/pages/index.html");
    const optsWithoutRoute = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(optsWithoutRoute.env?.BASCIK_ROUTE).toBeUndefined();
  });
});

// ─── cleanStackTrace ─────────────────────────────────────────────────────────

describe("cleanStackTrace", () => {
  it("replaces temporary file path and maps line numbers using lineOffset", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-123.mjs";
    const realPath = "src/pages/index.html";
    const lineOffset = 10;
    const rawTrace = `Error: Something failed\n    at ${tmpPath}:5:12`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Something failed\n    at ${realPath}:14:12`);
  });

  it("handles empty or falsy stack traces safely", () => {
    expect(cleanStackTrace("", "/tmp/file.mjs", "src/file.html", 1)).toBe("");
  });
});
