import { beforeEach, describe, expect, it, vi } from "vitest";
import { initProject } from "./init.ts";
import { VSCODE_SETTINGS_JSON, parseJsonc } from "./vscode-settings.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const mockAccess = access as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;

vi.spyOn(console, "log").mockImplementation(() => {});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return the content written to writeFile for the given path suffix. */
const writtenTo = (suffix: string): string | undefined => {
  for (const call of mockWriteFile.mock.calls) {
    if (String(call[0]).replace(/\\/g, "/").endsWith(suffix)) {
      return call[1] as string;
    }
  }
  return undefined;
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("initProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default every access() call throws — files are absent.
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    // package.json read returns a minimal valid package by default.
    mockReadFile.mockResolvedValue('{"name":"my-app"}');
  });

  it("creates pages and components directories", async () => {
    await initProject();
    const dirs = mockMkdir.mock.calls.map((c) =>
      String(c[0]).replace(/\\/g, "/"),
    );
    expect(dirs.some((d) => d.endsWith("src/pages"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("src/components"))).toBe(true);
    expect(mockMkdir.mock.calls[0][1]).toEqual({ recursive: true });
  });

  it("writes index.html when absent", async () => {
    await initProject();
    const html = writtenTo("index.html");
    expect(html).toBeDefined();
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("does not create bascik.config.js", async () => {
    await initProject();
    const cfg = writtenTo("bascik.config.js");
    expect(cfg).toBeUndefined();
  });

  it("skips index.html when it already exists", async () => {
    // Make only index.html present.
    mockAccess
      .mockResolvedValueOnce(undefined) // index.html exists
      .mockRejectedValue(new Error("ENOENT"));

    await initProject();

    const html = writtenTo("index.html");
    expect(html).toBeUndefined();
  });

  it("adds type:module, dependency, and dev/build scripts to package.json", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app"}');

    await initProject();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeDefined();
    const parsed = JSON.parse(pkgWrite!);
    expect(parsed.type).toBe("module");
    expect(parsed.dependencies["@bascik/bascik"]).toBe("latest");
    expect(parsed.scripts.dev).toBe("bascik");
    expect(parsed.scripts.build).toBe("bascik --build");
  });

  it("does not overwrite existing type or scripts in package.json", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        name: "my-app",
        type: "module",
        dependencies: { "@bascik/bascik": "latest" },
        scripts: { dev: "bascik", build: "bascik --build" },
      }),
    );

    await initProject();

    // writeFile should not have been called for package.json
    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  it("preserves existing scripts and only adds missing ones", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ name: "my-app", scripts: { dev: "bascik" } }),
    );

    await initProject();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeDefined();
    const parsed = JSON.parse(pkgWrite!);
    expect(parsed.scripts.dev).toBe("bascik"); // untouched
    expect(parsed.scripts.build).toBe("bascik --build"); // added
    expect(parsed.dependencies["@bascik/bascik"]).toBe("latest");
  });

  it("refuses to overwrite package type commonjs", async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app","type":"commonjs"}');
    await expect(initProject()).rejects.toThrow("init aborted");
  });

  it("appends .gitignore entries without clobbering existing content", async () => {
    // access(index) throws, .gitignore read succeeds.
    mockReadFile
      .mockResolvedValueOnce("node_modules/\n")
      .mockResolvedValueOnce('{"name":"my-app"}');

    await initProject();

    const gitignore = writtenTo(".gitignore");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("node_modules/.cache/bascik/");
  });

  it("skips package.json when it cannot be read", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await initProject();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  it("skips package.json when it cannot be parsed", async () => {
    mockReadFile.mockResolvedValue("not json {{{{");

    await initProject();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeUndefined();
  });

  describe("VS Code files", () => {
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    /** Serve package.json and the given .vscode files; everything else is absent. */
    function files(vscode: Record<string, string> = {}): void {
      mockReadFile.mockImplementation(async (path: unknown) => {
        const p = String(path).replace(/\\/g, "/");
        if (p.endsWith("/package.json")) return '{"name":"my-app"}';
        for (const [name, text] of Object.entries(vscode)) {
          if (p.endsWith(`/.vscode/${name}`)) return text;
        }
        throw enoent();
      });
    }

    const logged = (): string =>
      (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join("\n");

    it("writes settings.json with the inline-script check off, and extensions.json", async () => {
      files();
      await initProject();
      expect(writtenTo(".vscode/settings.json")).toBe(VSCODE_SETTINGS_JSON);
      expect(JSON.parse(writtenTo(".vscode/extensions.json")!)).toEqual({
        recommendations: ["bascik.bascik-vscode"],
      });
      expect(
        mockMkdir.mock.calls.some((c) =>
          String(c[0]).replace(/\\/g, "/").endsWith("/.vscode"),
        ),
      ).toBe(true);
      expect(logged()).toContain("created: .vscode/settings.json");
    });

    it("misuse: merges into existing files instead of overwriting them", async () => {
      files({
        "settings.json": '{\n  // mine\n  "editor.tabSize": 2\n}\n',
        "extensions.json": '{ "recommendations": ["dbaeumer.vscode-eslint"] }',
      });
      await initProject();
      const settings = writtenTo(".vscode/settings.json")!;
      expect(settings).toContain("// mine");
      expect(parseJsonc(settings)).toEqual({
        "html.validate.scripts": false,
        "editor.tabSize": 2,
      });
      expect(parseJsonc(writtenTo(".vscode/extensions.json")!)).toEqual({
        recommendations: ["bascik.bascik-vscode", "dbaeumer.vscode-eslint"],
      });
      expect(logged()).toContain(
        'updated: .vscode/settings.json (added "html.validate.scripts": false)',
      );
    });

    it("keeps a value the user already chose, even true", async () => {
      files({ "settings.json": '{ "html.validate.scripts": true }' });
      await initProject();
      expect(writtenTo(".vscode/settings.json")).toBeUndefined();
      expect(logged()).toContain("skipped: .vscode/settings.json");
    });

    it("misuse: leaves a broken settings file alone and prints the line to add", async () => {
      files({ "settings.json": "{ oops" });
      await initProject();
      expect(writtenTo(".vscode/settings.json")).toBeUndefined();
      expect(logged()).toContain(
        '.vscode/settings.json: left as is because it is not valid JSON. Add "html.validate.scripts": false',
      );
    });

    it("still sets up VS Code when package.json is missing", async () => {
      mockReadFile.mockRejectedValue(enoent());
      await initProject();
      expect(writtenTo(".vscode/settings.json")).toBe(VSCODE_SETTINGS_JSON);
    });
  });
});
