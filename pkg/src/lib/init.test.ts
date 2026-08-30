import { beforeEach, describe, expect, it, vi } from "vitest";
import { initProject } from "./init.ts";

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

vi.spyOn(console, "log").mockImplementation(() => { });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Make access() throw (file does not exist). */
const fileAbsent = () => mockAccess.mockRejectedValue(new Error("ENOENT"));

/** Make access() resolve (file exists). */
const filePresent = () => mockAccess.mockResolvedValue(undefined);

/** Return the content written to writeFile for the given path suffix. */
const writtenTo = (suffix: string): string | undefined => {
  for (const call of mockWriteFile.mock.calls) {
    if (String(call[0]).endsWith(suffix)) {
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
    const dirs = mockMkdir.mock.calls.map((c) => String(c[0]));
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

  it("writes bascik.config.js when absent", async () => {
    await initProject();
    const cfg = writtenTo("bascik.config.js");
    expect(cfg).toBeDefined();
    expect(cfg).toContain("export const build");
  });

  it("skips index.html when it already exists", async () => {
    // Make only index.html present; config absent.
    mockAccess
      .mockResolvedValueOnce(undefined) // index.html exists
      .mockRejectedValue(new Error("ENOENT")); // bascik.config.js absent

    await initProject();

    const html = writtenTo("index.html");
    expect(html).toBeUndefined();
  });

  it("skips bascik.config.js when it already exists", async () => {
    // index.html absent, config present
    mockAccess
      .mockRejectedValueOnce(new Error("ENOENT")) // index.html absent
      .mockResolvedValueOnce(undefined); // bascik.config.js exists

    await initProject();

    const cfg = writtenTo("bascik.config.js");
    expect(cfg).toBeUndefined();
  });

  it('adds type:module and dev/build scripts to package.json', async () => {
    mockReadFile.mockResolvedValue('{"name":"my-app"}');

    await initProject();

    const pkgWrite = writtenTo("package.json");
    expect(pkgWrite).toBeDefined();
    const parsed = JSON.parse(pkgWrite!);
    expect(parsed.type).toBe("module");
    expect(parsed.scripts.dev).toBe("bascik");
    expect(parsed.scripts.build).toBe("bascik --build");
  });

  it("does not overwrite existing type or scripts in package.json", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        name: "my-app",
        type: "module",
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
});
