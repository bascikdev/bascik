/**
 * Where conversations are kept. The chat in `app.ts` asks a store for three
 * things and nothing else, so a consumer can put conversations in any
 * database by implementing them. Two stores are here: one in memory, and one
 * JSON file per conversation.
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./model.ts";

export interface Conversation {
  id: string;
  title: string;
  /** Milliseconds since the epoch; the chat sets it each time it saves. */
  updatedAt: number;
  messages: ChatMessage[];
}

/**
 * What the chat needs from a database. A reader is whatever the app's
 * sessions say it is (an anonymous cookie, a signed-in user), and a store
 * never lets one reader see another's conversations.
 *
 * `load` and `save` hand over copies: the chat changes what it loaded and
 * saves it again, and a store that gave out its own object would see those
 * changes before they were saved. Ids and readers come from the request, so
 * a store checks them before it uses one as a key or a path.
 */
export interface ConversationStore {
  /** The reader's conversation with that id, or null when there is none. */
  load(reader: string, id: string): Promise<Conversation | null>;
  /** Create the conversation or replace it. */
  save(reader: string, conversation: Conversation): Promise<void>;
  /** The reader's conversations, newest first by `updatedAt`. */
  list(reader: string): Promise<Conversation[]>;
}

/** A conversation with nothing said yet. */
export const newConversation = (): Conversation => ({
  id: randomUUID(),
  title: "New chat",
  updatedAt: Date.now(),
  messages: [],
});

/**
 * The ids a store accepts for a reader and for a conversation: letters,
 * digits, `_` and `-`, up to 128. It is the one rule that keeps either out
 * of a path (`..`, `/`, `\`, a drive letter, a NUL) and out of a file name
 * that means something else.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeKey = (value: unknown): value is string =>
  typeof value === "string" && SAFE_KEY.test(value);

const newestFirst = (a: Conversation, b: Conversation): number =>
  b.updatedAt - a.updatedAt;

function assertSafe(reader: string, id: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
  if (!isSafeKey(id)) throw new Error("That conversation id cannot be stored.");
}

/** Conversations in this process's memory: for tests, demos, and a first try. */
export function memoryStore(): ConversationStore {
  const readers = new Map<string, Map<string, Conversation>>();
  return {
    async load(reader, id) {
      const found =
        isSafeKey(reader) && isSafeKey(id)
          ? readers.get(reader)?.get(id)
          : undefined;
      return found ? structuredClone(found) : null;
    },
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      let own = readers.get(reader);
      if (!own) readers.set(reader, (own = new Map()));
      own.set(conversation.id, structuredClone(conversation));
    },
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      return [...(readers.get(reader)?.values() ?? [])]
        .map((conversation) => structuredClone(conversation))
        .sort(newestFirst);
    },
  };
}

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
  return {
    load: read,
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      const [fs, path] = await modules;
      const file = await fileOf(reader, conversation.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(partial, JSON.stringify(conversation));
      await fs.rename(partial, file);
    },
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      const [fs, path] = await modules;
      let files: string[];
      try {
        files = await fs.readdir(path.join(directory, reader));
      } catch {
        return [];
      }
      const all = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map((file) => read(reader, file.slice(0, -".json".length))),
      );
      return all
        .filter((entry): entry is Conversation => entry !== null)
        .sort(newestFirst);
    },
  };
}

/** A file in the folder is only a conversation when it has the shape of one. */
function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Conversation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.updatedAt === "number" &&
    Array.isArray(candidate.messages)
  );
}
