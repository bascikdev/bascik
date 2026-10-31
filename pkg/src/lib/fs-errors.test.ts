import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNoSuchFileError } from "./fs-errors.ts";

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
