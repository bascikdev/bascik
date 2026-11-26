/**
 * The two file stores: one in this process's memory, and one that keeps
 * each upload as a bytes file and a JSON description on disk.
 */
import { randomUUID } from "node:crypto";
import { isSafeKey } from "../store/conversation.ts";
import type { FileMeta, FileStore, StoredFile } from "./types.ts";

function assertSafe(reader: string, id: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
  if (!isSafeKey(id)) throw new Error("That file id cannot be stored.");
}

const copy = (file: StoredFile): StoredFile => ({
  name: file.name,
  mediaType: file.mediaType,
  size: file.size,
  bytes: file.bytes.slice(),
});

/** Files in this process's memory: for tests, demos, and a first try. */
export function inMemoryFiles(): FileStore {
  const readers = new Map<string, Map<string, StoredFile>>();
  return {
    async put(reader, id, file) {
      assertSafe(reader, id);
      let own = readers.get(reader);
      if (!own) readers.set(reader, (own = new Map()));
      own.set(id, copy(file));
    },
    async get(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      const found = readers.get(reader)?.get(id);
      return found ? copy(found) : null;
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      readers.get(reader)?.delete(id);
    },
  };
}

/**
 * Two files per upload under `<directory>/<reader>/`: `<id>.bin` with the
 * bytes and `<id>.json` with the name and type. The name is data in the JSON
 * and never part of a path. Like the conversation file store it suits one
 * server; with several, use object storage.
 */
export function diskFiles(directory: string): FileStore {
  const modules = Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const place = async (reader: string, id: string) => {
    const [, path] = await modules;
    const base = path.join(directory, reader, id);
    return {
      dir: path.dirname(base),
      bin: `${base}.bin`,
      meta: `${base}.json`,
    };
  };
  return {
    async put(reader, id, file) {
      assertSafe(reader, id);
      const [fs] = await modules;
      const where = await place(reader, id);
      await fs.mkdir(where.dir, { recursive: true });
      const meta: FileMeta = {
        name: file.name,
        mediaType: file.mediaType,
        size: file.size,
      };
      // The bytes first, then the description that makes them findable: a
      // file is never half there.
      const partial = `${where.bin}.${randomUUID()}.tmp`;
      await fs.writeFile(partial, file.bytes);
      await fs.rename(partial, where.bin);
      await fs.writeFile(where.meta, JSON.stringify(meta));
    },
    async get(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      const [fs] = await modules;
      const where = await place(reader, id);
      try {
        const meta: unknown = JSON.parse(await fs.readFile(where.meta, "utf8"));
        if (!isMeta(meta)) return null;
        const bytes = new Uint8Array(await fs.readFile(where.bin));
        if (bytes.byteLength !== meta.size) return null;
        return {
          name: meta.name,
          mediaType: meta.mediaType,
          size: meta.size,
          bytes,
        };
      } catch {
        return null;
      }
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      const [fs] = await modules;
      const where = await place(reader, id);
      await Promise.all(
        [where.bin, where.meta].map((file) => fs.rm(file, { force: true })),
      );
    },
  };
}

function isMeta(value: unknown): value is FileMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<FileMeta>;
  return (
    typeof meta.name === "string" &&
    typeof meta.mediaType === "string" &&
    typeof meta.size === "number"
  );
}
