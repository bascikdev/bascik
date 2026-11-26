/**
 * The two memory stores: one in this process's memory, and one JSON file per
 * reader whose changes run one after another.
 */
import { randomUUID } from "node:crypto";
import { isSafeKey } from "../store/conversation.ts";
import { newestFirst, searchMemories } from "./text.ts";
import type { Memory, MemoryStore } from "./types.ts";

function assertReader(reader: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
}

/** Memories in this process's memory: for tests, demos, and a first try. */
export function inMemoryMemories(): MemoryStore {
  const readers = new Map<string, Memory[]>();
  const of = (reader: string): Memory[] =>
    isSafeKey(reader) ? (readers.get(reader) ?? []) : [];
  return {
    async list(reader) {
      return structuredClone([...of(reader)].sort(newestFirst));
    },
    async add(reader, memory) {
      assertReader(reader);
      if (!isSafeKey(memory.id))
        throw new Error("That memory id cannot be stored.");
      const others = of(reader).filter((entry) => entry.id !== memory.id);
      readers.set(reader, [...others, structuredClone(memory)]);
    },
    async remove(reader, id) {
      const own = of(reader);
      const kept = own.filter((entry) => entry.id !== id);
      if (kept.length === own.length) return false;
      readers.set(reader, kept);
      return true;
    },
    async search(reader, query, limit) {
      return structuredClone(searchMemories(of(reader), query, limit));
    },
  };
}

/** An entry in the file is only a memory when it has the shape of one. */
function isMemory(value: unknown): value is Memory {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Memory>;
  return (
    isSafeKey(candidate.id) &&
    typeof candidate.text === "string" &&
    typeof candidate.created === "number" &&
    (candidate.updated === undefined ||
      typeof candidate.updated === "number") &&
    (candidate.conversationId === undefined ||
      typeof candidate.conversationId === "string")
  );
}

/**
 * One JSON file per reader: `<directory>/<reader>.json`, a list of memories.
 * It is a good store for one server; with several, use a database. A write
 * goes to a temporary file first and is renamed into place, so a reader never
 * sees half a list, and the writes for one reader run one after another.
 */
export function fileMemories(directory: string): MemoryStore {
  const modules = Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const fileOf = async (reader: string): Promise<string> => {
    const [, path] = await modules;
    return path.join(directory, `${reader}.json`);
  };
  const read = async (reader: string): Promise<Memory[]> => {
    if (!isSafeKey(reader)) return [];
    const [fs] = await modules;
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(await fileOf(reader), "utf8"),
      );
      return Array.isArray(value) ? value.filter(isMemory) : [];
    } catch {
      return [];
    }
  };
  const write = async (reader: string, memories: Memory[]): Promise<void> => {
    const [fs, path] = await modules;
    const file = await fileOf(reader);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(partial, JSON.stringify(memories));
    await fs.rename(partial, file);
  };
  // A change reads the list, edits it, and writes it back: two at once would
  // lose one, so each reader's changes wait for the one before.
  const queues = new Map<string, Promise<unknown>>();
  const change = <T>(
    reader: string,
    edit: (memories: Memory[]) => { memories: Memory[]; result: T },
  ): Promise<T> => {
    const run = (queues.get(reader) ?? Promise.resolve()).then(async () => {
      const { memories, result } = edit(await read(reader));
      await write(reader, memories);
      return result;
    });
    const tail = run.catch(() => undefined);
    queues.set(reader, tail);
    void tail.then(() => {
      if (queues.get(reader) === tail) queues.delete(reader);
    });
    return run;
  };
  return {
    async list(reader) {
      return (await read(reader)).sort(newestFirst);
    },
    async add(reader, memory) {
      assertReader(reader);
      if (!isSafeKey(memory.id))
        throw new Error("That memory id cannot be stored.");
      await change(reader, (memories) => ({
        memories: [
          ...memories.filter((entry) => entry.id !== memory.id),
          memory,
        ],
        result: undefined,
      }));
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return false;
      return change(reader, (memories) => {
        const kept = memories.filter((entry) => entry.id !== id);
        return { memories: kept, result: kept.length !== memories.length };
      });
    },
    async search(reader, query, limit) {
      return searchMemories(await read(reader), query, limit);
    },
  };
}
