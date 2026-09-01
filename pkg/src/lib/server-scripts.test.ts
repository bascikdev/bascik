import { describe, it, expect, vi, beforeEach } from "vitest";
import { htmlHasServerScripts, executeServerScripts, cleanStackTrace } from "./server-scripts.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => { }),
  unlink: vi.fn(async () => { }),
  mkdir: vi.fn(async () => { }),
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: {
      onServerScriptError: "error",
      timeout: 30000,
    },
    directory: {
      out: "dist",
    },
  },
}));

import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { BascikConfig } from "./config.ts";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

const baseRequest = {
  path: "/",
  method: "GET",
  headers: {},
  searchParams: {},
};

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
});

// ─── htmlHasServerScripts ────────────────────────────────────────────────────

describe("htmlHasServerScripts", () => {
  it("returns false for html with no script tags", () => {
    expect(htmlHasServerScripts("<p>hello</p>")).toBe(false);
  });

  it("returns false for a data-bascik-build script", () => {
    expect(htmlHasServerScripts("<script data-bascik-build>x</script>")).toBe(false);
  });

  it("returns false for a plain script tag", () => {
    expect(htmlHasServerScripts("<script>console.log(1)</script>")).toBe(false);
  });

  it("returns true for a data-bascik-server script", () => {
    expect(htmlHasServerScripts("<script data-bascik-server>x</script>")).toBe(true);
  });

  it("returns true when server script has additional attributes", () => {
    expect(htmlHasServerScripts('<script type="module" data-bascik-server>x</script>')).toBe(true);
  });

  it("returns true when data-bascik-server appears anywhere in the html", () => {
    const html = "<p>Static</p><script data-bascik-server>x</script><footer>ok</footer>";
    expect(htmlHasServerScripts(html)).toBe(true);
  });

  it("is not tripped by the string 'data-bascik-server' inside an attribute value", () => {
    // A data attribute on a non-script element should not count
    expect(htmlHasServerScripts('<div data-kind="data-bascik-server"></div>')).toBe(false);
  });
});

// ─── executeServerScripts ────────────────────────────────────────────────────

describe("executeServerScripts", () => {
  it("returns html unchanged when there are no server scripts", async () => {
    const html = "<p>no server scripts here</p>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe(html);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("replaces a data-bascik-server script tag with script stdout", async () => {
    resolveWith("<p>Welcome, Alice</p>\n");
    const html =
      "<main><script data-bascik-server>console.log('<p>Welcome, Alice</p>');</script></main>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toContain("<p>Welcome, Alice</p>");
    expect(result).not.toContain("data-bascik-server");
    expect(result).toContain("<main>");
  });

  it("writes the script content to a temp .mjs file", async () => {
    resolveWith("");
    const scriptContent = "console.log('hi');";
    await executeServerScripts(
      `<script data-bascik-server>${scriptContent}</script>`,
      baseRequest,
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.mjs$/),
      expect.stringContaining(scriptContent),
      "utf8",
    );
  });

  it("writes temp scripts inside the project tree so ESM can resolve node_modules", async () => {
    resolveWith("");
    await executeServerScripts("<script data-bascik-server>x</script>", baseRequest);
    const [tmpPath] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tmpPath).toMatch(process.cwd());
    expect(tmpPath).not.toMatch(/^\/tmp\//);
  });

  it("removes the temp file after execution", async () => {
    resolveWith("output");
    await executeServerScripts("<script data-bascik-server>x</script>", baseRequest);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("still removes the temp file when execution fails", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    rejectWith("syntax error");
    await executeServerScripts("<script data-bascik-server>bad</script>", baseRequest);
    expect(unlink).toHaveBeenCalledTimes(1);
    (BascikConfig as any).scripts = { onServerScriptError: "error" };
  });

  it("replaces the script tag with empty string on execution error when onServerScriptError is 'warn'", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    rejectWith("ReferenceError: x is not defined");
    const html =
      "<p>before</p><script data-bascik-server>bad code</script><p>after</p>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toContain("<p>before</p>");
    expect(result).toContain("<p>after</p>");
    expect(result).not.toContain("data-bascik-server");
    (BascikConfig as any).scripts = { onServerScriptError: "error" };
  });

  it("passes BASCIK_REQUEST JSON to the child process env", async () => {
    resolveWith("");
    const req = {
      path: "/about",
      method: "GET",
      headers: { "x-display-name": "Alice" },
      searchParams: { page: "2" },
    };
    await executeServerScripts("<script data-bascik-server>x</script>", req);
    const opts = mockExecFile.mock.calls[0][2] as { env?: Record<string, string> };
    const parsed = JSON.parse(opts.env?.BASCIK_REQUEST ?? "{}");
    expect(parsed.path).toBe("/about");
    expect(parsed.method).toBe("GET");
    expect(parsed.headers["x-display-name"]).toBe("Alice");
    expect(parsed.searchParams.page).toBe("2");
  });

  it("runs with process.cwd() as the working directory", async () => {
    resolveWith("");
    await executeServerScripts("<script data-bascik-server>x</script>", baseRequest);
    const opts = mockExecFile.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe(process.cwd());
  });

  it("strips ANSI color codes from server-script output before injecting HTML", async () => {
    resolveWith("\u001B[33m2026\u001B[39m Built with Bascik");
    const html = "<span>&copy; <script data-bascik-server>console.log(1)</script></span>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<span>&copy; 2026 Built with Bascik</span>");
  });

  it("handles multiple identical server script blocks accurately without replacement collision", async () => {
    resolveWith("hello\n");
    const html =
      "<div><script data-bascik-server>console.log('hello')</script></div>" +
      "<div><script data-bascik-server>console.log('hello')</script></div>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<div>hello\n</div><div>hello\n</div>");
  });

  it("safely preserves dollar-sign regex replacement sequences ($1, $&, $$) in script stdout", async () => {
    resolveWith("Price: $100 | Code: $& | Total: $$50");
    const html = "<p><script data-bascik-server>console.log('dollar')</script></p>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<p>Price: $100 | Code: $& | Total: $$50</p>");
  });

  it("logs a warning when onServerScriptError is set to 'warn'", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    rejectWith("non-fatal error");
    const html = "<script data-bascik-server>bad()</script>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bascik] server script error"),
    );
    warnSpy.mockRestore();
    (BascikConfig as any).scripts = { onServerScriptError: "error" }; // restore default
  });

  it("forwards stderr output from the child process to process.stderr.write", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "stdout-data", "stderr-debug-msg");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const html = "<script data-bascik-server>console.error('stderr-debug-msg')</script>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("stdout-data");
    expect(stderrSpy).toHaveBeenCalledWith("stderr-debug-msg");
    stderrSpy.mockRestore();
  });

  it("processes a large batch of server scripts on a single page sequentially in batches", async () => {
    let scriptCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      scriptCount++;
      cb(null, `[script-${scriptCount}]`, "");
    });

    const scriptTags = Array.from(
      { length: 12 },
      (_, i) => `<script data-bascik-server>console.log(${i})</script>`,
    ).join("\n");
    const html = `<main>${scriptTags}</main>`;

    const result = await executeServerScripts(html, baseRequest);

    expect(scriptCount).toBe(12);
    expect(result).toContain("[script-1]");
    expect(result).toContain("[script-12]");
    expect(result).not.toContain("data-bascik-server");
  });

  it("writes stderr to process.stderr when script emits stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecFile.mockImplementationOnce(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "out", "warning in script\n");
      },
    );
    const html = "<script data-bascik-server>console.warn('warning')</script>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("out");
    expect(stderrSpy).toHaveBeenCalledWith("warning in script\n");
    stderrSpy.mockRestore();
  });

  it("preserves literal dollar patterns in output ($1, $&, $') without regex expansion", async () => {
    resolveWith("Price: $100 for $& items ($1)\n");
    const html = "<p><script data-bascik-server>console.log('Price')</script></p>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<p>Price: $100 for $& items ($1)\n</p>");
  });

  it("reads script content from src file when server script tag body is empty", async () => {
    const html = '<script data-bascik-server src="server-helper.ts"></script>';
    resolveWith("<p>Welcome user</p>");
    const result = await executeServerScripts(html, baseRequest, 30000, "src/pages/dashboard.html");
    expect(result).toBe("<p>Welcome user</p>");
  });

  it("processes multiple server scripts in parallel", async () => {
    mockExecFile
      .mockImplementationOnce(
        (
          _cmd: unknown,
          _args: unknown,
          _opts: unknown,
          cb: (err: null, stdout: string, stderr: string) => void,
        ) => {
          cb(null, "<p>first</p>", "");
        },
      )
      .mockImplementationOnce(
        (
          _cmd: unknown,
          _args: unknown,
          _opts: unknown,
          cb: (err: null, stdout: string, stderr: string) => void,
        ) => {
          cb(null, "<p>second</p>", "");
        },
      );

    const html =
      "<script data-bascik-server>a</script><script data-bascik-server>b</script>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toContain("<p>first</p>");
    expect(result).toContain("<p>second</p>");
    expect(result).not.toContain("data-bascik-server");
  });

  it("substitutes script output in place within a container element", async () => {
    resolveWith("<li>Alice</li><li>Bob</li>");
    const html = "<ul><script data-bascik-server>makeList()</script></ul>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<ul><li>Alice</li><li>Bob</li></ul>");
  });

  it("handles concurrent calls without state corruption across global regex", async () => {
    const html1 = "<div><script data-bascik-server>console.log('1')</script></div>";
    const html2 = "<p>no scripts</p>";
    resolveWith("<p>server 1</p>");
    const promises = [
      executeServerScripts(html1, baseRequest),
      Promise.resolve().then(() => htmlHasServerScripts(html2)),
      executeServerScripts(html1, baseRequest),
    ];
    const results = await Promise.all(promises);
    expect(results[0]).toBe("<div><p>server 1</p></div>");
    expect(results[1]).toBe(false);
    expect(results[2]).toBe("<div><p>server 1</p></div>");
  });

  it("propagates stderr from the script to process.stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecFile.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "<p>ok</p>", "warning: something happened\n");
      },
    );
    await executeServerScripts("<script data-bascik-server>x</script>", baseRequest);
    expect(stderrSpy).toHaveBeenCalledWith("warning: something happened\n");
    stderrSpy.mockRestore();
  });

  it("runs the correct node binary", async () => {
    resolveWith("");
    await executeServerScripts("<script data-bascik-server>x</script>", baseRequest);
    const cmd = mockExecFile.mock.calls[0][0] as string;
    expect(cmd).toBe(process.execPath);
  });

  it("does not expand $1 in script output as a regex back-reference", async () => {
    // A Postgres server script whose stdout contains $1 must be injected verbatim.
    // Previously result.replace(fullTag, output) treated $1 in output as a capture
    // group reference, expanding it to empty string or the capture group value.
    resolveWith("<p>session_id = $1</p>");
    const html = "<main><script data-bascik-server>pg()</script></main>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<main><p>session_id = $1</p></main>");
  });

  it("does not expand $2 in script output as a regex back-reference", async () => {
    resolveWith("<p>value is $2</p>");
    const html = "<main><script data-bascik-server>pg()</script></main>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<main><p>value is $2</p></main>");
  });

  it("does not expand $& in script output (would insert the matched script tag)", async () => {
    resolveWith("<p>cost: $&amp; tax included</p>");
    const html = "<div><script data-bascik-server>price()</script></div>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("<div><p>cost: $&amp; tax included</p></div>");
  });

  it("writes the user script content without injecting a hidden escapeHtml helper", async () => {
    resolveWith("");
    await executeServerScripts("<script data-bascik-server>console.log('hi')</script>", baseRequest);
    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain("console.log('hi')");
    expect(written).not.toContain("escapeHtml");
  });

  it("does not alter the order of user code when writing temp scripts", async () => {
    resolveWith("");
    await executeServerScripts("<script data-bascik-server>const x=1;</script>", baseRequest);
    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain("const x=1;");
    expect(written.indexOf("escapeHtml")).toBe(-1);
  });

  it("respects onServerScriptError: warn", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "warn" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-server>bad()</script>";
    const result = await executeServerScripts(html, baseRequest);
    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    (BascikConfig as any).scripts = { onServerScriptError: "error" };
  });

  it("appends //# sourceURL comment with filePath when provided, or request path as fallback", async () => {
    resolveWith("");
    await executeServerScripts(
      "<script data-bascik-server>x()</script>",
      baseRequest,
      30000,
      "src/pages/dashboard.html",
    );
    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(written).toContain("//# sourceURL=src/pages/dashboard.html");
  });

  it("respects onServerScriptError: error", async () => {
    (BascikConfig as any).scripts = { onServerScriptError: "error" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    rejectWith("failed script execution");
    const html = "<script data-bascik-server>bad()</script>";
    await expect(executeServerScripts(html, baseRequest)).rejects.toThrow(/server script error/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-build", async () => {
    const html = "<script data-bascik-server data-bascik-build>console.log(1)</script>";
    await expect(executeServerScripts(html, baseRequest, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-build/,
    );
  });

  it("throws an error when script tag has both data-bascik-server and data-bascik-routes", async () => {
    const html = "<script data-bascik-server data-bascik-routes>console.log(1)</script>";
    await expect(executeServerScripts(html, baseRequest, 30000, "src/pages/index.html")).rejects.toThrow(
      /has both data-bascik-server and data-bascik-routes/,
    );
  });
});

// ─── cleanStackTrace ─────────────────────────────────────────────────────────

describe("server-scripts cleanStackTrace", () => {
  it("replaces temporary file path and maps line numbers using lineOffset", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/server-123.mjs";
    const realPath = "src/pages/about.html";
    const lineOffset = 15;
    const rawTrace = `Error: Server error\n    at ${tmpPath}:3:8`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Server error\n    at ${realPath}:17:8`);
  });
});
