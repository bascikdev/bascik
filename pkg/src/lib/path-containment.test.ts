import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entryIdentity,
  isSameOrInside,
  isSameOrInsideOnDisk,
} from "./path-containment.ts";

/**
 * One table for every place pkg asks "is this path the folder or inside it".
 * Each row runs against the posix or win32 path module explicitly, so the
 * Windows rows run on every host, not only on the unit-windows CI job.
 */
const rows: Array<{
  name: string;
  path: typeof posix;
  child: string;
  parent: string;
  inside: boolean;
}> = [
  // posix
  {
    name: "same path",
    path: posix,
    child: "/p/src",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "direct child",
    path: posix,
    child: "/p/src/a",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "deep child",
    path: posix,
    child: "/p/src/a/b.ts",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "sibling sharing a prefix",
    path: posix,
    child: "/p/srcx/a",
    parent: "/p/src",
    inside: false,
  },
  {
    name: "parent of the parent",
    path: posix,
    child: "/p",
    parent: "/p/src",
    inside: false,
  },
  {
    name: "root parent /",
    path: posix,
    child: "/p/src",
    parent: "/",
    inside: true,
  },
  {
    name: "root parent / and root child",
    path: posix,
    child: "/",
    parent: "/",
    inside: true,
  },
  {
    name: "parent with trailing slash",
    path: posix,
    child: "/p/src/a",
    parent: "/p/src/",
    inside: true,
  },
  {
    name: "same path, trailing slash on parent",
    path: posix,
    child: "/p/src",
    parent: "/p/src/",
    inside: true,
  },
  {
    name: "same path, trailing slash on child",
    path: posix,
    child: "/p/src/",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "child escaping with ..",
    path: posix,
    child: "/p/src/../secret",
    parent: "/p/src",
    inside: false,
  },
  {
    name: "child returning with ..",
    path: posix,
    child: "/p/x/../src/a",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "parent with .. segment",
    path: posix,
    child: "/p/src/a",
    parent: "/p/x/../src",
    inside: true,
  },
  {
    name: "entry named ..foo inside",
    path: posix,
    child: "/p/src/..foo",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "entry named ... inside",
    path: posix,
    child: "/p/src/...",
    parent: "/p/src",
    inside: true,
  },
  {
    name: "case differs (posix is exact)",
    path: posix,
    child: "/p/SRC/a",
    parent: "/p/src",
    inside: false,
  },
  // win32
  {
    name: "win32 same path",
    path: win32,
    child: "C:\\p\\src",
    parent: "C:\\p\\src",
    inside: true,
  },
  {
    name: "win32 child",
    path: win32,
    child: "C:\\p\\src\\a",
    parent: "C:\\p\\src",
    inside: true,
  },
  {
    name: "win32 sibling sharing a prefix",
    path: win32,
    child: "C:\\p\\srcx",
    parent: "C:\\p\\src",
    inside: false,
  },
  {
    name: "win32 drive root C:\\",
    path: win32,
    child: "C:\\p\\src",
    parent: "C:\\",
    inside: true,
  },
  {
    name: "win32 drive root, same",
    path: win32,
    child: "C:\\",
    parent: "C:\\",
    inside: true,
  },
  {
    name: "win32 trailing separator",
    path: win32,
    child: "C:\\p\\src\\a",
    parent: "C:\\p\\src\\",
    inside: true,
  },
  {
    name: "win32 forward slashes",
    path: win32,
    child: "C:/p/src/a",
    parent: "C:\\p\\src",
    inside: true,
  },
  {
    name: "win32 drive letter case",
    path: win32,
    child: "c:\\p\\src\\a",
    parent: "C:\\p\\src",
    inside: true,
  },
  {
    name: "win32 folder case (case-insensitive)",
    path: win32,
    child: "C:\\P\\SRC\\a",
    parent: "C:\\p\\src",
    inside: true,
  },
  {
    name: "win32 other drive",
    path: win32,
    child: "D:\\p\\src\\a",
    parent: "C:\\p\\src",
    inside: false,
  },
  {
    name: "win32 escaping with ..",
    path: win32,
    child: "C:\\p\\src\\..\\x",
    parent: "C:\\p\\src",
    inside: false,
  },
  {
    name: "win32 UNC share",
    path: win32,
    child: "\\\\srv\\share\\a",
    parent: "\\\\srv\\share",
    inside: true,
  },
  {
    name: "win32 other UNC share",
    path: win32,
    child: "\\\\srv\\other\\a",
    parent: "\\\\srv\\share",
    inside: false,
  },
];

describe("isSameOrInside", () => {
  it.each(rows)("$name", ({ path, child, parent, inside }) => {
    expect(isSameOrInside(child, parent, path)).toBe(inside);
  });

  it("uses the host path module by default", () => {
    const root = process.platform === "win32" ? "C:\\" : "/";
    expect(isSameOrInside(join(root, "a", "b"), root)).toBe(true);
    expect(isSameOrInside(join(root, "ab"), join(root, "a"))).toBe(false);
  });
});

describe("isSameOrInsideOnDisk", () => {
  it("matches another spelling of the parent through its identity", () => {
    const identify = (path: string) =>
      path.toLowerCase().replace(/\/$/, "") === "/p/src" ? "src" : undefined;
    expect(isSameOrInsideOnDisk("/p/src/pages", "/p/SRC", identify)).toBe(true);
    expect(isSameOrInsideOnDisk("/p/dist", "/p/SRC", identify)).toBe(false);
    // No identity function: string comparison only.
    expect(isSameOrInsideOnDisk("/p/src/pages", "/p/SRC", undefined)).toBe(
      false,
    );
  });

  it("follows a symlinked parent to the folder it names", () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-containment-"));
    try {
      mkdirSync(join(dir, "real", "pages"), { recursive: true });
      symlinkSync(join(dir, "real"), join(dir, "link"), "dir");
      // The link itself is its own entry: a recursive rm of the link removes
      // the link, not the folder it points at, so nothing under real/ is
      // inside link/ by identity.
      expect(entryIdentity(join(dir, "link"))).not.toBe(
        entryIdentity(join(dir, "real")),
      );
      expect(
        isSameOrInsideOnDisk(join(dir, "real", "pages"), join(dir, "link")),
      ).toBe(false);
      // A path through the link is inside the link by spelling.
      expect(
        isSameOrInsideOnDisk(join(dir, "link", "pages"), join(dir, "link")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined for a missing entry", () => {
    expect(entryIdentity(join(tmpdir(), "bascik-no-such-entry-xyz"))).toBe(
      undefined,
    );
  });
});

/**
 * Every containment check in pkg goes through this module. A local
 * `x.startsWith(root + sep)` misses a root of `/` or `C:\`, a parent with a
 * trailing separator, `..` segments and Windows case, and the next fix to one
 * copy would miss the others.
 */
describe("no hand-rolled containment checks remain in pkg/src", () => {
  const srcDir = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        files.push(full);
    }
  };
  walk(srcDir);
  const HAND_ROLLED =
    /\.startsWith\(\s*[\w.]+\s*\+\s*(?:sep|path\.sep)\s*\)|\.startsWith\(\s*`\$\{[\w.]+\}\$\{sep\}`\s*\)/;

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has none", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => !/^\s*(?:\*|\/\/)/.test(line))
        .filter(({ line }) => HAND_ROLLED.test(line))
        .map(({ index }) => `${file.slice(srcDir.length)}:${index + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});
