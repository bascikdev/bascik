import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeRoutesScript } from "./routes.ts";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => { }),
  unlink: vi.fn(async () => { }),
  mkdir: vi.fn(async () => { }),
  readFile: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    isBuild: false,
    scripts: {
      onRoutesScriptError: "error",
    },
    directory: { pages: "src/pages", components: "src/components", out: "dist" },
  },
}));

import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { BascikConfig } from "./config.ts";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  vi.clearAllMocks();
  (BascikConfig as any).scripts = { onRoutesScriptError: "error" };
  (BascikConfig as any).isBuild = false;
});

describe("executeRoutesScript", () => {
  it("returns null routes and original html when there are no routes scripts in static page", async () => {
    const html = "<p>Static Page</p>";
    const result = await executeRoutesScript(html, "src/pages/index.html");
    expect(result.routes).toBeNull();
    expect(result.cleanedHtml).toBe(html);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("warns and returns empty routes when dynamic template has no routes script", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = "<p>Post Template</p>";
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(result.cleanedHtml).toBe(html);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has no <script data-bascik-routes> tag'),
    );
    warnSpy.mockRestore();
  });

  it("executes routes script and returns parsed routes while removing script tag", async () => {
    const routesData = [
      { params: { slug: "post-1" }, data: { title: "Post 1" } },
      { params: { slug: "post-2" }, data: { title: "Post 2" } },
    ];
    resolveWith(JSON.stringify(routesData));

    const html = `<html>
<head>
  <script data-bascik-routes>
    console.log("...");
  </script>
</head>
<body><h1>Posts</h1></body>
</html>`;

    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual(routesData);
    expect(result.cleanedHtml).not.toContain("data-bascik-routes");
    expect(result.cleanedHtml).toContain("<body><h1>Posts</h1></body>");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("never reads from or writes to a script cache file", async () => {
    resolveWith(JSON.stringify([{ params: { slug: "a" } }]));
    const html = `<script data-bascik-routes>console.log('[]');</script>`;
    await executeRoutesScript(html, "src/pages/blog/[slug].html");

    // Only the temp script should be written, no .json cache files
    const writtenFiles = mockWriteFile.mock.calls.map((c) => c[0] as string);
    expect(writtenFiles.some((f) => f.includes("script-cache"))).toBe(false);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("throws hard error when more than one routes script exists in a page", async () => {
    const html = `
      <script data-bascik-routes>console.log("1")</script>
      <script data-bascik-routes>console.log("2")</script>
    `;
    await expect(
      executeRoutesScript(html, "src/pages/blog/[slug].html"),
    ).rejects.toThrow(/More than one <script data-bascik-routes> tag found/);
  });

  it("throws hard error on routes + build conflict on same tag", async () => {
    const html = `<script data-bascik-routes data-bascik-build>console.log("conflict")</script>`;
    await expect(
      executeRoutesScript(html, "src/pages/blog/[slug].html"),
    ).rejects.toThrow(/both data-bascik-routes and data-bascik-build/);
  });

  it("throws hard error on routes + server conflict on same tag", async () => {
    const html = `<script data-bascik-routes data-bascik-server>console.log("conflict")</script>`;
    await expect(
      executeRoutesScript(html, "src/pages/blog/[slug].html"),
    ).rejects.toThrow(/both data-bascik-routes and data-bascik-server/);
  });

  it("does not trigger on quoted-attribute false positives", async () => {
    const html = `<div data-desc="data-bascik-routes">Not a script</div>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result.routes).toEqual([]);
  });

  it("warns and ignores routes script inside component", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-routes>console.log("[]")</script><div>Component</div>`;
    const result = await executeRoutesScript(html, "src/components/card.html");
    expect(result.routes).toBeNull();
    expect(result.cleanedHtml).not.toContain("data-bascik-routes");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("inside a component"),
    );
    warnSpy.mockRestore();
  });

  it("warns and ignores routes script in file without brackets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const html = `<script data-bascik-routes>console.log("[]")</script><div>Static</div>`;
    const result = await executeRoutesScript(html, "src/pages/about.html");
    expect(result.routes).toBeNull();
    expect(result.cleanedHtml).not.toContain("data-bascik-routes");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("has no bracket parameters"),
    );
    warnSpy.mockRestore();
  });

  it("honors onRoutesScriptError: 'error' when script throws", async () => {
    rejectWith("Syntax error in script");
    (BascikConfig as any).scripts = { onRoutesScriptError: "error" };

    const html = `<script data-bascik-routes>bad code</script>`;
    await expect(
      executeRoutesScript(html, "src/pages/blog/[slug].html"),
    ).rejects.toThrow(/routes script error/);
  });

  it("honors onRoutesScriptError: 'warn' when script throws, logging warning and returning empty routes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    rejectWith("Syntax error in script");
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes>bad code</script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("routes script error"),
    );
    warnSpy.mockRestore();
  });

  it("honors onRoutesScriptError: 'warn' when stdout is invalid JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    resolveWith("Invalid JSON Output");
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes>console.log('not json')</script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid JSON returned by routes script"),
    );
    warnSpy.mockRestore();
  });

  it("warns when routes script src cannot be read from disk", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockReadFile.mockRejectedValueOnce(new Error("File not found"));
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes src="./missing-routes.ts"></script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[bascik] warning: Failed to read routes script src "%s":',
      "./missing-routes.ts",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("supports unquoted src attribute in routes script tag", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockReadFile.mockRejectedValueOnce(new Error("File not found"));
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes src=./unquoted-routes.ts></script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[bascik] warning: Failed to read routes script src "%s":',
      "./unquoted-routes.ts",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("supports single-quoted src attribute in routes script tag", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockReadFile.mockRejectedValueOnce(new Error("File not found"));
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes src='./single-quoted-routes.ts'></script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[bascik] warning: Failed to read routes script src "%s":',
      "./single-quoted-routes.ts",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("supports unquoted src attribute with spaces around equals in routes script tag", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    mockReadFile.mockRejectedValueOnce(new Error("File not found"));
    (BascikConfig as any).scripts = { onRoutesScriptError: "warn" };

    const html = `<script data-bascik-routes src = ./spaced-unquoted-routes.ts></script>`;
    const result = await executeRoutesScript(html, "src/pages/blog/[slug].html");
    expect(result.routes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[bascik] warning: Failed to read routes script src "%s":',
      "./spaced-unquoted-routes.ts",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
