import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUnreadableWatchFolders,
  unreadableWatchFolder,
} from "./watch-permission.ts";

const permissionError = (
  path: string,
  syscall: string,
  code = "EACCES",
): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: permission denied, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });

// `chmod 000` does not stop the owner on Windows, or root anywhere.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

let root: string;
let sub: string;
const created: ReturnType<typeof createUnreadableWatchFolders>[] = [];
const create = (intervalMs?: number) => {
  const folders = createUnreadableWatchFolders(intervalMs);
  created.push(folders);
  return folders;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bascik-watch-permission-"));
  sub = join(root, "sub");
  await mkdir(sub);
  await writeFile(join(root, "page.html"), "<p>Page</p>");
});

afterEach(async () => {
  created.splice(0).forEach((folders) => folders.close());
  await chmod(sub, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("unreadableWatchFolder", () => {
  it("names the folder Linux refused to watch", () => {
    expect(unreadableWatchFolder(permissionError(sub, "watch"))).toBe(sub);
  });

  it("names the folder of an lstat refused inside it", () => {
    expect(
      unreadableWatchFolder(permissionError(join(sub, "inner.html"), "lstat")),
    ).toBe(sub);
  });

  it("accepts EPERM", () => {
    expect(unreadableWatchFolder(permissionError(sub, "watch", "EPERM"))).toBe(
      sub,
    );
  });

  it("ignores other errors, files, missing paths and non-errors", () => {
    expect(
      unreadableWatchFolder(permissionError(sub, "watch", "EMFILE")),
    ).toBeUndefined();
    expect(
      unreadableWatchFolder(permissionError(join(root, "page.html"), "watch")),
    ).toBeUndefined();
    expect(
      unreadableWatchFolder(permissionError(join(root, "gone"), "watch")),
    ).toBeUndefined();
    expect(unreadableWatchFolder(new Error("boom"))).toBeUndefined();
    expect(unreadableWatchFolder(undefined)).toBeUndefined();
    expect(unreadableWatchFolder("EACCES")).toBeUndefined();
  });
});

describe("createUnreadableWatchFolders", () => {
  it("returns false for an error that is not about a folder", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const folders = create();
    expect(folders.handle({ add: vi.fn() }, new Error("boom"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per folder, however many watchers report it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const folders = create();
    const error = permissionError(sub, "watch");
    expect(folders.handle({ add: vi.fn() }, error)).toBe(true);
    expect(folders.handle({ add: vi.fn() }, error)).toBe(true);
    expect(
      folders.handle(
        { add: vi.fn() },
        permissionError(join(sub, "x.html"), "lstat"),
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^\[bascik\] warning: could not read folder ".*sub": EACCES.*Skipping the files in it\./,
    );
  });

  it.skipIf(!canLock)(
    "watches the folder again in every watcher once it is readable",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await chmod(sub, 0o000);
      const folders = create(10);
      const first = { add: vi.fn() };
      const second = { add: vi.fn() };
      folders.handle(first, permissionError(sub, "watch"));
      folders.handle(second, permissionError(sub, "watch"));
      await new Promise((done) => setTimeout(done, 60));
      expect(first.add).not.toHaveBeenCalled();
      await chmod(sub, 0o755);
      await vi.waitFor(() => {
        expect(first.add).toHaveBeenCalledWith(sub);
        expect(second.add).toHaveBeenCalledWith(sub);
      });
      await new Promise((done) => setTimeout(done, 60));
      expect(first.add).toHaveBeenCalledTimes(1);
    },
  );

  it("does not watch again after an lstat error (the watch is still open)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const folders = create(10);
    const watcher = { add: vi.fn() };
    folders.handle(watcher, permissionError(join(sub, "a.html"), "lstat"));
    await new Promise((done) => setTimeout(done, 60));
    expect(watcher.add).not.toHaveBeenCalled();
  });

  it.skipIf(!canLock)(
    "forgets a folder that was removed, and stops on close",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const folders = create(10);
      const watcher = { add: vi.fn() };
      await chmod(sub, 0o000);
      folders.handle(watcher, permissionError(sub, "watch"));
      await rmdir(sub);
      await new Promise((done) => setTimeout(done, 60));
      await mkdir(sub);
      await new Promise((done) => setTimeout(done, 60));
      expect(watcher.add).not.toHaveBeenCalled();
      folders.handle(watcher, permissionError(sub, "watch"));
      folders.close();
      await new Promise((done) => setTimeout(done, 60));
      expect(watcher.add).not.toHaveBeenCalled();
    },
  );
});
