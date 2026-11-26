/**
 * The conversation store that keeps one JSON file per conversation under a
 * folder, written to a temporary file and renamed into place.
 */
import { randomUUID } from "node:crypto";
import { assertSafe, isSafeKey, newestFirst } from "./conversation.ts";
import { isConversation, summaryAtStart } from "./file-format.ts";
import { sharedKeys } from "./save-turns.ts";
import type {
  Conversation,
  ConversationStore,
  ConversationSummary,
} from "./types.ts";

/**
 * One JSON file per conversation: `<directory>/<reader>/<id>.json`. It is a
 * good store for one server; with several, use a database. A write goes to a
 * temporary file first and is renamed into place, so a reader never sees half
 * a conversation.
 */
export function fileStore(directory: string): ConversationStore {
  const modules = Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const fileOf = async (reader: string, id: string): Promise<string> => {
    const [, path] = await modules;
    return path.join(directory, reader, `${id}.json`);
  };
  const read = async (
    reader: string,
    id: string,
  ): Promise<Conversation | null> => {
    if (!isSafeKey(reader) || !isSafeKey(id)) return null;
    const [fs] = await modules;
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(await fileOf(reader, id), "utf8"),
      );
      return isConversation(value) ? value : null;
    } catch {
      return null;
    }
  };
  /**
   * The ids of the reader's conversations, `OPEN_AT_ONCE` at a time. Only
   * regular files count (never a folder, a link, or a pipe), and a caller
   * opens one batch before the next, so a folder that holds more than it
   * should costs time, not every file descriptor.
   */
  const batchesOf = async (reader: string): Promise<string[][]> => {
    if (!isSafeKey(reader)) return [];
    const [fs, path] = await modules;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(directory, reader), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter(isSafeKey);
    const batches: string[][] = [];
    for (let at = 0; at < ids.length; at += OPEN_AT_ONCE) {
      batches.push(ids.slice(at, at + OPEN_AT_ONCE));
    }
    return batches;
  };
  const store: ConversationStore = {
    load: read,
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      const [fs, path] = await modules;
      const file = await fileOf(reader, conversation.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.tmp`;
      // The summary comes first in the file, so `summaries` reads only the
      // start of each file.
      const { id, title, updatedAt, ...rest } = conversation;
      await fs.writeFile(
        partial,
        JSON.stringify({ id, title, updatedAt, ...rest }),
      );
      await fs.rename(partial, file);
    },
    async list(reader) {
      // Every conversation, read whole. The chat does not call this: through
      // `limitConversations` its sidebar and its search start from
      // `summaries`, and read whole only as many as `MAX_LISTED_BYTES` and
      // `MAX_SEARCHED_BYTES` allow, one at a time.
      const all: Conversation[] = [];
      for (const batch of await batchesOf(reader)) {
        for (const entry of await Promise.all(
          batch.map((id) => read(reader, id)),
        )) {
          if (entry !== null) all.push(entry);
        }
      }
      return all.sort(newestFirst);
    },
    async summaries(reader) {
      const [fs] = await modules;
      const head = async (id: string): Promise<ConversationSummary | null> => {
        try {
          const handle = await fs.open(await fileOf(reader, id), "r");
          try {
            const bytes = new Uint8Array(HEAD_BYTES);
            const { bytesRead } = await handle.read(bytes, 0, HEAD_BYTES, 0);
            const found = summaryAtStart(
              new TextDecoder().decode(bytes.subarray(0, bytesRead)),
            );
            if (found) return { ...found, id };
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
        // A file this store did not write: read all of it.
        const whole = await read(reader, id);
        return whole
          ? { id, title: whole.title, updatedAt: whole.updatedAt }
          : null;
      };
      const all: ConversationSummary[] = [];
      for (const batch of await batchesOf(reader)) {
        for (const entry of await Promise.all(batch.map(head))) {
          if (entry !== null) all.push(entry);
        }
      }
      return all.sort(newestFirst);
    },
    async delete(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      const [fs] = await modules;
      await fs.rm(await fileOf(reader, id), { force: true });
    },
  };
  // Two file stores over one folder are one store: their saves take turns.
  sharedKeys.set(
    store,
    modules.then(([, path]) => `file:${path.resolve(directory)}`),
  );
  return store;
}

/** How many of a reader's files `fileStore` opens at once. */
const OPEN_AT_ONCE = 32;
/** How much of a file `fileStore.summaries` reads to find its summary. */
const HEAD_BYTES = 4096;
