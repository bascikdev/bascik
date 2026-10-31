import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileInPlaceOfFolder, isNoSuchFileError } from "./fs-errors.ts";

describe("isNoSuchFileError", () => {
  it.each([
    ["ENOENT", true],
    ["ENOTDIR", true],
    ["ENAMETOOLONG", true],
    ["EACCES", false],
    ["EISDIR", false],
    ["EIO", false],
    ["EMFILE", false],
    ["enoent", false],
  ])("%s -> %s", (code, expected) => {
    expect(isNoSuchFileError(Object.assign(new Error(code), { code }))).toBe(
      expected,
    );
  });

  it("is false for anything that is not an error with a code", () => {
    for (const value of [undefined, null, "ENOENT", 2, {}, new Error("x")])
      expect(isNoSuchFileError(value)).toBe(false);
  });

  it("matches what the file system throws for a missing path, a file used as a folder and an overlong name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-fs-errors-"));
    try {
      writeFileSync(join(dir, "file.txt"), "x");
      const thrown = async (path: string) =>
        readFile(path).then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isNoSuchFileError(await thrown(join(dir, "missing")))).toBe(true);
      expect(
        isNoSuchFileError(await thrown(join(dir, "file.txt", "child"))),
      ).toBe(true);
      expect(isNoSuchFileError(await thrown(join(dir, "n".repeat(5000))))).toBe(
        true,
      );
      // A folder read as a file is a real fault, not a missing file.
      expect(isNoSuchFileError(await thrown(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Windows reports ENOENT, not ENOTDIR, when a component of the path is a
 * regular file, so a caller that reads ENOENT as "nothing there" cannot tell
 * a missing file from a file standing where a folder belongs. These run on
 * every host through path.win32 and a fake stat.
 */
describe("fileInPlaceOfFolder", () => {
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
      code: "ENOENT",
    });
  /** A fake stat over a win32 disk: `files` and `dirs` exist, the rest do not. */
  const fakeStat =
    (
      dirs: string[],
      files: string[] = [],
      other: Record<string, string> = {},
    ) =>
    (path: string) => {
      if (other[path])
        throw Object.assign(new Error(other[path]), { code: other[path] });
      if (dirs.includes(path)) return { isDirectory: () => true };
      if (files.includes(path)) return { isDirectory: () => false };
      throw enoent(path);
    };

  it("names the file that stands where the parent folder belongs", () => {
    const stat = fakeStat(
      ["C:\\", "C:\\site", "C:\\site\\dist"],
      ["C:\\site\\dist\\.bascik"],
    );
    expect(
      fileInPlaceOfFolder(
        "C:\\site\\dist\\.bascik\\server-scripts.json",
        stat,
        win32,
      ),
    ).toBe("C:\\site\\dist\\.bascik");
  });

  it("walks past missing folders to a file further up", () => {
    const stat = fakeStat(["C:\\", "C:\\site"], ["C:\\site\\dist"]);
    expect(
      fileInPlaceOfFolder(
        "C:\\site\\dist\\.bascik\\server-scripts.json",
        stat,
        win32,
      ),
    ).toBe("C:\\site\\dist");
  });

  it("is undefined for a plain missing file, and stops at the drive or share root", () => {
    expect(
      fileInPlaceOfFolder(
        "C:\\site\\dist\\.bascik\\server-scripts.json",
        fakeStat(["C:\\", "C:\\site", "C:\\site\\dist"]),
        win32,
      ),
    ).toBe(undefined);
    // Nothing exists at all, not even the drive: the walk ends at C:\.
    expect(fileInPlaceOfFolder("C:\\a\\b\\c.json", fakeStat([]), win32)).toBe(
      undefined,
    );
    expect(
      fileInPlaceOfFolder("\\\\srv\\share\\a\\b.json", fakeStat([]), win32),
    ).toBe(undefined);
  });

  it("misuse: is undefined when an ancestor cannot be read, so the original error stands", () => {
    const stat = fakeStat(["C:\\"], [], { "C:\\site": "EACCES" });
    expect(fileInPlaceOfFolder("C:\\site\\dist\\x.json", stat, win32)).toBe(
      undefined,
    );
  });

  it("finds a file used as a folder on this host's disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-fs-errors-"));
    try {
      writeFileSync(join(dir, ".bascik"), "not a folder");
      expect(fileInPlaceOfFolder(join(dir, ".bascik", "x.json"))).toBe(
        join(dir, ".bascik"),
      );
      expect(fileInPlaceOfFolder(join(dir, "missing", "x.json"))).toBe(
        undefined,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
