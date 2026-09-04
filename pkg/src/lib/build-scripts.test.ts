import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeBuildScripts,
  extractScriptDeps,
  collectAllScriptDeps,
  resolveBuildScriptImports,
  SCRIPT_CACHE_VERSION,
  clearBuildScriptCaches,
} from "./build-scripts.ts";
import { cleanStackTrace } from "./stack-trace.ts";

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
    base: "/",
    isBuild: false,
    scripts: { cache: { enabled: true }, onBuildScriptError: "error", importRoot: "src" },
    directory: { pages: "src/pages", components: "src/components", out: "dist" },
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
  (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "error" };
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

  it("rewrites relative static imports to absolute file URLs using the page directory as base", async () => {
    resolveWith("");

    await executeBuildScripts(
      "<script data-bascik-build>import { renderSectionLabel } from '../../lib/render-nav.ts';\nconsole.log(renderSectionLabel('/x'));</script>",
      "docs/src/pages/internals/time-boundaries.html",
    );

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain(
      `import { renderSectionLabel } from '${pathToFileURL(resolve(process.cwd(), "docs/src/lib/render-nav.ts")).href}';`,
    );
  });

  it("uses deferred component source identity for relative imports", async () => {
    resolveWith("");

    await executeBuildScripts(
      `<script data-bascik-build="page" data-bascik-source-file="src%2Fcomponents%2Fpage-badge.html">import './page-badge-helper.ts';</script>`,
      "src/pages/index.html",
      null,
      { pageFile: "src/pages/index.html" },
    );

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain(
      `import '${pathToFileURL(resolve(process.cwd(), "src/components/page-badge-helper.ts")).href}'`,
    );
  });

  it("preserves distinct page and deferred component identities in a batch", async () => {
    resolveWith(JSON.stringify([
      { id: 0, ok: true, stdout: "page" },
      { id: 1, ok: true, stdout: "component" },
    ]));

    await executeBuildScripts(
      `<script data-bascik-build>console.log(process.env.BASCIK_SOURCE_FILE)</script>
       <script data-bascik-build="page" data-bascik-source-file="src%2Fcomponents%2Fpage-badge.html">console.log(process.env.BASCIK_SOURCE_FILE)</script>`,
      "src/pages/index.html",
      null,
      { pageFile: "src/pages/index.html" },
    );

    const tempWrites = (writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]) => String(path).endsWith(".mjs"));
    expect(tempWrites).toHaveLength(2);
    expect(tempWrites[0][1]).toContain("//# sourceURL=src/pages/index.html");
    expect(tempWrites[1][1]).toContain("//# sourceURL=src/components/page-badge.html");
    const batchArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(batchArgs).toEqual(expect.arrayContaining([
      expect.stringContaining('"sourceFile":"src/pages/index.html"'),
      expect.stringContaining('"sourceFile":"src/components/page-badge.html"'),
    ]));
  });

  it("rewrites dynamic relative imports and leaves bare and absolute URL specifiers untouched", async () => {
    resolveWith("");

    await executeBuildScripts(
      `<script data-bascik-build>
         const { renderMd } = await import('../../lib/md-renderer.ts');
         const marked = await import('marked');
         const remote = await import('https://example.com/x.mjs');
         console.log(Boolean(renderMd) && Boolean(marked) && Boolean(remote));
       </script>`,
      "docs/src/pages/internals/time-boundaries.html",
    );

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain(
      `await import('${pathToFileURL(resolve(process.cwd(), "docs/src/lib/md-renderer.ts")).href}')`,
    );
    expect(written).toContain("await import('marked')");
    expect(written).toContain("await import('https://example.com/x.mjs')");
  });

  it("rewrites imports only in JavaScript code and template expressions", () => {
    const baseDir = resolve(process.cwd(), "src/pages");
    const source = [
      "// import './comment.ts'",
      "const quoted = \"import('./quoted.ts')\";",
      "const template = `import('./raw.ts') ${import('./expression.ts')}`;",
      "const matcher = /import\\(['\"]\\.\\/regex\\.ts['\"]\\)/;",
      "obj.import('./method.ts');",
      "import /* keep-before */ { value as commented } from /* keep-specifier */ './commented.ts';",
      "import './side-effect.ts';",
      "export { value } from './exported.ts';",
      "const loaded = import('./dynamic.ts');",
      "const token = '$& $1 $$';",
    ].join("\n");

    const rewritten = resolveBuildScriptImports(source, baseDir);

    expect(rewritten).toContain("// import './comment.ts'");
    expect(rewritten).toContain("\"import('./quoted.ts')\"");
    expect(rewritten).toContain("`import('./raw.ts') ${import('file:");
    expect(rewritten).toContain("/import\\(['\"]\\.\\/regex\\.ts['\"]\\)/");
    expect(rewritten).toContain("obj.import('./method.ts')");
    expect(rewritten).toContain("import /* keep-before */ { value as commented } from /* keep-specifier */ 'file:");
    expect(rewritten).toContain(`import '${pathToFileURL(resolve(baseDir, "side-effect.ts")).href}'`);
    expect(rewritten).toContain(`from '${pathToFileURL(resolve(baseDir, "exported.ts")).href}'`);
    expect(rewritten).toContain(`import('${pathToFileURL(resolve(baseDir, "dynamic.ts")).href}')`);
    expect(rewritten).toContain("const token = '$& $1 $$'");
  });

  it.each([
    `if (ready) /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `{ markReady(); } /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
  ])("leaves regex literals after statement boundaries byte-for-byte unchanged", (source) => {
    expect(resolveBuildScriptImports(source, resolve(process.cwd(), "src/pages"))).toBe(source);
  });

  it("removes the temp file after execution", async () => {
    resolveWith("output");
    await executeBuildScripts("<script data-bascik-build>x</script>");
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("replaces the script tag with empty string on execution error when onBuildScriptError is 'warn'", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "warn" };
    rejectWith("syntax error");
    const html =
      "<p>before</p><script data-bascik-build>bad code</script><p>after</p>";
    const result = await executeBuildScripts(html);
    expect(result).toContain("<p>before</p>");
    expect(result).toContain("<p>after</p>");
    expect(result).not.toContain("data-bascik-build");
  });

  it("still removes the temp file when execution fails", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "warn" };
    rejectWith("error");
    await executeBuildScripts("<script data-bascik-build>bad</script>");
    expect(unlink).toHaveBeenCalledTimes(1);
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
    expect(opts.env?.BASCIK_SOURCE_FILE).toBe("/abs/project/src/pages/guides/intro.html");
    expect(opts.env?.BASCIK_PAGE_FILE).toBe("/abs/project/src/pages/guides/intro.html");
    expect(opts.env?.BASCIK_PAGES_DIR).toBe(`${process.cwd()}/src/pages`);
  });

  it("omits BASCIK_SITE_URL from child env when unset, so scripts can distinguish unset from empty", async () => {
    resolveWith("");
    const saved = process.env.BASCIK_SITE_URL;
    delete process.env.BASCIK_SITE_URL;
    try {
      await executeBuildScripts("<script data-bascik-build>x</script>");
      const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
      expect(opts.env && "BASCIK_SITE_URL" in opts.env).toBe(false);
    } finally {
      if (saved !== undefined) process.env.BASCIK_SITE_URL = saved;
    }
  });

  it("passes BASCIK_SITE_URL to child env when set", async () => {
    resolveWith("");
    const saved = process.env.BASCIK_SITE_URL;
    process.env.BASCIK_SITE_URL = "https://example.com";
    try {
      await executeBuildScripts("<script data-bascik-build>x</script>");
      const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
      expect(opts.env?.BASCIK_SITE_URL).toBe("https://example.com");
    } finally {
      if (saved === undefined) {
        delete process.env.BASCIK_SITE_URL;
      } else {
        process.env.BASCIK_SITE_URL = saved;
      }
    }
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

  it("handles a timeout kill gracefully: warns and removes the tag when onBuildScriptError is 'warn'", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "warn" };
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

  it("respects onBuildScriptError: warn", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-build>bad()</script>";
    const result = await executeBuildScripts(html);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("reads script content from double-quoted src file when script tag body is empty", async () => {
    mockReadFile.mockResolvedValueOnce('console.log("<h1>External Build Header</h1>");');
    resolveWith("<h1>External Build Header</h1>");

    const html = '<script data-bascik-build src="helper.ts"></script>';
    const result = await executeBuildScripts(html, "src/components/my-comp.html");

    expect(mockReadFile).toHaveBeenCalled();
    expect(result).toBe("<h1>External Build Header</h1>");
  });

  it("reads script content from single-quoted src file", async () => {
    mockReadFile.mockResolvedValueOnce('console.log("<h1>Single Quoted</h1>");');
    resolveWith("<h1>Single Quoted</h1>");

    const html = "<script data-bascik-build src='helper.ts'></script>";
    const result = await executeBuildScripts(html, "src/components/my-comp.html");

    expect(mockReadFile).toHaveBeenCalled();
    expect(result).toBe("<h1>Single Quoted</h1>");
  });

  it("reads script content from unquoted src file and handles spaces around equals", async () => {
    mockReadFile.mockResolvedValueOnce('console.log("<h1>Unquoted Header</h1>");');
    resolveWith("<h1>Unquoted Header</h1>");

    const html = '<script data-bascik-build src = ./helper.ts></script>';
    const result = await executeBuildScripts(html, "src/components/my-comp.html");

    expect(mockReadFile).toHaveBeenCalled();
    expect(result).toBe("<h1>Unquoted Header</h1>");
  });

  it("respects onBuildScriptError: error", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "error" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-build>bad()</script>";
    await expect(executeBuildScripts(html)).rejects.toThrow(/build script error/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("formats the error messages cleanly, removing command failure and node internals", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "error" };
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
    expect(deps).toContain("data/items.json");
    expect(deps).toContain("../shared/config.yaml");
    expect(deps).not.toContain("src/utils/helpers.ts");
  });

  it("resolves relative dependencies when baseDir is a subfolder", () => {
    const fileContent = "import { NAV } from './nav.ts';";
    const baseDir = resolve(process.cwd(), "docs/scripts");
    const deps = extractScriptDeps(fileContent, baseDir);
    expect(deps).toContain("docs/scripts/nav.ts");
  });

  it("ignores path-like text outside code while preserving code strings and template expressions", () => {
    const script = [
      "// renderMd('./content/comment.md')",
      "/* import './content/block-comment.md' */",
      `const quoted = "import './content/quoted.md'";`,
      "const template = `./content/raw.md ${renderMd('./content/interpolation.md')}`;",
      "const pattern = /\\.\\/content\\/regex\\.md/;",
      "renderMd('./content/real.md');",
      "import './scripts/real.ts';",
    ].join("\n");

    expect(extractScriptDeps(script)).toEqual([
      "scripts/real.ts",
      "./content/interpolation.md",
      "./content/real.md",
    ]);
  });

  it.each([
    `if (ready) /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `{ markReady(); } /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
  ])("does not collect generic dependencies from regex literals after statement boundaries", (source) => {
    expect(extractScriptDeps(source)).toEqual([]);
  });

  it("resolves @/ and / import-root aliases to cwd-relative keys under the default import root", () => {
    const script = "import { a } from '@/lib/a.ts';\nimport { b } from '/lib/b.ts';\nimport { c } from '../c.ts';";
    const deps = extractScriptDeps(script, resolve(process.cwd(), "src/pages/nested"));
    expect(deps).toContain("src/lib/a.ts");
    expect(deps).toContain("src/lib/b.ts");
    expect(deps).toContain("src/pages/c.ts");
    expect(deps).not.toContain("lib/a.ts");
  });

  it("resolves aliases against an explicit import root outside the project", () => {
    const deps = extractScriptDeps(
      "import { a } from '@/lib/a.ts';",
      resolve(process.cwd(), "src/pages"),
      { importRoot: resolve(process.cwd(), "../shared") },
    );
    expect(deps).toContain("../shared/lib/a.ts");
  });

  it("does not treat scoped packages as import-root aliases", () => {
    expect(extractScriptDeps("import x from '@scope/pkg';")).toEqual([]);
  });
});

// ─── import-root aliases in executeBuildScripts ──────────────────────────────

describe("import-root aliases (@/ and /)", () => {
  it("rewrites @/ and / imports to the import root regardless of page depth", async () => {
    resolveWith("");
    const expected = pathToFileURL(resolve(process.cwd(), "src/lib/helper.ts")).href;

    for (const pageFile of ["src/pages/a.html", "src/pages/deeply/nested/b.html"]) {
      (writeFile as ReturnType<typeof vi.fn>).mockClear();
      await executeBuildScripts(
        "<script data-bascik-build>import { a } from '@/lib/helper.ts';\nimport { b } from '/lib/helper.ts';</script>",
        pageFile,
      );
      const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).toContain(`import { a } from '${expected}';`);
      expect(written).toContain(`import { b } from '${expected}';`);
    }
  });

  it.each(["@/lib/entry.ts", "/lib/entry.ts"])("reads src=\"%s\" from the import root and re-bases its relative imports", async (src) => {
    const entryPath = resolve(process.cwd(), "src/lib/entry.ts");
    mockReadFile.mockImplementation(async (path: string) => {
      if (String(path) === entryPath) return "import './sibling.ts';";
      throw new Error("ENOENT");
    });
    resolveWith("");

    await executeBuildScripts(`<script data-bascik-build src="${src}"></script>`, "src/pages/deeply/nested/page.html");

    expect(mockReadFile).toHaveBeenCalledWith(entryPath, "utf8");
    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls.find(([p]) => String(p).endsWith(".mjs"))?.[1] as string;
    expect(written).toContain(`import '${pathToFileURL(resolve(process.cwd(), "src/lib/sibling.ts")).href}'`);
  });

  it("collectAllScriptDeps includes alias targets so the dev watcher rebuilds on edit", async () => {
    const html = `
      <script data-bascik-build>
        import { a } from '@/lib/alias-helper.ts';
        import { b } from '/lib/slash-helper.ts';
      </script>
      <script data-bascik-routes src="@/lib/routes-entry.ts"></script>
    `;
    const deps = await collectAllScriptDeps(html, "src/pages/deeply/nested/page.html");
    expect(deps).toContain("src/lib/alias-helper.ts");
    expect(deps).toContain("src/lib/slash-helper.ts");
    expect(deps).toContain("src/lib/routes-entry.ts");
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

  it("collects file dependencies from <script data-bascik-routes> tags in html", async () => {
    const html = `
      <script data-bascik-routes>
        import { fetchRoutes } from './scripts/route-generator.ts';
        console.log(JSON.stringify(await fetchRoutes()));
      </script>
    `;
    const deps = await collectAllScriptDeps(html);
    expect(deps).toContain("scripts/route-generator.ts");
  });

  it("uses the source directory for ESM imports and process.cwd() for generic data paths", async () => {
    const html = `
      <script data-bascik-build>
        import { renderMd } from '../../lib/md-renderer.ts';
        console.log(await renderMd('./content/cli.md'));
      </script>
    `;
    const deps = await collectAllScriptDeps(html, "docs/src/pages/internals/architecture.html");
    expect(deps).toContain("docs/src/lib/md-renderer.ts");
    expect(deps).toContain("content/cli.md");
    expect(deps).not.toContain("docs/src/pages/internals/content/cli.md");
  });

  it.each([
    ["data-bascik-build", 'src="./scripts/build-entry.ts"'],
    ["data-bascik-routes", "src = ./scripts/routes-entry.ts"],
  ])("collects external %s scripts and nested imports for watch fileDependencies", async (directive, srcAttribute) => {
    const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith("src/pages/scripts/build-entry.ts") ||
        String(filePath).endsWith("src/pages/scripts/routes-entry.ts")) {
        return "import './nested/helper.ts';";
      }
      if (String(filePath).endsWith("src/pages/scripts/nested/helper.ts")) {
        return "export const value = true;";
      }
      throw new Error("ENOENT");
    });

    const deps = await collectAllScriptDeps(
      `<script ${directive} ${srcAttribute}></script>`,
      "src/pages/index.html",
    );

    expect(deps).toContain(`src/pages/scripts/${directive === "data-bascik-build" ? "build" : "routes"}-entry.ts`);
    expect(deps).toContain("src/pages/scripts/nested/helper.ts");
  });

  it("throws an error when script tag has both data-bascik-build and data-bascik-server", async () => {
    const html = "<script data-bascik-build data-bascik-server>console.log(1)</script>";
    await expect(executeBuildScripts(html, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-build and data-bascik-server/,
    );
  });

  it("throws an error when script tag has both data-bascik-build and data-bascik-routes", async () => {
    const html = "<script data-bascik-build data-bascik-routes>console.log(1)</script>";
    await expect(executeBuildScripts(html, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-build and data-bascik-routes/,
    );
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
    (BascikConfig.scripts as any).onBuildScriptError = "warn";
    rejectWith("syntax error");
    await executeBuildScripts("<script data-bascik-build>bad()</script>");
    const jsonCall = mockWriteFile.mock.calls.find(
      ([path]) => String(path).endsWith(".json"),
    );
    expect(jsonCall).toBeUndefined();
    (BascikConfig.scripts as any).onBuildScriptError = "error";
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
    const script = "<script data-bascik-build>import '../../docs/scripts/render-nav.ts'</script>";

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

  it("invalidates cache when a page-relative imported file changes", async () => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    clearBuildScriptCaches();
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, cache: { enabled: true } };
    let helperVersion = "v1";
    let dependencyReads = 0;
    mockReadFile.mockImplementation((path: string) => {
      const file = String(path);
      if (file.includes("script-cache")) return Promise.reject(new Error("ENOENT"));
      if (file.endsWith("docs/src/lib/render-nav.ts")) {
        dependencyReads++;
        return Promise.resolve(`export const label = '${helperVersion}';`);
      }
      return Promise.reject(new Error("ENOENT"));
    });
    resolveWith("<p>rendered</p>");
    const html = "<script data-bascik-build>import { label } from '../../lib/render-nav.ts'; console.log(label);</script>";

    await executeBuildScripts(html, "docs/src/pages/internals/example.html");
    const firstKey = mockWriteFile.mock.calls.find(([path]) => String(path).endsWith(".json"))?.[0];

    helperVersion = "v2";
    clearBuildScriptCaches();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    await executeBuildScripts(html, "docs/src/pages/internals/example.html");
    const secondKey = mockWriteFile.mock.calls.find(([path]) => String(path).endsWith(".json"))?.[0];

    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(dependencyReads).toBe(2);
    expect(secondKey).not.toBe(firstKey);
  });

  it("invalidates cache when a file imported via the @/ import root alias changes", async () => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    clearBuildScriptCaches();
    let helperVersion = "v1";
    let dependencyReads = 0;
    mockReadFile.mockImplementation((path: string) => {
      const file = String(path);
      if (file.includes("script-cache")) return Promise.reject(new Error("ENOENT"));
      if (file === resolve(process.cwd(), "src/lib/helper.ts")) {
        dependencyReads++;
        return Promise.resolve(`export const label = '${helperVersion}';`);
      }
      return Promise.reject(new Error("ENOENT"));
    });
    resolveWith("<p>rendered</p>");
    const html = "<script data-bascik-build>import { label } from '@/lib/helper.ts'; console.log(label);</script>";

    await executeBuildScripts(html, "src/pages/deeply/nested/example.html");
    const firstKey = mockWriteFile.mock.calls.find(([path]) => String(path).endsWith(".json"))?.[0];

    helperVersion = "v2";
    clearBuildScriptCaches();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    await executeBuildScripts(html, "src/pages/deeply/nested/example.html");
    const secondKey = mockWriteFile.mock.calls.find(([path]) => String(path).endsWith(".json"))?.[0];

    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(dependencyReads).toBe(2);
    expect(secondKey).not.toBe(firstKey);
  });

  it("skips cache reads and writes entirely when scripts.cache.enabled is false", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, cache: { enabled: false } };
    resolveWith("<p>no-cache</p>");
    const result = await executeBuildScripts(
      "<script data-bascik-build>nodeps()</script>",
    );
    expect(result).toBe("<p>no-cache</p>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const jsonWrites = mockWriteFile.mock.calls.filter(([p]) => String(p).endsWith(".json"));
    expect(jsonWrites.length).toBe(0);
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, cache: { enabled: true } };
  });

  it("handles batch execution when one script fails and onBuildScriptError is 'warn'", async () => {
    (BascikConfig as any).scripts = { ...BascikConfig.scripts, onBuildScriptError: "warn" };
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
  });

  it("throws and identifies the failed script in a batch when onBuildScriptError is 'error'", async () => {
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

  it("passes BASCIK_PAGE_PATH to child process based on computePagePath or options", async () => {
    resolveWith("<p>ok</p>");
    const template = "<script data-bascik-build>x()</script>";

    await executeBuildScripts(template, "src/pages/guides/getting-started.html");
    const opts1 = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts1.env?.BASCIK_PAGE_PATH).toBe("/guides/getting-started");

    mockExecFile.mockClear();
    await executeBuildScripts(template, "src/components/pagination.html", null, {
      pageFile: "src/pages/switch/from-react.html",
      sourceFile: "src/components/pagination.html",
    });
    const opts2 = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts2.env?.BASCIK_PAGE_PATH).toBe("/switch/from-react");
    expect(opts2.env?.BASCIK_PAGE_FILE).toBe("src/pages/switch/from-react.html");
    expect(opts2.env?.BASCIK_SOURCE_FILE).toBe("src/components/pagination.html");
  });

  it("passes BASCIK_BASE to child processes and defaults to root", async () => {
    resolveWith("<p>ok</p>");
    const template = "<script data-bascik-build>x()</script>";

    await executeBuildScripts(template, "src/pages/index.html");
    const rootOptions = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    expect(rootOptions.env?.BASCIK_BASE).toBe("/");

    mockExecFile.mockClear();
    (BascikConfig as any).base = "/sub/";
    try {
      await executeBuildScripts(template, "src/pages/about.html");
      const subOptions = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
      expect(subOptions.env?.BASCIK_BASE).toBe("/sub/");
    } finally {
      (BascikConfig as any).base = "/";
    }
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
