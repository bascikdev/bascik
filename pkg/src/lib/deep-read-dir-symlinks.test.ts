/**
 * deepReadDirFlat against a real temp directory containing real symlinks.
 *
 * file-system.test.ts mocks node:fs/promises wholesale, which cannot express
 * Dirent.isSymbolicLink() semantics. These tests pin the symlink policy from
 * prompt 80: symlinked directories are followed (stat, not lstat), files keep
 * their link path, dangling links are skipped with one warning, and cycles
 * terminate with one warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    directory: { pages: "pages", components: ["components"], out: "dist" },
    minify: { css: false, js: false, html: false },
    logging: { level: "info", copies: true, deletes: true },
    assets: { inlineStyles: false },
  },
  shouldLog: () => true,
}));

import { deepReadDirFlat } from "./file-system.ts";

let base: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-symlink-read-")));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(base, { recursive: true, force: true });
});

const write = (rel: string, content = "<div></div>") => {
  const abs = join(base, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

describe("deepReadDirFlat symlink policy", () => {
  it("recurses into a symlinked directory and reports files under the link path", async () => {
    write("shared/components/hello-card.html");
    mkdirSync(join(base, "site/components"), { recursive: true });
    symlinkSync(join(base, "shared/components"), join(base, "site/components/shared"), "dir");

    const files = await deepReadDirFlat(join(base, "site/components"), /\.html$/);
    expect(files).toEqual([join(base, "site/components/shared/hello-card.html")]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns a symlinked file under its link path", async () => {
    write("elsewhere/linked-badge.html");
    mkdirSync(join(base, "root"), { recursive: true });
    symlinkSync(join(base, "elsewhere/linked-badge.html"), join(base, "root/linked-badge.html"), "file");

    const files = await deepReadDirFlat(join(base, "root"), /\.html$/);
    expect(files).toEqual([join(base, "root/linked-badge.html")]);
  });

  it("skips a dangling symlink with exactly one warning", async () => {
    mkdirSync(join(base, "root"), { recursive: true });
    write("root/real-card.html");
    symlinkSync(join(base, "missing-target"), join(base, "root/ghost"), "dir");

    const files = await deepReadDirFlat(join(base, "root"), /\.html$/);
    expect(files).toEqual([join(base, "root/real-card.html")]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/dangling symlink/i);
    expect(warnSpy.mock.calls[0].join(" ")).toContain(join(base, "root/ghost"));
  });

  it("terminates a symlink cycle, returns each file once, and warns once", async () => {
    write("root/a-card.html");
    write("root/sub/b-card.html");
    symlinkSync(join(base, "root"), join(base, "root/loop"), "dir");

    const files = await deepReadDirFlat(join(base, "root"), /\.html$/);
    expect(files.sort()).toEqual([
      join(base, "root/a-card.html"),
      join(base, "root/sub/b-card.html"),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/cycle/i);
    expect(warnSpy.mock.calls[0].join(" ")).toContain(join(base, "root/loop"));
  });
});
