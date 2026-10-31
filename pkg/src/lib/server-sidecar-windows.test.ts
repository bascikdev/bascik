import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: ["components"] },
    generate: { manifest: true },
    isBuild: true,
  },
}));

// Windows answers ENOENT, not ENOTDIR, when Bascik's private folder is a
// regular file: the path component that should be a folder is "not found".
// This file reads the sidecar through a readFile that answers the way
// Windows does, so the unit-windows behavior is checked on every host.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (path: string, ...rest: unknown[]) => {
      try {
        return await (actual.readFile as (...args: unknown[]) => unknown)(
          path,
          ...rest,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${path}'`),
          { code: "ENOENT", errno: -4058, syscall: "open", path },
        );
      }
    }) as typeof actual.readFile,
  };
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverSidecarRegistry } from "./server-sidecar.ts";

describe("loadSidecar where the file system answers like Windows", () => {
  const outDir = () =>
    join(
      tmpdir(),
      `bascik-sidecar-windows-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

  it("refuses a private folder that is a file, naming the path, though the read said ENOENT", async () => {
    serverSidecarRegistry.clear();
    const dir = outDir();
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, ".bascik"), "not a folder");
      const path = join(dir, ".bascik", "server-scripts.json");
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        `[bascik] --server: Failed to load server scripts sidecar from ${path}: ENOTDIR`,
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        `${join(dir, ".bascik")} is a file, not a folder`,
      );
      expect(serverSidecarRegistry.isSidecarPresent()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an output folder that is itself a file", async () => {
    serverSidecarRegistry.clear();
    const dir = outDir();
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "dist"), "not a folder");
      const path = join(dir, "dist", ".bascik", "server-scripts.json");
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        `${join(dir, "dist")} is a file, not a folder`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still treats a sidecar missing from a real private folder as a static release", async () => {
    serverSidecarRegistry.clear();
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      await expect(
        serverSidecarRegistry.loadSidecar(
          join(dir, ".bascik", "server-scripts.json"),
        ),
      ).resolves.toEqual({ present: false, scripts: {} });
      // No private folder at all (a static build): also a static release.
      await rm(join(dir, ".bascik"), { recursive: true });
      await expect(
        serverSidecarRegistry.loadSidecar(
          join(dir, ".bascik", "server-scripts.json"),
        ),
      ).resolves.toEqual({ present: false, scripts: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
